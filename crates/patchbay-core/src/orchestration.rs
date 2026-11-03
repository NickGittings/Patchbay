//! Persistent scan findings and coordinated implementation. Stored beside tasks, never in source.
//! Launch identities are persisted before spawning; integrations record intent before touching Git.
use crate::agent_bridge::{LaunchContext, Role, new_id};
use crate::context::{self, ContextSection};
use crate::git::{git, run};
use crate::model::{COORDINATOR_SCOPE, Project, SCAN_SCOPE, TerminalSpec, WORKER_SCOPE};
use crate::{policy::AllowAll, pty::SessionSpec, session::Record, tasks};
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Scan,
    Implementation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Running,
    Paused,
    Stopped,
    Complete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Pending,
    Launching,
    Running,
    Complete,
    Failed,
    Integrating,
    Integrated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanReport {
    pub references: Vec<String>,
    pub findings: String,
    pub uncertainties: String,
    pub suggested_work: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub preset: String,
    pub terminal: TerminalSpec,
    pub state: JobState,
    pub request_id: String,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub report: Option<ScanReport>,
    pub instructions: String,
    pub components: Vec<String>,
    pub dependencies: Vec<String>,
    pub task: Option<String>,
    pub base: Option<String>,
    pub commit: Option<String>,
    pub summary: Option<String>,
    pub integration_base: Option<String>,
    pub integrated_head: Option<String>,
    #[serde(default)]
    pub observed_working: bool,
    #[serde(default)]
    pub launched_ms: u64,
}
impl Job {
    fn new(terminal: TerminalSpec) -> Self {
        let preset = terminal.id.clone();
        Self {
            id: new_id(),
            preset,
            terminal,
            state: JobState::Pending,
            request_id: new_id(),
            session_id: None,
            error: None,
            report: None,
            instructions: String::new(),
            components: vec![],
            dependencies: vec![],
            task: None,
            base: None,
            commit: None,
            summary: None,
            integration_base: None,
            integrated_head: None,
            observed_working: false,
            launched_ms: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub project_id: String,
    pub task: Option<String>,
    pub kind: Kind,
    pub state: State,
    pub goal: String,
    pub components: Vec<String>,
    pub target: String,
    pub branch: String,
    pub source_revision: String,
    #[serde(default)]
    pub source_roots: Vec<String>,
    pub integrated_head: String,
    pub jobs: Vec<Job>,
    pub coordinator: Option<Job>,
    pub workers: Vec<TerminalSpec>,
    pub sealed: bool,
    pub accepted_partial: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    /// Client-generated identity makes creation safe after a lost reply.
    pub id: String,
    pub kind: Kind,
    pub goal: String,
    #[serde(default)]
    pub components: Vec<String>,
    pub task: Option<String>,
    pub presets: Vec<TerminalSpec>,
    pub coordinator: Option<TerminalSpec>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentDraft {
    pub id: String,
    pub instructions: String,
    pub components: Vec<String>,
    pub dependencies: Vec<String>,
    pub preset: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Inspect,
    SubmitScan { report: ScanReport },
    CreateAssignments { assignments: Vec<AssignmentDraft> },
    SealAssignments,
    SubmitWorker { summary: String, commit: String },
    Integrate { assignment: String },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Control {
    Pause,
    Resume,
    Stop,
    Retry { job: String },
    ContinueScan,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    runs: Vec<Run>,
}
fn file(root: &Path) -> Result<PathBuf> {
    Ok(tasks::store_dir(root)?.join("orchestration.json"))
}
fn load(root: &Path) -> Result<Store> {
    match std::fs::read(file(root)?) {
        Ok(bytes) => {
            let mut store: Store = serde_json::from_slice(&bytes)?;
            for r in &mut store.runs {
                for j in &mut r.jobs {
                    if j.state == JobState::Integrated
                        || matches!(r.state, State::Complete | State::Stopped)
                    {
                        continue;
                    }
                    let journal =
                        tasks::store_dir(root)?.join(format!("integration-{}-{}.json", r.id, j.id));
                    if let Ok(bytes) = std::fs::read(journal) {
                        let intent: Job = serde_json::from_slice(&bytes)?;
                        j.state = JobState::Integrating;
                        j.integration_base = intent.integration_base;
                        r.state = State::Paused;
                    }
                }
            }
            Ok(store)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}
fn save(root: &Path, store: &Store) -> Result<()> {
    crate::workspace::atomic_write(&file(root)?, &serde_json::to_vec_pretty(store)?)
}
fn modify<T>(root: &Path, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut store = load(root)?;
    let before = serde_json::to_vec(&store)?;
    let result = f(&mut store);
    // Failures (notably merge conflicts) also have durable state; unchanged polls do no I/O.
    if before != serde_json::to_vec(&store)? {
        save(root, &store)?;
    }
    result
}
fn get<'a>(store: &'a mut Store, id: &str) -> Result<&'a mut Run> {
    store
        .runs
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| anyhow!("Unknown provider run"))
}
fn head(root: &Path) -> Result<String> {
    run(git(root).args(["rev-parse", "HEAD"]))
}
fn branch(root: &Path) -> Result<String> {
    run(git(root).args(["symbolic-ref", "--short", "HEAD"]))
}
fn clean(root: &Path) -> Result<()> {
    ensure!(
        run(git(root).args(["status", "--porcelain", "--untracked-files=all"]))?.is_empty(),
        "Coordinated implementation requires a clean target; commit or move your changes first"
    );
    ensure!(
        !git(root)
            .args(["rev-parse", "--verify", "MERGE_HEAD"])
            .output()?
            .status
            .success(),
        "Resolve the target's merge first"
    );
    Ok(())
}
fn ancestor(root: &Path, a: &str, b: &str) -> Result<bool> {
    Ok(git(root)
        .args(["merge-base", "--is-ancestor", a, b])
        .output()?
        .status
        .success())
}
/// Includes local edits and untracked contents: a report of the same HEAD can still be stale.
fn revision(root: &Path) -> Result<String> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    head(root)?.hash(&mut hash);
    branch(root)?.hash(&mut hash);
    let diff = git(root).args(["diff", "HEAD", "--binary"]).output()?;
    ensure!(diff.status.success(), "Cannot fingerprint source changes");
    diff.stdout.hash(&mut hash);
    let files = git(root)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()?;
    ensure!(files.status.success(), "Cannot fingerprint untracked files");
    for name in files.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        name.hash(&mut hash);
        let path = root.join(std::str::from_utf8(name)?);
        let is_symlink = std::fs::symlink_metadata(&path)?.file_type().is_symlink();
        is_symlink.hash(&mut hash);
        if is_symlink {
            std::fs::read_link(path)?.hash(&mut hash);
        } else {
            std::fs::read(path)?.hash(&mut hash);
        }
    }
    Ok(format!("{:016x}", hash.finish()))
}
fn source_revision(r: &Run) -> Result<String> {
    if r.source_roots.is_empty() {
        return revision(target(r)?);
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    for root in &r.source_roots {
        root.hash(&mut hash);
        revision(Path::new(root))?.hash(&mut hash);
    }
    Ok(format!("{:016x}", hash.finish()))
}
fn target_project(project: &Project, task: Option<&str>, components: &[String]) -> Result<Project> {
    task.map_or_else(
        || Ok(project.clone()),
        |id| {
            tasks::project_in(
                project,
                &tasks::find(Path::new(&project.root), id)?,
                components,
            )
            .map(|(p, _)| p)
        },
    )
}
fn target(run: &Run) -> Result<&Path> {
    let root = Path::new(&run.target);
    ensure!(
        branch(root)? == run.branch,
        "The run's target branch changed"
    );
    Ok(root)
}
fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 80
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Invalid run or assignment id"
    );
    Ok(())
}
/// Create an optional scan round or an implementation run after plan acceptance.
pub fn create(project: &Project, project_id: &str, draft: Draft) -> Result<Run> {
    valid_id(&draft.id)?;
    ensure!(!draft.goal.trim().is_empty(), "Describe the goal first");
    ensure!(!draft.presets.is_empty(), "Choose agent presets");
    for terminal in draft.presets.iter().chain(draft.coordinator.iter()) {
        ensure!(
            terminal.kind == crate::TerminalKind::Agent && !terminal.command.trim().is_empty(),
            "Choose agent presets"
        );
    }
    for id in &draft.components {
        ensure!(project.component(id).is_some(), "Unknown component {id}");
    }
    let mut components = if draft.kind == Kind::Implementation && draft.components.is_empty() {
        project.components.iter().map(|c| c.id.clone()).collect()
    } else {
        draft.components.clone()
    };
    components.sort();
    components.dedup();
    let mapped = target_project(project, draft.task.as_deref(), &components)?;
    let root = Path::new(&mapped.root);
    // A project rooted in a subfolder still uses the complete worktree for Git checks.
    let root = crate::git::repo_root(root)
        .ok_or_else(|| anyhow!("Provider runs need a Git repository"))?;
    modify(Path::new(&project.root), |store| {
        if let Some(existing) = store.runs.iter().find(|r| r.id == draft.id) {
            ensure!(
                existing.project_id == project_id
                    && existing.task == draft.task
                    && existing.kind == draft.kind
                    && existing.goal == draft.goal
                    && existing.components == components,
                "Run identity belongs to different inputs"
            );
            return Ok(existing.clone());
        }
        ensure!(
            !store.runs.iter().any(|r| r.project_id == project_id
                && r.kind == draft.kind
                && r.task == draft.task
                && matches!(r.state, State::Running | State::Paused)),
            "An unfinished provider run already exists in this task"
        );
        if draft.kind == Kind::Implementation {
            clean(&root)?;
            ensure!(
                draft.coordinator.is_some(),
                "Choose an implementation coordinator"
            );
        }
        let mut source_roots = vec![root.display().to_string()];
        for c in mapped
            .components
            .iter()
            .filter(|c| components.is_empty() || components.contains(&c.id))
        {
            if let Some(repo) = crate::git::repo_root(&mapped.component_dir(c)) {
                ensure!(
                    draft.kind != Kind::Implementation || repo == root,
                    "Coordinated implementation requires components in the target repository"
                );
                let repo = repo.display().to_string();
                if !source_roots.contains(&repo) {
                    source_roots.push(repo);
                }
            }
        }
        let mut run = Run {
            id: draft.id,
            project_id: project_id.into(),
            task: draft.task,
            kind: draft.kind,
            state: State::Running,
            goal: draft.goal,
            components,
            target: root.display().to_string(),
            branch: branch(&root)?,
            source_revision: String::new(),
            source_roots,
            integrated_head: head(&root)?,
            jobs: if draft.kind == Kind::Scan {
                draft.presets.iter().cloned().map(Job::new).collect()
            } else {
                vec![]
            },
            coordinator: draft.coordinator.map(Job::new),
            workers: if draft.kind == Kind::Implementation {
                draft.presets
            } else {
                vec![]
            },
            sealed: false,
            accepted_partial: false,
            error: None,
        };
        run.source_revision = source_revision(&run)?;
        store.runs.push(run.clone());
        Ok(run)
    })
}
/// All records are retained, including stopped runs and worker worktrees.
pub fn list(root: &Path, project_id: &str) -> Result<Vec<Run>> {
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(load(root)?
        .runs
        .into_iter()
        .filter(|r| r.project_id == project_id)
        .collect())
}
pub fn read(root: &Path, project_id: &str, id: &str) -> Result<Run> {
    list(root, project_id)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| anyhow!("Unknown provider run"))
}
/// Validation and review of a target wait for its complete implementation assignment list.
pub fn ensure_integrated(root: &Path, project_id: &str, worktree: &Path) -> Result<()> {
    let worktree = crate::git::repo_root(worktree).unwrap_or_else(|| worktree.to_path_buf());
    // Projects outside Git have no provider runs.
    if crate::git::repo_root(root).is_none() {
        return Ok(());
    }
    for r in list(root, project_id)? {
        if r.kind == Kind::Implementation
            && Path::new(&r.target) == worktree
            && r.state != State::Stopped
        {
            ensure!(
                r.sealed
                    && !r.jobs.is_empty()
                    && r.jobs.iter().all(|j| j.state == JobState::Integrated),
                "All implementation assignments must be integrated before validation or review"
            );
        }
    }
    Ok(())
}

fn finished(run: &mut Run) {
    if run.kind == Kind::Scan {
        if run.jobs.iter().all(|j| j.report.is_some()) {
            run.state = State::Complete;
            run.error = None;
        }
    } else if run.sealed
        && !run.jobs.is_empty()
        && run.jobs.iter().all(|j| j.state == JobState::Integrated)
    {
        run.state = State::Complete;
        run.error = None;
        if let Some(coordinator) = &mut run.coordinator {
            coordinator.state = JobState::Complete;
        }
    }
}
/// Reconcile only known launch request IDs. Explicit submissions, never process exit, finish jobs.
/// Restored runs pause before new work can start; existing sessions and reports remain attached.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

pub fn reconcile(
    root: &Path,
    project_id: &str,
    records: &[Record],
    restoring: bool,
) -> Result<Vec<Run>> {
    reconcile_at(root, project_id, records, restoring, now_ms())
}
/// `sampled_ms` is captured before listing sessions; snapshots cannot judge later launches.
pub fn reconcile_at(
    root: &Path,
    project_id: &str,
    records: &[Record],
    restoring: bool,
    sampled_ms: u64,
) -> Result<Vec<Run>> {
    modify(root, |store| {
        for r in store.runs.iter_mut().filter(|r| r.project_id == project_id) {
            if restoring && r.state == State::Running {
                r.state = State::Paused;
                r.error = Some("Restored after restart — Resume to continue".into());
            }
            if matches!(r.state, State::Complete | State::Stopped) {
                continue;
            }
            for j in r.jobs.iter_mut().chain(r.coordinator.iter_mut()) {
                if !matches!(j.state, JobState::Launching | JobState::Running)
                    && !(j.state == JobState::Pending && j.session_id.is_some())
                {
                    continue;
                }
                if j.launched_ms > sampled_ms {
                    continue;
                }
                if let Some(record) = records.iter().find(|record| {
                    record.metadata.project_id == project_id
                        && record.request_ids.contains(&j.request_id)
                }) {
                    j.session_id = Some(record.id.clone());
                    let agent = record
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.status.agent.as_ref());
                    if agent.is_some_and(|a| {
                        a.authoritative
                            && matches!(
                                a.state,
                                crate::status::AgentState::Working
                                    | crate::status::AgentState::NeedsInput
                            )
                    }) {
                        j.observed_working = true;
                    }
                    let idle = agent.is_some_and(|a| {
                        a.authoritative
                            && (matches!(
                                a.state,
                                crate::status::AgentState::Review
                                    | crate::status::AgentState::Ended
                            ) || (a.state == crate::status::AgentState::Idle
                                && j.observed_working))
                    });
                    if record
                        .snapshot
                        .as_ref()
                        .is_some_and(|s| !s.running || s.status.stopped)
                        || idle
                    {
                        j.state = JobState::Failed;
                        j.error = Some("Agent finished without the required submission".into());
                        r.state = State::Paused;
                        r.error.clone_from(&j.error);
                    } else {
                        j.state = JobState::Running;
                        j.error = None;
                    }
                } else if restoring
                    || j.error.is_some()
                    || (j.state == JobState::Running
                        && sampled_ms.saturating_sub(j.launched_ms) > 5000)
                {
                    j.state = if j.state == JobState::Running {
                        JobState::Failed
                    } else {
                        JobState::Launching
                    };
                    j.error.get_or_insert_with(|| {
                        "Launch could not be reconciled; Retry to continue".into()
                    });
                    r.state = State::Paused;
                    r.error.clone_from(&j.error);
                }
            }
            finished(r);
        }
        Ok(store
            .runs
            .iter()
            .filter(|r| r.project_id == project_id)
            .cloned()
            .collect())
    })
}
/// Manual controls do not delete artifacts or reset a worker's preserved checkout.
pub fn control(root: &Path, project_id: &str, id: &str, control: Control) -> Result<Run> {
    modify(root, |store| {
        let r = get(store, id)?;
        ensure!(r.project_id == project_id, "Run belongs to another project");
        if r.state == State::Stopped && matches!(control, Control::Stop) {
            return Ok(r.clone());
        }
        ensure!(r.state != State::Stopped, "This run was stopped");
        match control {
            Control::Pause => {
                if r.state != State::Complete {
                    r.state = State::Paused;
                }
            }
            Control::Stop => {
                if r.state != State::Complete {
                    r.state = State::Stopped;
                }
            }
            Control::Resume => {
                if r.state == State::Complete {
                    return Ok(r.clone());
                }
                target(r)?;
                ensure!(
                    !r.jobs
                        .iter()
                        .chain(r.coordinator.iter())
                        .any(|j| j.state == JobState::Failed),
                    "Retry failed assignments or continue with available scan findings"
                );
                r.state = State::Running;
                r.error = None;
                finished(r);
            }
            Control::ContinueScan => {
                ensure!(
                    r.kind == Kind::Scan && r.jobs.iter().any(|j| j.report.is_some()),
                    "No completed scan reports are available"
                );
                ensure!(
                    source_revision(r)? == r.source_revision,
                    "Scan reports are stale; start a new round"
                );
                r.accepted_partial = true;
                r.state = State::Complete;
                r.error = None;
            }
            Control::Retry { job } => {
                ensure!(r.state != State::Complete, "Run is complete");
                if r.kind == Kind::Scan {
                    ensure!(
                        source_revision(r)? == r.source_revision,
                        "Scan reports are stale; start a new round"
                    );
                }
                let j = r
                    .jobs
                    .iter_mut()
                    .chain(r.coordinator.iter_mut())
                    .find(|j| j.id == job)
                    .ok_or_else(|| anyhow!("Unknown job"))?;
                ensure!(
                    matches!(j.state, JobState::Failed | JobState::Launching),
                    "Only failed or unconfirmed jobs may be retried"
                );
                if j.state != JobState::Launching {
                    j.request_id = new_id();
                    j.session_id = None;
                }
                j.state = JobState::Pending;
                j.error = None;
                j.observed_working = false;
                r.state = if r
                    .jobs
                    .iter()
                    .chain(r.coordinator.iter())
                    .any(|j| j.state == JobState::Failed)
                {
                    State::Paused
                } else {
                    State::Running
                };
                r.error = None;
            }
        }
        Ok(r.clone())
    })
}
/// Complete reports for exactly the goal, scope and revision that scanners investigated.
pub fn planner_section(
    root: &Path,
    project_id: &str,
    id: &str,
    goal: &str,
    components: &[String],
) -> Result<ContextSection> {
    let r = read(root, project_id, id)?;
    let mut scope = components.to_vec();
    scope.sort();
    scope.dedup();
    ensure!(
        r.kind == Kind::Scan && r.state == State::Complete,
        "Finish scans or choose Continue with available findings"
    );
    ensure!(
        r.goal == goal && r.components == scope && source_revision(&r)? == r.source_revision,
        "Scan reports are stale: goal, scope or source changed"
    );
    Ok(ContextSection {
        title: "Scan findings".into(),
        body: format!(
            "Goal: {}\nSource revision: {}\nSource checkout: {}\nSource branch: {}\nSource HEAD: {}\nCode references are relative to the source checkout; investigate there when resolving disagreements. Reports are independent investigations, not review verdicts.\n{}",
            r.goal,
            r.source_revision,
            r.target,
            r.branch,
            r.integrated_head,
            r.jobs
                .iter()
                .filter_map(|j| j.report.as_ref().map(|report| format!(
                    "\n### {} ({})\n{}",
                    j.terminal.name,
                    j.preset,
                    serde_json::to_string_pretty(report).unwrap()
                )))
                .collect::<String>()
        ),
    })
}
fn authorize(run: &Run, launch: &LaunchContext) -> Result<()> {
    ensure!(
        run.project_id == launch.project_id && run.state != State::Stopped,
        "Run is unavailable to this session"
    );
    Ok(())
}
/// Agent commands derive the owning run from the authenticated session, never caller input.
pub fn command(root: &Path, launch: &LaunchContext, command: Command) -> Result<Run> {
    modify(root, |store| {
        let r = store
            .runs
            .iter_mut()
            .find(|r| {
                r.coordinator
                    .iter()
                    .chain(r.jobs.iter())
                    .any(|j| j.session_id.as_deref() == Some(&launch.agent_session))
            })
            .ok_or_else(|| anyhow!("Session does not own a provider run"))?;
        authorize(r, launch)?;
        let coordinator = launch.role == Role::Coordinator
            && r.coordinator
                .as_ref()
                .is_some_and(|j| j.session_id.as_deref() == Some(&launch.agent_session));
        match command {
            Command::Inspect => {}
            Command::SubmitScan { report } => {
                ensure!(
                    launch.role == Role::Scanner && r.kind == Kind::Scan,
                    "Only a scanner can submit a scan report"
                );
                ensure!(
                    !report.findings.trim().is_empty(),
                    "Report findings are empty"
                );
                ensure!(
                    source_revision(r)? == r.source_revision,
                    "Source changed; scan report is stale"
                );
                let completed = r.state == State::Complete;
                let j = r
                    .jobs
                    .iter_mut()
                    .find(|j| j.session_id.as_deref() == Some(&launch.agent_session))
                    .ok_or_else(|| anyhow!("Scanner does not own this report"))?;
                ensure!(
                    !completed || j.report.is_some(),
                    "This scan round has already been handed off"
                );
                if let Some(previous) = &j.report {
                    ensure!(previous == &report, "Report already submitted");
                }
                j.report = Some(report);
                j.state = JobState::Complete;
                j.error = None;
                finished(r);
            }
            Command::CreateAssignments { assignments } => {
                ensure!(
                    coordinator && r.state == State::Running && !r.sealed,
                    "Only the active coordinator can create assignments before sealing"
                );
                let previous = r.jobs.clone();
                let result = add_assignments(r, assignments);
                if result.is_err() {
                    r.jobs = previous;
                }
                result?;
            }
            Command::SealAssignments => {
                ensure!(
                    coordinator && !r.jobs.is_empty(),
                    "Only the coordinator can seal a nonempty assignment list"
                );
                r.sealed = true;
                finished(r);
            }
            Command::SubmitWorker { summary, commit } => {
                ensure!(
                    launch.role == Role::Worker && !summary.trim().is_empty(),
                    "Workers must submit a completion summary"
                );
                let j = r
                    .jobs
                    .iter_mut()
                    .find(|j| j.session_id.as_deref() == Some(&launch.agent_session))
                    .ok_or_else(|| anyhow!("Worker does not own this assignment"))?;
                let task = tasks::find(
                    root,
                    j.task
                        .as_deref()
                        .ok_or_else(|| anyhow!("Worker has no checkout"))?,
                )?;
                let tree = Path::new(&task.worktree);
                clean(tree)?;
                ensure!(
                    commit == head(tree)? && commit.chars().all(|c| c.is_ascii_hexdigit()),
                    "Submit the worker checkout's committed HEAD"
                );
                let base = j
                    .base
                    .as_deref()
                    .ok_or_else(|| anyhow!("Worker has no base revision"))?;
                ensure!(
                    commit != base && ancestor(tree, base, &commit)?,
                    "Worker result must contain commits based on its assigned revision"
                );
                ensure!(
                    matches!(
                        j.state,
                        JobState::Running | JobState::Failed | JobState::Complete
                    ),
                    "Assignment is already integrating or integrated"
                );
                j.commit = Some(commit);
                j.summary = Some(summary);
                j.state = JobState::Complete;
                j.error = None;
            }
            Command::Integrate { assignment } => {
                ensure!(
                    coordinator,
                    "Only the owning coordinator can integrate assignments"
                );
                integrate(r, &assignment)?;
            }
        }
        Ok(r.clone())
    })
}
fn add_assignments(r: &mut Run, drafts: Vec<AssignmentDraft>) -> Result<()> {
    for mut draft in drafts {
        valid_id(&draft.id)?;
        ensure!(
            !draft.instructions.trim().is_empty(),
            "Assignment instructions are empty"
        );
        // Empty means the selected run scope, not every component in the project map.
        // Normalize before comparing a retried assignment to its persisted form.
        if draft.components.is_empty() {
            draft.components.clone_from(&r.components);
        }
        ensure!(
            draft.components.iter().all(|id| r.components.contains(id)),
            "Assignment is outside the run scope"
        );
        let terminal = r
            .workers
            .iter()
            .find(|t| t.id == draft.preset)
            .ok_or_else(|| anyhow!("Worker preset was not selected for this run"))?
            .clone();
        if let Some(j) = r.jobs.iter().find(|j| j.id == draft.id) {
            ensure!(
                j.instructions == draft.instructions
                    && j.components == draft.components
                    && j.dependencies == draft.dependencies
                    && j.preset == draft.preset,
                "Assignment id already has different instructions"
            );
            continue;
        }
        let mut j = Job::new(terminal);
        j.id = draft.id;
        j.instructions = draft.instructions;
        j.components = draft.components;
        j.dependencies = draft.dependencies;
        r.jobs.push(j);
    }
    fn visit(
        id: &str,
        jobs: &[Job],
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
    ) -> Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        ensure!(
            visiting.insert(id.into()),
            "Assignment dependencies contain a cycle"
        );
        let j = jobs
            .iter()
            .find(|j| j.id == id)
            .ok_or_else(|| anyhow!("Unknown assignment dependency {id}"))?;
        for dep in &j.dependencies {
            visit(dep, jobs, visiting, done)?;
        }
        visiting.remove(id);
        done.insert(id.into());
        Ok(())
    }
    let mut done = HashSet::new();
    for j in &r.jobs {
        visit(&j.id, &r.jobs, &mut HashSet::new(), &mut done)?;
    }
    Ok(())
}
fn integrate(r: &mut Run, id: &str) -> Result<()> {
    let tree = target(r)?.to_path_buf();
    let index = r
        .jobs
        .iter()
        .position(|j| j.id == id)
        .ok_or_else(|| anyhow!("Unknown assignment"))?;
    let j = &r.jobs[index];
    if j.state == JobState::Integrated {
        return Ok(());
    }
    ensure!(
        matches!(j.state, JobState::Complete | JobState::Integrating),
        "Worker must submit a committed result first"
    );
    ensure!(
        j.dependencies.iter().all(|id| r
            .jobs
            .iter()
            .any(|j| &j.id == id && j.state == JobState::Integrated)),
        "Dependencies are not integrated"
    );
    let commit = j
        .commit
        .clone()
        .ok_or_else(|| anyhow!("Worker has no committed result"))?;
    // The intent was saved before merge: adopt a merge completed before a lost reply or crash.
    if j.state == JobState::Integrating && ancestor(&tree, &commit, "HEAD")? {
        clean(&tree)?;
    } else {
        clean(&tree)?;
        ensure!(
            head(&tree)? == r.integrated_head,
            "Target changed outside this run; inspect it before continuing"
        );
        ensure!(
            !r.jobs
                .iter()
                .enumerate()
                .any(|(i, j)| i != index && j.state == JobState::Integrating),
            "Resolve the current integration first"
        );
        r.jobs[index].state = JobState::Integrating;
        r.jobs[index].integration_base = Some(r.integrated_head.clone());
        // Persisting the whole store happens in command before this function is called again;
        // an independent journal makes the Git operation recoverable even on process termination.
        let journal = tasks::store_dir(&tree)?.join(format!("integration-{}-{}.json", r.id, id));
        crate::workspace::atomic_write(&journal, &serde_json::to_vec(&r.jobs[index])?)?;
        if let Err(error) = run(git(&tree).args(["merge", "--no-ff", "--no-edit", &commit])) {
            r.state = State::Paused;
            r.error = Some(format!(
                "Integration conflict in {id}: {error}. Resolve and commit in the target, then integrate again."
            ));
            r.jobs[index].error.clone_from(&r.error);
            return Err(error);
        }
    }
    let integrated = head(&tree)?;
    r.jobs[index].state = JobState::Integrated;
    r.jobs[index].integrated_head = Some(integrated.clone());
    r.jobs[index].error = None;
    r.integrated_head = integrated;
    finished(r);
    Ok(())
}
/// A launch prepared in core, with immutable identity and a role-specific briefing.
pub struct Launch {
    pub project: Project,
    pub terminal: TerminalSpec,
    pub scope: &'static str,
    pub task: Option<String>,
    pub spec: SessionSpec,
    pub request_id: String,
}
/// Prepare and persist one ready job; the caller launches it via the existing session service.
/// `dispatch` must reconcile a lost launch reply using the persisted request id.
pub fn launch(
    root: &Path,
    project_id: &str,
    id: &str,
    job_id: &str,
    project: &Project,
    dispatch: impl FnOnce(Launch) -> Result<String>,
) -> Result<Run> {
    let mut preparing = false;
    let result = modify(root, |store| {
        let r = get(store, id)?;
        ensure!(
            r.project_id == project_id && r.state == State::Running,
            "Provider run is paused or unavailable"
        );
        let is_coordinator = r.coordinator.as_ref().is_some_and(|j| j.id == job_id);
        let index = r.jobs.iter().position(|j| j.id == job_id);
        let j = if is_coordinator {
            r.coordinator.as_ref().unwrap()
        } else {
            &r.jobs[index.ok_or_else(|| anyhow!("Unknown job"))?]
        };
        // A retry of the same launch request is idempotent in the service.
        ensure!(
            matches!(j.state, JobState::Pending | JobState::Launching),
            "Job already launched"
        );
        ensure!(
            j.dependencies.iter().all(|dep| r
                .jobs
                .iter()
                .any(|j| &j.id == dep && j.state == JobState::Integrated)),
            "Dependencies are not integrated"
        );
        preparing = true;
        target(r)?;
        if r.kind == Kind::Scan {
            ensure!(
                source_revision(r)? == r.source_revision,
                "Source changed; start a new scan round"
            );
        }
        let scope = if is_coordinator {
            COORDINATOR_SCOPE
        } else if r.kind == Kind::Scan {
            SCAN_SCOPE
        } else {
            WORKER_SCOPE
        };
        let mut mapped = target_project(project, r.task.as_deref(), &r.components)?;
        let task = if scope == WORKER_SCOPE {
            clean(target(r)?)?;
            ensure!(
                head(target(r)?)? == r.integrated_head,
                "Target changed outside this run"
            );
            let j = &mut r.jobs[index.unwrap()];
            if j.task.is_none() {
                // Adopt an already-created worktree after a crash between Git and saving the run.
                let worker_branch = format!("patchbay/worker/{}/{}", r.id, j.id);
                let task = tasks::list(root)?
                    .into_iter()
                    .find(|t| t.branch.as_deref() == Some(&worker_branch))
                    .map(Ok)
                    .unwrap_or_else(|| {
                        tasks::create(
                            root,
                            tasks::TaskDraft {
                                title: format!(
                                    "Worker: {}",
                                    j.instructions.lines().next().unwrap_or(&j.id)
                                ),
                                branch: worker_branch,
                                base: Some(r.integrated_head.clone()),
                                components: j.components.clone(),
                            },
                        )
                    })?;
                j.base = task.base;
                j.task = Some(task.id);
            }
            mapped = target_project(project, j.task.as_deref(), &j.components)?;
            j.task.clone()
        } else {
            r.task.clone()
        };
        let j = if is_coordinator {
            r.coordinator.as_mut().unwrap()
        } else {
            &mut r.jobs[index.unwrap()]
        };
        let mut terminal = j.terminal.clone();
        terminal.id = j.request_id.clone();
        let body = match scope {
            SCAN_SCOPE => {
                "Investigate the goal and selected component scope without changing code or Git state. Submit an explicit report using: $PATCHBAY_CLI agent scan-report --file report.json. JSON fields: references (array of file:line strings), findings, uncertainties, suggestedWork (strings). A final reply alone does not complete a scan. Write temporary report JSON outside the source tree."
            }
            COORDINATOR_SCOPE => {
                "Coordinate implementation of the approved shared plan using only the selected workers. On restart inspect the existing assignments first; preserve and continue them rather than creating duplicates. Do not use provider-native subagents. Create assignments with $PATCHBAY_CLI agent assignments-create --file assignments.json (array of {id,instructions,components,dependencies,preset}). IDs must be unique ASCII letters/digits/hyphens; dependencies refer to assignment IDs. Independent jobs launch concurrently; dependencies launch only after integration. Seal the list using agent assignments-seal. Poll agent assignments to inspect progress. Workers use isolated worktrees. Integrate completed assignments SERIALly with agent assignment-integrate <id>. Resolve any conflicts in this target checkout, commit, then repeat integration. Do not finish until all assignments are integrated. Never delete worker worktrees or branches. Validation and review run only afterward."
            }
            _ => {
                "Implement ONLY your assignment in this isolated task worktree. Do not use provider-native subagents. Run relevant checks, commit your changes, leave the worktree clean, then submit $PATCHBAY_CLI agent worker-result --commit <HEAD-sha> --summary <completion-summary>. Do not merge into the target, modify other worker checkouts, or delete worktrees. A final reply alone does not complete this assignment."
            }
        };
        let scope_ids = if scope == WORKER_SCOPE {
            &j.components
        } else {
            &r.components
        };
        let map_context = format!(
            "# Patchbay provider context\n\nProject: {}\nRoot: {}\nSelected components (paths relative to root):\n{}\nDependencies:\n{}",
            mapped.name,
            mapped.root,
            serde_json::to_string_pretty(
                &mapped
                    .components
                    .iter()
                    .filter(|c| scope_ids.is_empty() || scope_ids.contains(&c.id))
                    .collect::<Vec<_>>()
            )?,
            serde_json::to_string_pretty(&mapped.links)?
        );
        let text = format!(
            "{}\n\n## Provider run\nRun: {}\nGoal: {}\nComponents: {}\n{}\n\nAssignment: {}\nInstructions: {}\nSelected worker presets: {}\nShared plan:\n{}",
            map_context,
            r.id,
            r.goal,
            scope_ids.join(", "),
            body,
            j.id,
            j.instructions,
            r.workers
                .iter()
                .map(|w| w.id.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            crate::plans::read(root, r.task.as_deref())
                .map(|p| p.text)
                .unwrap_or_default()
        );
        let spec = context::job_agent_spec(
            &mapped,
            &terminal,
            &text,
            vec![],
            scope,
            "Carry out the Provider run instructions in your Patchbay briefing and submit the required results using Patchbay agent commands.",
            BTreeMap::from([
                ("PATCHBAY_RUN_ID".into(), r.id.clone()),
                ("PATCHBAY_ASSIGNMENT_ID".into(), j.id.clone()),
            ]),
            &AllowAll,
        )?;
        j.session_id = Some(crate::model::task_session_id(
            project_id,
            scope,
            &terminal.id,
            task.as_deref(),
        ));
        j.state = JobState::Launching;
        j.launched_ms = now_ms();
        let launch = Launch {
            project: mapped,
            terminal,
            scope,
            task,
            spec,
            request_id: j.request_id.clone(),
        };
        // Commit identity before the provider can issue an authenticated command.
        save(root, store)?;
        let result = dispatch(launch);
        let r = get(store, id)?;
        let j = if is_coordinator {
            r.coordinator.as_mut().unwrap()
        } else {
            &mut r.jobs[index.unwrap()]
        };
        match result {
            Ok(sid) => {
                j.session_id = Some(sid);
                j.state = JobState::Running;
            }
            Err(error) => {
                j.error = Some(error.to_string());
                r.error = Some(format!(
                    "Launch unconfirmed: {error}. Reconcile before retrying."
                ));
            }
        }
        Ok(r.clone())
    });
    if let Err(error) = &result
        && preparing
    {
        let _ = modify(root, |store| {
            let r = get(store, id)?;
            let j = r
                .jobs
                .iter_mut()
                .chain(r.coordinator.iter_mut())
                .find(|j| j.id == job_id);
            if let Some(j) = j
                && j.state == JobState::Pending
            {
                j.state = JobState::Failed;
                j.error = Some(error.to_string());
                r.state = State::Paused;
                r.error = Some(error.to_string());
            }
            Ok(())
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TerminalKind;

    struct Fixture {
        dir: PathBuf,
        root: PathBuf,
        project: Project,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-providers-{}", new_id()));
            let root = dir.join("repo");
            std::fs::create_dir_all(&root).unwrap();
            run(git(&root).args(["init", "-b", "main"])).unwrap();
            run(git(&root).args(["config", "user.email", "test@example.invalid"])).unwrap();
            run(git(&root).args(["config", "user.name", "Test"])).unwrap();
            std::fs::write(root.join("shared.txt"), "base\n").unwrap();
            run(git(&root).args(["add", "."])).unwrap();
            run(git(&root).args(["commit", "-m", "Initial"])).unwrap();
            let root = root.canonicalize().unwrap();
            let project = Project {
                name: "test".into(),
                root: root.display().to_string(),
                components: vec![],
                links: vec![],
                groups: vec![],
                schema_version: 4,
            };
            Self { dir, root, project }
        }
        fn create(&self, kind: Kind) -> Run {
            create(
                &self.project,
                "p",
                Draft {
                    id: new_id(),
                    kind,
                    goal: "goal".into(),
                    components: vec![],
                    task: None,
                    presets: vec![terminal("claude"), terminal("codex")],
                    coordinator: (kind == Kind::Implementation).then(|| terminal("claude")),
                },
            )
            .unwrap()
        }
        fn launch(&self, r: &Run, job: &str) -> Run {
            launch(&self.root, "p", &r.id, job, &self.project, |l| {
                // Real service derives the same metadata identity and retains a briefing copy.
                let id =
                    crate::model::task_session_id("p", l.scope, &l.terminal.id, l.task.as_deref());
                if let Some(file) = context::owned_briefing(&l.spec) {
                    context::remove_owned_briefing_file(&file);
                }
                Ok(id)
            })
            .unwrap()
        }
        fn coordinator(&self, r: &Run) -> (Run, LaunchContext) {
            let r = self.launch(r, &r.coordinator.as_ref().unwrap().id);
            let launch = auth(&r, r.coordinator.as_ref().unwrap(), Role::Coordinator);
            (r, launch)
        }
        fn assignments(&self, r: &Run, launch: &LaunchContext, dependencies: Vec<String>) -> Run {
            command(
                &self.root,
                launch,
                Command::CreateAssignments {
                    assignments: vec![assignment("a", vec![]), assignment("b", dependencies)],
                },
            )
            .unwrap();
            command(&self.root, launch, Command::SealAssignments).unwrap();
            read(&self.root, "p", &r.id).unwrap()
        }
        fn complete_worker(&self, r: &Run, job: &str, file: &str, contents: &str) -> Run {
            let r = self.launch(r, job);
            let j = r.jobs.iter().find(|j| j.id == job).unwrap();
            let task = tasks::find(&self.root, j.task.as_deref().unwrap()).unwrap();
            let tree = Path::new(&task.worktree);
            std::fs::write(tree.join(file), contents).unwrap();
            run(git(tree).args(["add", file])).unwrap();
            run(git(tree).args(["commit", "-m", job])).unwrap();
            command(
                &self.root,
                &auth(&r, j, Role::Worker),
                Command::SubmitWorker {
                    summary: format!("Implemented {job}"),
                    commit: head(tree).unwrap(),
                },
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn terminal(id: &str) -> TerminalSpec {
        serde_json::from_value(serde_json::json!({"id":id, "name":id, "kind":"agent", "command":"echo fake", "adapter":null})).unwrap()
    }
    fn auth(r: &Run, j: &Job, role: Role) -> LaunchContext {
        LaunchContext {
            project_id: r.project_id.clone(),
            task: j.task.clone().or_else(|| r.task.clone()),
            agent_session: j.session_id.clone().unwrap(),
            role,
        }
    }
    fn report() -> ScanReport {
        ScanReport {
            references: vec!["shared.txt:1".into()],
            findings: "Finding".into(),
            uncertainties: "Unknown".into(),
            suggested_work: "Suggested change".into(),
        }
    }
    fn assignment(id: &str, dependencies: Vec<String>) -> AssignmentDraft {
        AssignmentDraft {
            id: id.into(),
            instructions: format!("Implement {id}"),
            components: vec![],
            dependencies,
            preset: if id == "a" { "claude" } else { "codex" }.into(),
        }
    }

    #[test]
    fn reports_require_an_owning_scanner_and_explicit_submission() {
        let f = Fixture::new();
        let r = f.create(Kind::Scan);
        let r = f.launch(&r, &r.jobs[0].id);
        let scanner = auth(&r, &r.jobs[0], Role::Scanner);
        let mut wrong = scanner.clone();
        wrong.role = Role::Worker;
        assert!(command(&f.root, &wrong, Command::SubmitScan { report: report() }).is_err());
        wrong.role = Role::Scanner;
        wrong.project_id = "other".into();
        assert!(command(&f.root, &wrong, Command::SubmitScan { report: report() }).is_err());
        let r = command(&f.root, &scanner, Command::SubmitScan { report: report() }).unwrap();
        assert_eq!(r.state, State::Running);
        let r = f.launch(&r, &r.jobs[1].id);
        let scanner = auth(&r, &r.jobs[1], Role::Scanner);
        let r = command(&f.root, &scanner, Command::SubmitScan { report: report() }).unwrap();
        assert_eq!(r.state, State::Complete);
        let section = planner_section(&f.root, "p", &r.id, "goal", &[]).unwrap();
        assert!(section.body.contains("claude") && section.body.contains("codex"));
        assert!(planner_section(&f.root, "p", &r.id, "different goal", &[]).is_err());
        assert!(planner_section(&f.root, "p", &r.id, "goal", &["other".into()]).is_err());
    }
    #[test]
    fn reports_are_invalidated_by_edits_untracked_contents_and_new_revisions() {
        let f = Fixture::new();
        std::fs::write(f.root.join("untracked.txt"), "first").unwrap();
        let r = f.create(Kind::Scan);
        let r = f.launch(&r, &r.jobs[0].id);
        let scanner = auth(&r, &r.jobs[0], Role::Scanner);
        command(&f.root, &scanner, Command::SubmitScan { report: report() }).unwrap();
        control(&f.root, "p", &r.id, Control::ContinueScan).unwrap();
        std::fs::write(f.root.join("untracked.txt"), "second").unwrap();
        assert!(planner_section(&f.root, "p", &r.id, "goal", &[]).is_err());
        std::fs::write(f.root.join("untracked.txt"), "first").unwrap();
        assert!(planner_section(&f.root, "p", &r.id, "goal", &[]).is_ok());
        std::fs::write(f.root.join("shared.txt"), "edited").unwrap();
        assert!(planner_section(&f.root, "p", &r.id, "goal", &[]).is_err());
        run(git(&f.root).args(["add", "."])).unwrap();
        run(git(&f.root).args(["commit", "-m", "edit"])).unwrap();
        assert!(planner_section(&f.root, "p", &r.id, "goal", &[]).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn scans_fingerprint_untracked_symlink_targets_without_following_them() {
        use std::os::unix::fs::symlink;

        let f = Fixture::new();
        let directory = f.dir.join("external");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("file"), "first").unwrap();
        symlink(&directory, f.root.join("directory-link")).unwrap();
        let dangling = f.root.join("dangling-link");
        symlink("missing", &dangling).unwrap();
        symlink("shared.txt", f.root.join("file-link")).unwrap();
        let r = f.create(Kind::Scan);
        assert_eq!(source_revision(&r).unwrap(), r.source_revision);

        // Changes outside the checkout are not part of the scan's source.
        std::fs::write(directory.join("file"), "second").unwrap();
        assert_eq!(source_revision(&r).unwrap(), r.source_revision);
        std::fs::remove_file(&dangling).unwrap();
        symlink("another-missing-target", &dangling).unwrap();
        assert_ne!(source_revision(&r).unwrap(), r.source_revision);

        std::fs::remove_file(&dangling).unwrap();
        symlink("missing", &dangling).unwrap();
        assert_eq!(source_revision(&r).unwrap(), r.source_revision);
        std::fs::remove_file(&dangling).unwrap();
        std::fs::write(&dangling, "missing").unwrap();
        assert_ne!(source_revision(&r).unwrap(), r.source_revision);
    }
    #[test]
    fn partial_scan_failure_preserves_success_and_requires_an_explicit_choice() {
        let f = Fixture::new();
        let r = f.create(Kind::Scan);
        let r = f.launch(&r, &r.jobs[0].id);
        command(
            &f.root,
            &auth(&r, &r.jobs[0], Role::Scanner),
            Command::SubmitScan { report: report() },
        )
        .unwrap();
        let r = f.launch(&r, &r.jobs[1].id);
        let runs = reconcile(&f.root, "p", &[], true).unwrap();
        assert_eq!(runs[0].state, State::Paused);
        assert!(runs[0].jobs[0].report.is_some());
        assert!(control(&f.root, "p", &r.id, Control::Resume).is_err());
        let r = control(&f.root, "p", &r.id, Control::ContinueScan).unwrap();
        assert_eq!(r.state, State::Complete);
        assert!(r.accepted_partial);
    }
    #[test]
    fn dependency_validation_is_atomic_and_rejects_cycles_missing_ids_and_wrong_presets() {
        let f = Fixture::new();
        let r = f.create(Kind::Implementation);
        let (r, launch) = f.coordinator(&r);
        for drafts in [
            vec![assignment("a", vec!["missing".into()])],
            vec![
                assignment("a", vec!["b".into()]),
                assignment("b", vec!["a".into()]),
            ],
        ] {
            assert!(
                command(
                    &f.root,
                    &launch,
                    Command::CreateAssignments {
                        assignments: drafts
                    }
                )
                .is_err()
            );
            assert!(read(&f.root, "p", &r.id).unwrap().jobs.is_empty());
        }
        let mut bad = assignment("a", vec![]);
        bad.preset = "unselected".into();
        assert!(
            command(
                &f.root,
                &launch,
                Command::CreateAssignments {
                    assignments: vec![bad]
                }
            )
            .is_err()
        );
        let mut bad = assignment("a", vec![]);
        bad.components = vec!["outside".into()];
        assert!(
            command(
                &f.root,
                &launch,
                Command::CreateAssignments {
                    assignments: vec![bad]
                }
            )
            .is_err()
        );
    }
    #[test]
    fn empty_assignment_scope_inherits_run_scope_in_worker_task_and_briefing() {
        let mut f = Fixture::new();
        f.project.components = ["selected", "unrelated"]
            .into_iter()
            .map(|id| {
                serde_json::from_value(serde_json::json!({"id": id, "name": id, "path": "."}))
                    .unwrap()
            })
            .collect();
        let r = create(
            &f.project,
            "p",
            Draft {
                id: new_id(),
                kind: Kind::Implementation,
                goal: "goal".into(),
                components: vec!["selected".into()],
                task: None,
                presets: vec![terminal("claude")],
                coordinator: Some(terminal("codex")),
            },
        )
        .unwrap();
        let (r, coordinator) = f.coordinator(&r);
        for _ in 0..2 {
            let updated = command(
                &f.root,
                &coordinator,
                Command::CreateAssignments {
                    assignments: vec![assignment("a", vec![])],
                },
            )
            .unwrap();
            assert_eq!(updated.jobs.len(), 1);
            assert_eq!(updated.jobs[0].components, ["selected"]);
        }
        let r = launch(&f.root, "p", &r.id, "a", &f.project, |l| {
            let file = context::owned_briefing(&l.spec).unwrap();
            let briefing = std::fs::read_to_string(&file).unwrap();
            assert!(briefing.contains("selected"));
            assert!(!briefing.contains("unrelated"));
            context::remove_owned_briefing_file(&file);
            Ok(crate::model::task_session_id(
                "p",
                l.scope,
                &l.terminal.id,
                l.task.as_deref(),
            ))
        })
        .unwrap();
        let task = tasks::find(&f.root, r.jobs[0].task.as_deref().unwrap()).unwrap();
        assert_eq!(task.components, ["selected"]);
    }
    #[test]
    fn implementation_requires_a_clean_target_before_creation_and_worker_launch() {
        let f = Fixture::new();
        std::fs::write(f.root.join("dirty"), "dirty").unwrap();
        let draft = Draft {
            id: new_id(),
            kind: Kind::Implementation,
            goal: "goal".into(),
            components: vec![],
            task: None,
            presets: vec![terminal("claude")],
            coordinator: Some(terminal("codex")),
        };
        assert!(create(&f.project, "p", draft).is_err());
        std::fs::remove_file(f.root.join("dirty")).unwrap();
        let r = f.create(Kind::Implementation);
        let (r, launch_context) = f.coordinator(&r);
        let r = f.assignments(&r, &launch_context, vec![]);
        std::fs::write(f.root.join("dirty"), "dirty").unwrap();
        assert!(
            launch(&f.root, "p", &r.id, "a", &f.project, |_| panic!(
                "must not spawn"
            ))
            .is_err()
        );
    }
    #[test]
    fn independent_workers_are_isolated_and_dependent_workers_seed_after_integration() {
        let f = Fixture::new();
        let r = f.create(Kind::Implementation);
        let (r, coordinator) = f.coordinator(&r);
        let r = f.assignments(&r, &coordinator, vec!["a".into()]);
        assert!(
            launch(&f.root, "p", &r.id, "b", &f.project, |_| panic!(
                "blocked dependency"
            ))
            .is_err()
        );
        let _r = f.complete_worker(&r, "a", "a.txt", "a");
        assert!(!f.root.join("a.txt").exists());
        let r = command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "a".into(),
            },
        )
        .unwrap();
        let base = r.integrated_head.clone();
        let r = f.launch(&r, "b");
        let b = &r.jobs[1];
        assert_eq!(b.base.as_deref(), Some(base.as_str()));
        let task = tasks::find(&f.root, b.task.as_deref().unwrap()).unwrap();
        assert!(Path::new(&task.worktree).join("a.txt").exists());
        assert_ne!(task.worktree, r.target);
        let worker = auth(&r, b, Role::Worker);
        assert!(
            command(
                &f.root,
                &worker,
                Command::Integrate {
                    assignment: "a".into()
                }
            )
            .is_err()
        );
        assert!(
            command(
                &f.root,
                &worker,
                Command::SubmitWorker {
                    summary: "done".into(),
                    commit: base
                }
            )
            .is_err()
        );
        let j = &r.jobs[0];
        assert!(
            Path::new(
                &tasks::find(&f.root, j.task.as_deref().unwrap())
                    .unwrap()
                    .worktree
            )
            .exists()
        );
    }
    #[test]
    fn workers_integrate_serially_and_repeated_integration_is_idempotent() {
        let f = Fixture::new();
        let r = f.create(Kind::Implementation);
        let (r, coordinator) = f.coordinator(&r);
        let r = f.assignments(&r, &coordinator, vec![]);
        let r = f.complete_worker(&r, "a", "a.txt", "a");
        let r = f.complete_worker(&r, "b", "b.txt", "b");
        assert_ne!(r.jobs[0].task, r.jobs[1].task);
        assert_eq!(r.jobs[0].base, r.jobs[1].base);
        let r = command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "a".into(),
            },
        )
        .unwrap();
        assert_ne!(r.state, State::Complete);
        let r = command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "b".into(),
            },
        )
        .unwrap();
        assert_eq!(r.state, State::Complete);
        let integrated = head(&f.root).unwrap();
        command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "b".into(),
            },
        )
        .unwrap();
        assert_eq!(head(&f.root).unwrap(), integrated);
        assert!(f.root.join("a.txt").exists() && f.root.join("b.txt").exists());
    }
    #[test]
    fn integration_conflicts_preserve_work_and_can_adopt_a_manual_resolution_after_restart() {
        let f = Fixture::new();
        let r = f.create(Kind::Implementation);
        let (r, coordinator) = f.coordinator(&r);
        let r = f.assignments(&r, &coordinator, vec![]);
        let r = f.complete_worker(&r, "a", "shared.txt", "a\n");
        let _r = f.complete_worker(&r, "b", "shared.txt", "b\n");
        command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "a".into(),
            },
        )
        .unwrap();
        assert!(
            command(
                &f.root,
                &coordinator,
                Command::Integrate {
                    assignment: "b".into()
                }
            )
            .is_err()
        );
        let r = read(&f.root, "p", &r.id).unwrap();
        assert_eq!(r.state, State::Paused);
        assert_eq!(r.jobs[1].state, JobState::Integrating);
        std::fs::write(f.root.join("shared.txt"), "resolved\n").unwrap();
        run(git(&f.root).args(["add", "shared.txt"])).unwrap();
        run(git(&f.root).args(["commit", "-m", "Resolve conflict"])).unwrap();
        let r = command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "b".into(),
            },
        )
        .unwrap();
        assert_eq!(r.state, State::Complete);
        assert_eq!(
            std::fs::read_to_string(f.root.join("shared.txt")).unwrap(),
            "resolved\n"
        );
    }
    #[test]
    fn creation_and_submission_do_not_accept_a_foreign_session() {
        let f = Fixture::new();
        let r = f.create(Kind::Scan);
        let r = f.launch(&r, &r.jobs[0].id);
        let mut foreign = auth(&r, &r.jobs[0], Role::Scanner);
        foreign.agent_session = "other-session".into();
        assert!(command(&f.root, &foreign, Command::SubmitScan { report: report() }).is_err());
        assert_eq!(terminal("claude").kind, TerminalKind::Agent);
    }
    #[test]
    fn an_older_session_sample_cannot_fail_a_later_launch() {
        let f = Fixture::new();
        let r = f.create(Kind::Scan);
        let r = f.launch(&r, &r.jobs[0].id);
        let sampled = reconcile_at(&f.root, "p", &[], false, 0).unwrap();
        assert_eq!(sampled[0].state, State::Running);
        assert_eq!(sampled[0].jobs[0].state, JobState::Running);
        // Recent launches are also protected while the session service publishes their records.
        let sampled = reconcile_at(&f.root, "p", &[], false, r.jobs[0].launched_ms + 100).unwrap();
        assert_eq!(sampled[0].jobs[0].state, JobState::Running);
    }
    #[test]
    fn an_uncertain_launch_reuses_its_request_and_adopts_the_existing_session() {
        let f = Fixture::new();
        let r = f.create(Kind::Scan);
        let mut record = None;
        let r = launch(&f.root, "p", &r.id, &r.jobs[0].id, &f.project, |l| {
            let id = crate::model::task_session_id("p", l.scope, &l.terminal.id, l.task.as_deref());
            let metadata = serde_json::from_value(serde_json::json!({"projectId":"p", "projectName":"p", "projectRoot":f.root, "componentId":l.scope, "terminalId":l.terminal.id, "task":l.task, "name":"fake", "kind":"agent"})).unwrap();
            if let Some(file) = context::owned_briefing(&l.spec) { context::remove_owned_briefing_file(&file); }
            record = Some(Record { id, metadata, spec:l.spec, snapshot:None, history:vec![], launch_command:String::new(), restart_context:None, interrupted:false, request_ids:vec![l.request_id] });
            Err(anyhow!("lost reply"))
        }).unwrap();
        let request = r.jobs[0].request_id.clone();
        reconcile_at(&f.root, "p", &[], false, u64::MAX).unwrap();
        let retried = control(
            &f.root,
            "p",
            &r.id,
            Control::Retry {
                job: r.jobs[0].id.clone(),
            },
        )
        .unwrap();
        assert_eq!(retried.jobs[0].request_id, request);
        let restored = reconcile(&f.root, "p", &[record.unwrap()], true).unwrap();
        assert_eq!(restored[0].state, State::Paused);
        assert_eq!(restored[0].jobs[0].state, JobState::Running);
        assert_eq!(restored[0].jobs[0].request_id, request);
    }
    #[test]
    fn a_merge_completed_before_the_reply_is_adopted_without_a_second_merge() {
        let f = Fixture::new();
        let r = f.create(Kind::Implementation);
        let (r, coordinator) = f.coordinator(&r);
        let r = f.assignments(&r, &coordinator, vec![]);
        assert!(ensure_integrated(&f.root, "p", &f.root).is_err());
        let r = f.complete_worker(&r, "a", "a.txt", "a");
        let mut intent = r.jobs[0].clone();
        intent.state = JobState::Integrating;
        intent.integration_base = Some(r.integrated_head);
        let journal = tasks::store_dir(&f.root)
            .unwrap()
            .join(format!("integration-{}-a.json", r.id));
        crate::workspace::atomic_write(&journal, &serde_json::to_vec(&intent).unwrap()).unwrap();
        run(git(&f.root).args([
            "merge",
            "--no-ff",
            "--no-edit",
            intent.commit.as_deref().unwrap(),
        ]))
        .unwrap();
        let merged = head(&f.root).unwrap();
        let restored = read(&f.root, "p", &r.id).unwrap();
        assert_eq!(restored.jobs[0].state, JobState::Integrating);
        let r = command(
            &f.root,
            &coordinator,
            Command::Integrate {
                assignment: "a".into(),
            },
        )
        .unwrap();
        assert_eq!(r.jobs[0].state, JobState::Integrated);
        assert_eq!(head(&f.root).unwrap(), merged);
    }
}
