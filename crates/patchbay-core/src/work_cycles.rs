//! Durable task boundaries. Empty cycle ids preserve every pre-cycle session identity.
use crate::{
    model::TerminalKind,
    pty::SessionSpec,
    session::{Metadata, Record},
    workspace,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const CYCLE_ENV: &str = "PATCHBAY_WORK_CYCLE";
pub const TASK_ENV: &str = "PATCHBAY_CYCLE_TASK";

/// The cycle and owning worktree captured when a command source is authenticated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub cycle: String,
    pub task: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub project_id: String,
    pub task: Option<String>,
    pub root: PathBuf,
    pub target: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReference {
    pub id: String,
    pub name: String,
    pub conversation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub cycle: String,
    pub next_cycle: String,
    pub completed_ms: u64,
    pub branch: String,
    pub first_request: String,
    pub workspace: Value,
    pub coordination: Value,
    pub artifacts: Vec<Artifact>,
    pub sessions: Vec<SessionReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub path: PathBuf,
    pub text: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleState {
    pub cycle: String,
    pub finishing: Option<Archive>,
    pub history: Vec<Archive>,
}
fn directory() -> Result<PathBuf> {
    #[cfg(test)]
    {
        static DIR: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
            std::env::temp_dir().join(format!("patchbay-cycles-{}", uuid::Uuid::new_v4()))
        });
        Ok(DIR.clone())
    }
    #[cfg(not(test))]
    {
        Ok(workspace::home()?.join("work-cycles"))
    }
}
pub(crate) fn finish_lock(scope: &Scope) -> Result<std::fs::File> {
    let dir = directory()?;
    workspace::private_dir(&dir)?;
    workspace::lock(
        &path(&dir, &scope.project_id, scope.task.as_deref()).with_extension("finish.lock"),
    )
}
fn path(dir: &Path, project: &str, task: Option<&str>) -> PathBuf {
    dir.join(format!(
        "{}.json",
        workspace::session_id(project, task.unwrap_or(""), "cycle")
    ))
}
fn load_at(dir: &Path, project: &str, task: Option<&str>) -> Result<CycleState> {
    match std::fs::read(path(dir, project, task)) {
        Ok(bytes) => {
            Ok(serde_json::from_slice(&bytes)
                .context("Task history is invalid; original retained")?)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CycleState::default()),
        Err(e) => Err(e.into()),
    }
}
/// Read the active cycle and its retained history.
/// # Errors
/// Fails if machine-local history cannot be read.
pub fn read(project: &str, task: Option<&str>) -> Result<CycleState> {
    load_at(&directory()?, project, task)
}
fn update<T>(scope: &Scope, f: impl FnOnce(&mut CycleState) -> Result<T>) -> Result<T> {
    let dir = directory()?;
    workspace::private_dir(&dir)?;
    let path = path(&dir, &scope.project_id, scope.task.as_deref());
    let lock = workspace::lock(&path.with_extension("lock"))?;
    lock.lock()?;
    let mut state = load_at(&dir, &scope.project_id, scope.task.as_deref())?;
    let result = f(&mut state)?;
    workspace::atomic_write(&path, &serde_json::to_vec(&state)?)?;
    Ok(result)
}
#[must_use]
pub fn checkout_task(task: Option<&str>) -> Option<&str> {
    task.filter(|t| *t != crate::planning::MAIN)
}
/// Record the expected cycle when preparing a launch. Preserved through explicit resume.
/// # Errors
/// Fails if this scope is finishing or its history is unreadable.
pub fn prepare(project: &str, task: Option<&str>, spec: &mut SessionSpec) -> Result<()> {
    let task = checkout_task(task);
    let state = read(project, task)?;
    ensure!(
        state.finishing.is_none(),
        "This task is finishing; retry Finish task before starting agents"
    );
    spec.env.entry(CYCLE_ENV.into()).or_insert(state.cycle);
    spec.env
        .entry(TASK_ENV.into())
        .or_insert_with(|| task.unwrap_or("").into());
    Ok(())
}
#[must_use]
pub fn session_id(metadata: &Metadata, spec: &SessionSpec) -> String {
    if metadata.kind == TerminalKind::Agent {
        return agent_session_id(
            &metadata.project_id,
            &metadata.component_id,
            &metadata.terminal_id,
            metadata.task.as_deref(),
            spec.env.get(CYCLE_ENV).map_or("", String::as_str),
        );
    }
    crate::model::task_session_id(
        &metadata.project_id,
        &metadata.component_id,
        &metadata.terminal_id,
        metadata.task.as_deref(),
    )
}
/// Verify under the service launch lock; explicit resumes may keep a finished identity.
/// # Errors
/// Fails for a finishing scope or a stale automatic launch.
pub fn check_launch(metadata: &Metadata, spec: &SessionSpec, explicit_resume: bool) -> Result<()> {
    if metadata.kind != TerminalKind::Agent {
        return Ok(());
    }
    let task = match spec.env.get(TASK_ENV) {
        Some(task) => (!task.is_empty()).then_some(task.as_str()),
        None => checkout_task(metadata.task.as_deref()),
    };
    let state = read(&metadata.project_id, task)?;
    ensure!(
        state.finishing.is_none(),
        "This task is finishing; no agent was started"
    );
    ensure!(
        explicit_resume || spec.env.get(CYCLE_ENV).map_or("", String::as_str) == state.cycle,
        "This task has finished; start an agent in the new task"
    );
    Ok(())
}
#[must_use]
pub fn belongs(record: &Record, scope: &Scope) -> bool {
    let m = &record.metadata;
    if m.project_id != scope.project_id || m.kind != TerminalKind::Agent {
        return false;
    }
    if read(&scope.project_id, scope.task.as_deref())
        .ok()
        .and_then(|s| s.finishing)
        .is_some_and(|a| {
            a.coordination
                .get("runs")
                .and_then(Value::as_array)
                .is_some_and(|runs| {
                    runs.iter().any(|run| {
                        run.get("jobs")
                            .and_then(Value::as_array)
                            .is_some_and(|jobs| {
                                jobs.iter()
                                    .any(|j| j["sessionId"].as_str() == Some(&record.id))
                            })
                            || run
                                .pointer("/coordinator/sessionId")
                                .and_then(Value::as_str)
                                == Some(&record.id)
                    })
                })
        })
    {
        return true;
    }
    if let Some(task) = record.spec.env.get(TASK_ENV) {
        return task.as_str() == scope.task.as_deref().unwrap_or("");
    }
    if record.spec.merge_source.as_deref() == Some(scope.target.as_path()) {
        return true;
    }
    if matches!(
        m.component_id.as_str(),
        crate::model::REVIEW_SCOPE | crate::model::MERGE_SCOPE
    ) {
        return record.spec.cwd == scope.target;
    }
    checkout_task(m.task.as_deref()) == scope.task.as_deref()
}
/// Persist intent under the service operation lock, before waiting on coordination.
/// # Errors
/// Fails for a changed cycle or an unwritable journal.
pub fn begin(scope: &Scope, cycle: &str, workspace: Value) -> Result<CycleState> {
    update(scope, |state| {
        if state.history.iter().any(|a| a.cycle == cycle) {
            return Ok(state.clone());
        }
        ensure!(
            state.cycle == cycle,
            "The active task changed; refresh before finishing"
        );
        if state.finishing.is_none() {
            let first_request = workspace
                .pointer("/simple/log")
                .and_then(Value::as_array)
                .and_then(|log| log.iter().find(|e| e["kind"] == "prompt"))
                .and_then(|e| e["text"].as_str())
                .unwrap_or("Untitled task")
                .to_owned();
            state.finishing = Some(Archive {
                cycle: cycle.into(),
                next_cycle: uuid::Uuid::new_v4().to_string(),
                completed_ms: 0,
                branch: crate::git::run(
                    crate::git::git(&scope.target).args(["branch", "--show-current"]),
                )
                .unwrap_or_default()
                .trim()
                .into(),
                first_request,
                workspace,
                coordination: Value::Null,
                artifacts: vec![],
                sessions: vec![],
            });
        }
        Ok(state.clone())
    })
}
/// Save coordination before removing it from automatic recovery.
/// # Errors
/// Fails if the journal cannot be saved.
pub fn retain_coordination(scope: &Scope, value: Value) -> Result<()> {
    update(scope, |s| {
        s.finishing
            .as_mut()
            .context("No finish in progress")?
            .coordination = value;
        Ok(())
    })
}
fn artifact_paths(scope: &Scope, records: &[Record]) -> Result<Vec<PathBuf>> {
    if crate::git::repo_root(&scope.root).is_none() {
        return Ok(vec![]);
    }
    let plan = crate::plans::plan_file(
        &scope.root,
        crate::planning::artifact_task(scope.task.as_deref()),
    )?;
    let mut paths = vec![
        plan.clone(),
        plan.with_extension("proposal.json"),
        plan.with_extension("assignments.json"),
        plan.with_extension("presented.json"),
    ];
    if scope.task.is_none() {
        // Legacy shared plans belong to the initial main-worktree cycle.
        let legacy = crate::plans::plan_file(&scope.root, None)?;
        paths.extend([
            legacy.clone(),
            legacy.with_extension("proposal.json"),
            legacy.with_extension("assignments.json"),
            legacy.with_extension("presented.json"),
        ]);
    }
    let mut branches: Vec<String> = records
        .iter()
        .filter(|r| belongs(r, scope))
        .filter_map(|r| r.metadata.branch.clone())
        .collect();
    if let Some(pending) = read(&scope.project_id, scope.task.as_deref())?.finishing
        && !pending.branch.is_empty()
    {
        branches.push(pending.branch);
    }
    branches.sort();
    branches.dedup();
    for branch in branches {
        paths.extend(crate::reviews::branch_artifacts(&scope.root, &branch)?);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}
/// Capture stopped sessions and artifacts durably before removing active artifacts.
/// # Errors
/// Fails if a session still runs or an artifact cannot be read or removed. Intent survives retries.
pub fn complete(scope: &Scope, records: &[Record]) -> Result<CycleState> {
    ensure!(
        !records
            .iter()
            .any(|r| belongs(r, scope) && r.snapshot.as_ref().is_some_and(|s| s.running)),
        "Some task agents are still running; retry Finish task"
    );
    let state = update(scope, |s| {
        let archive = s.finishing.as_mut().context("No finish in progress")?;
        if archive.completed_ms == 0 {
            let records: Vec<_> = records
                .iter()
                .filter(|r| {
                    belongs(r, scope)
                        && r.spec.env.get(CYCLE_ENV).map_or("", String::as_str) == archive.cycle
                })
                .cloned()
                .collect();
            archive.sessions = records
                .iter()
                .map(|r| SessionReference {
                    id: r.id.clone(),
                    name: r.metadata.name.clone(),
                    conversation_id: r.metadata.conversation_id.clone().or_else(|| {
                        r.snapshot
                            .as_ref()?
                            .status
                            .agent
                            .as_ref()?
                            .conversation_id
                            .clone()
                    }),
                })
                .collect();
            for path in artifact_paths(scope, &records)? {
                match std::fs::read_to_string(&path) {
                    Ok(text) => archive.artifacts.push(Artifact { path, text }),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            archive.completed_ms = crate::orchestration::now_ms();
        }
        Ok(s.clone())
    })?;
    for artifact in &state.finishing.context("No finish in progress")?.artifacts {
        match std::fs::remove_file(&artifact.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    update(scope, |s| {
        let mut archive = s.finishing.take().context("No finish in progress")?;
        archive.completed_ms = crate::orchestration::now_ms();
        s.cycle.clone_from(&archive.next_cycle);
        s.history.insert(0, archive);
        Ok(s.clone())
    })
}

/// Resolve the source worktree of review/merge jobs, whose legacy metadata has no task id.
#[must_use]
pub fn session_task(metadata: &Metadata, spec: &SessionSpec) -> Option<String> {
    if let Some(task) = spec.env.get(TASK_ENV) {
        return (!task.is_empty()).then(|| task.clone());
    }
    if let Some(task) = checkout_task(metadata.task.as_deref()) {
        return Some(task.into());
    }
    let target = spec.merge_source.as_deref().unwrap_or(&spec.cwd);
    crate::tasks::list(Path::new(&metadata.project_root))
        .unwrap_or_default()
        .into_iter()
        .find(|t| Path::new(&t.worktree) == target)
        .map(|t| t.id)
}
/// Whether the retained session belongs to task history, including legacy session identities.
#[must_use]
pub fn archived(record: &Record) -> bool {
    if record.archived {
        return true;
    }
    let task = session_task(&record.metadata, &record.spec);
    read(&record.metadata.project_id, task.as_deref()).is_ok_and(|s| {
        s.history
            .iter()
            .any(|a| a.sessions.iter().any(|r| r.id == record.id))
    })
}

/// Refuse coordination changes in a worktree with a durable finish intent.
/// # Errors
/// Fails if history is unreadable or cleanup is pending.
pub fn ensure_available(project: &str, task: Option<&str>) -> Result<()> {
    ensure!(
        read(project, checkout_task(task))?.finishing.is_none(),
        "This task is finishing; retry Finish task"
    );
    Ok(())
}

/// Serialize authenticated commands with final cleanup, without holding the service launch lock.
/// # Errors
/// Fails if the private lock cannot be opened.
pub fn command_lock(project: &str, task: Option<&str>) -> Result<std::fs::File> {
    let dir = directory()?;
    workspace::private_dir(&dir)?;
    workspace::lock(&path(&dir, project, checkout_task(task)).with_extension("commands.lock"))
}

/// The cycle-qualified identity of an agent; an empty cycle preserves legacy sessions.
#[must_use]
pub fn agent_session_id(
    project: &str,
    component: &str,
    terminal: &str,
    task: Option<&str>,
    cycle: &str,
) -> String {
    let terminal = if cycle.is_empty() {
        terminal.to_owned()
    } else {
        format!("{terminal}\u{1e}cycle:{cycle}")
    };
    crate::model::task_session_id(project, component, &terminal, task)
}

const ARCHIVE_OUTPUT_ENV: &str = "PATCHBAY_ARCHIVED_OUTPUT";
fn resume_dir(id: &str) -> Result<PathBuf> {
    Ok(directory()?
        .join("outputs")
        .join(workspace::session_id(id, "archive", "outputs")))
}
/// Private output directory already assigned to this archived session.
#[must_use]
pub fn existing_resume_dir(id: &str) -> Option<PathBuf> {
    resume_dir(id).ok()?.canonicalize().ok()
}

/// Isolate archived plan/review output while preserving the recorded conversation identity.
/// # Errors
/// Fails if archival outputs or the independent briefing cannot be retained.
pub(crate) fn isolate_resume(
    id: &str,
    spec: &mut SessionSpec,
    launch: &mut String,
    backup: Option<&str>,
) -> Result<()> {
    let dir = resume_dir(id)?;
    workspace::private_dir(&dir)?;
    if spec
        .env
        .get(ARCHIVE_OUTPUT_ENV)
        .is_some_and(|old| Path::new(old) == dir)
    {
        return crate::context::restore_briefing(spec, backup);
    }
    let mut replacements = vec![];
    for (key, name) in [
        (crate::plans::PLAN_FILE_ENV, "plan.md"),
        (crate::reviews::REVIEW_FILE_ENV, "review.md"),
    ] {
        if let Some(old) = spec.env.get(key) {
            let target = dir.join(name);
            replacements.push((old.clone(), target.display().to_string()));
            if let Some(parent) = Path::new(old).parent() {
                replacements.push((parent.display().to_string(), dir.display().to_string()));
            }
        }
    }
    let rewrite = |text: &str| {
        let mut text = text.to_owned();
        for (old, new) in &replacements {
            let escaped_old = serde_json::to_string(old).unwrap();
            let escaped_new = serde_json::to_string(new).unwrap();
            text = text
                .replace(
                    &escaped_old[1..escaped_old.len() - 1],
                    &escaped_new[1..escaped_new.len() - 1],
                )
                .replace(old, new);
        }
        text
    };
    spec.command = rewrite(&spec.command);
    if let Some(command) = &mut spec.resume_command {
        *command = rewrite(command);
    }
    *launch = rewrite(launch);
    for value in spec.env.values_mut() {
        *value = rewrite(value);
    }
    for path in &mut spec.dirs {
        *path = PathBuf::from(rewrite(&path.to_string_lossy()));
    }
    if !spec.dirs.contains(&dir) {
        spec.dirs.push(dir.clone());
    }
    if let Some(old) = spec.env.get(crate::context::CONTEXT_ENV).cloned() {
        let text = backup
            .map(str::to_owned)
            .or_else(|| crate::context::briefing_backup(spec))
            .context("Archived briefing unavailable")?;
        let text = format!(
            "{}\n\nArchived conversation: this agent runs against the worktree's current files and remains separate from its active task. Write plan/review output only to the archived paths in this environment.\n",
            rewrite(&text)
        );
        let file =
            crate::context::context_file(&format!("archive-{}", uuid::Uuid::new_v4()), &text)?;
        let old_name = Path::new(&old)
            .file_name()
            .context("Missing briefing filename")?
            .to_string_lossy();
        let new_name = file.file_name().unwrap().to_string_lossy();
        spec.command = spec.command.replace(old_name.as_ref(), new_name.as_ref());
        if let Some(command) = &mut spec.resume_command {
            *command = command.replace(old_name.as_ref(), new_name.as_ref());
        }
        *launch = launch.replace(old_name.as_ref(), new_name.as_ref());
        for value in spec.env.values_mut() {
            *value = value.replace(old_name.as_ref(), new_name.as_ref());
        }
        spec.env.insert(
            crate::context::CONTEXT_ENV.into(),
            file.display().to_string(),
        );
        spec.owns_briefing = true;
    }
    spec.env
        .insert(ARCHIVE_OUTPUT_ENV.into(), dir.display().to_string());
    spec.notice = Some("Archived conversation — runs against current files; remains separate from the active task.".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> Scope {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        Scope {
            project_id: uuid::Uuid::new_v4().to_string(),
            task: None,
            root: dir.clone(),
            target: dir,
        }
    }
    fn record(scope: &Scope, kind: &str, task: Option<&str>, running: bool) -> Record {
        serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "metadata": { "projectId":scope.project_id, "projectName":"P", "projectRoot":scope.root,
                "componentId":"web", "terminalId":"agent", "task":task, "name":"Agent", "kind":kind,
                "conversationId":"provider-conversation" },
            "spec": { "id":"s", "command":"agent", "cwd":scope.root, "env":{}, "ready_when":"", "service":false, "dirs":[] },
            "snapshot": { "data":"", "end":0, "generation":1, "running":running, "startedMs":1, "status":crate::status::SessionStatus::default() },
            "history":[], "interrupted":false, "requestIds":[]
        })).unwrap()
    }
    #[test]
    fn legacy_identity_is_unchanged_and_shells_ignore_the_cycle() {
        // Pinned in apps/desktop/src/lib/workCycles.test.ts too.
        assert_eq!(
            agent_session_id("p", "@task", "agent", None, "second"),
            "s-eca87c9e0cd6c3f9cdcd15b5f12de4a4"
        );
        let scope = scope();
        let mut r = record(&scope, "agent", None, false);
        assert_eq!(
            session_id(&r.metadata, &r.spec),
            crate::model::task_session_id(&scope.project_id, "web", "agent", None)
        );
        let initial = session_id(&r.metadata, &r.spec);
        r.spec.env.insert(CYCLE_ENV.into(), "next".into());
        assert_ne!(session_id(&r.metadata, &r.spec), initial);
        r.metadata.kind = TerminalKind::Shell;
        assert_eq!(session_id(&r.metadata, &r.spec), initial);
    }
    #[test]
    fn failed_stop_keeps_workspace_and_durable_intent_until_retry() {
        let scope = scope();
        let workspace = serde_json::json!({"simple":{"log":[{"kind":"prompt","text":"Build a thing"}]},"auto":{"status":"running"}});
        let before = begin(&scope, "", workspace.clone()).unwrap();
        let mut r = record(&scope, "agent", None, true);
        assert!(complete(&scope, &[r.clone()]).is_err());
        let restored = read(&scope.project_id, None).unwrap();
        assert_eq!(restored.cycle, "");
        assert!(restored.history.is_empty());
        assert_eq!(restored.finishing.as_ref().unwrap().workspace, workspace);
        assert!(check_launch(&r.metadata, &r.spec, false).is_err());
        assert!(check_launch(&r.metadata, &r.spec, true).is_err());
        let retried = begin(&scope, "", Value::Null).unwrap();
        assert_eq!(
            retried.finishing.unwrap().next_cycle,
            before.finishing.unwrap().next_cycle
        );
        r.snapshot.as_mut().unwrap().running = false;
        let finished = complete(&scope, &[r.clone()]).unwrap();
        assert!(!finished.cycle.is_empty());
        assert!(finished.finishing.is_none());
        assert_eq!(finished.history[0].first_request, "Build a thing");
        assert_eq!(
            finished.history[0].sessions[0].conversation_id.as_deref(),
            Some("provider-conversation")
        );
        assert!(check_launch(&r.metadata, &r.spec, false).is_err());
        assert!(check_launch(&r.metadata, &r.spec, true).is_ok());
        assert!(archived(&r));
        // A lost completion reply cannot finish the next cycle when the old request is retried.
        assert_eq!(begin(&scope, "", Value::Null).unwrap().history.len(), 1);
        assert_eq!(read(&scope.project_id, None).unwrap().history.len(), 1);
        let _ = std::fs::remove_dir_all(scope.root);
    }
    #[test]
    fn stop_scope_includes_all_agent_roles_and_excludes_other_worktrees_and_shells() {
        let scope = scope();
        for component in [
            "@task",
            "@worker",
            "@coordinator",
            "@scan",
            "@plan",
            "@review",
            "@merge",
            "web",
        ] {
            let mut r = record(&scope, "agent", None, false);
            r.metadata.component_id = component.into();
            assert!(belongs(&r, &scope), "{component}");
            r.metadata.project_id = "another-project".into();
            assert!(!belongs(&r, &scope));
        }
        assert!(!belongs(&record(&scope, "shell", None, true), &scope));
        assert!(!belongs(
            &record(&scope, "agent", Some("other-tree"), true),
            &scope
        ));
        let _ = std::fs::remove_dir_all(scope.root);
    }
    #[test]
    fn cleanup_resumes_after_artifacts_were_captured_and_partly_removed() {
        let scope = scope();
        crate::git::run(crate::git::git(&scope.root).args(["init", "-q"])).unwrap();
        let plan = crate::plans::plan_file(&scope.root, Some(crate::planning::MAIN)).unwrap();
        workspace::atomic_write(&plan, b"A saved plan").unwrap();
        begin(&scope, "", Value::Null).unwrap();
        // Simulate restart after durable capture and the first file removal.
        update(&scope, |s| {
            let a = s.finishing.as_mut().unwrap();
            a.completed_ms = 123;
            a.artifacts.push(Artifact {
                path: plan.clone(),
                text: "A saved plan".into(),
            });
            Ok(())
        })
        .unwrap();
        std::fs::remove_file(&plan).unwrap();
        let finished = complete(&scope, &[]).unwrap();
        assert_eq!(finished.history[0].artifacts[0].text, "A saved plan");
        assert!(!plan.exists());
        assert!(
            crate::plans::read(&scope.root, Some(crate::planning::MAIN))
                .unwrap()
                .text
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(scope.root);
    }
    #[test]
    fn finishing_removes_failed_review_sidecars_without_session_records() {
        let scope = scope();
        crate::git::run(crate::git::git(&scope.root).args(["init", "-q", "-b", "feature"]))
            .unwrap();
        let findings = crate::reviews::file(&scope.root, "feature").unwrap();
        let attempt = serde_json::json!({"branch":"feature", "head":"old", "base":"main", "mergeBase":"old", "startedMs":1, "attempt":"orphan", "round":"orphan", "launchError":"Connection lost"});
        workspace::atomic_write(
            &findings.with_extension("json"),
            &serde_json::to_vec(&attempt).unwrap(),
        )
        .unwrap();
        assert!(crate::reviews::read(&scope.root, "feature").is_some());
        begin(&scope, "", Value::Null).unwrap();
        let completed = complete(&scope, &[]).unwrap();
        assert!(crate::reviews::read(&scope.root, "feature").is_none());
        assert!(
            completed.history[0].artifacts.iter().any(|a| a
                .path
                .extension()
                .is_some_and(|e| e == "json")
                && a.text.contains("Connection lost"))
        );
        let _ = std::fs::remove_dir_all(scope.root);
    }

    #[test]
    fn resumed_archived_review_writes_separately_from_a_fresh_review_of_the_same_lane() {
        let scope = scope();
        crate::git::run(crate::git::git(&scope.root).args(["init", "-q", "-b", "feature"]))
            .unwrap();
        let active = crate::reviews::file(&scope.root, "feature").unwrap();
        let attempt = serde_json::json!({"branch":"feature", "head":"current", "base":"main", "mergeBase":"current", "startedMs":1, "attempt":"fresh", "round":"fresh"});
        workspace::atomic_write(
            &active.with_extension("json"),
            &serde_json::to_vec(&attempt).unwrap(),
        )
        .unwrap();
        workspace::atomic_write(&active, b"Verdict: clean\nActive new review").unwrap();
        let current = crate::reviews::read(&scope.root, "feature").unwrap().text;
        let old_text = format!("Write findings to {}", active.display());
        let old_context =
            crate::context::context_file(&format!("review-{}", uuid::Uuid::new_v4()), &old_text)
                .unwrap();
        let mut spec = record(&scope, "agent", None, false).spec;
        spec.command = format!(
            "claude --add-dir '{}' --append-system-prompt '{}'",
            active.parent().unwrap().display(),
            old_context.display()
        );
        spec.resume_command = Some(spec.command.clone());
        spec.env.insert(
            crate::reviews::REVIEW_FILE_ENV.into(),
            active.display().to_string(),
        );
        spec.env.insert(
            crate::context::CONTEXT_ENV.into(),
            old_context.display().to_string(),
        );
        spec.env.insert(
            "PATCHBAY_ARGUMENT_0".into(),
            format!("Write {}", active.display()),
        );
        spec.dirs.push(active.parent().unwrap().into());
        let mut launch = spec.command.clone();
        isolate_resume("archived-review", &mut spec, &mut launch, Some(&old_text)).unwrap();
        let archived_file = PathBuf::from(&spec.env[crate::reviews::REVIEW_FILE_ENV]);
        assert_ne!(archived_file, active);
        workspace::atomic_write(&archived_file, b"Verdict: issues\nArchived follow-up").unwrap();
        assert_eq!(
            crate::reviews::read(&scope.root, "feature").unwrap().text,
            current
        );
        assert!(!spec.dirs.contains(&active.parent().unwrap().to_path_buf()));
        assert!(!spec.env["PATCHBAY_ARGUMENT_0"].contains(&active.display().to_string()));
        assert!(!launch.contains(&old_context.display().to_string()));
        assert_eq!(std::fs::read_to_string(&old_context).unwrap(), old_text);
        let backup = crate::context::briefing_backup(&spec).unwrap();
        assert!(backup.contains(&archived_file.display().to_string()));
        let before = spec.command.clone();
        let context = PathBuf::from(&spec.env[crate::context::CONTEXT_ENV]);
        std::fs::remove_file(&context).unwrap();
        isolate_resume("archived-review", &mut spec, &mut launch, Some(&backup)).unwrap();
        assert_eq!(spec.command, before);
        assert_eq!(std::fs::read_to_string(context).unwrap(), backup);
        let _ = std::fs::remove_dir_all(scope.root);
    }
}
