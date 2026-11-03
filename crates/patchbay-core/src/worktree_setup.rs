//! Local worktree preparation. Creation captures configuration but never executes it.
use crate::{
    Project,
    pty::{SessionSpec, Snapshot},
    session::{Metadata, Request},
    tasks,
};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

static LOCK: Mutex<()> = Mutex::new(());
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Preparing,
    Ready,
    Failed,
    Stopped,
    Skipped,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub command: String,
    pub status: Status,
    pub session: Option<String>,
    #[serde(default)]
    pub attempt: u64,
}
impl Setup {
    #[must_use]
    pub fn new(command: String) -> Self {
        Self {
            command,
            status: Status::Preparing,
            session: None,
            attempt: 0,
        }
    }
}
fn write(root: &Path, id: &str, setup: Setup) -> Result<Setup> {
    tasks::modify(root, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow::anyhow!("Unknown task"))?;
        task.setup = Some(setup.clone());
        Ok(setup)
    })
}
/// Enable only this exact command, in the uncommitted common git directory.
/// # Errors
/// Fails if the local store cannot be written.
pub fn enable(root: &Path, command: &str) -> Result<()> {
    let dir = tasks::store_dir(root)?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("setup-enabled.json"), serde_json::to_vec(command)?)?;
    Ok(())
}
/// # Errors
/// Fails when the store is unavailable.
pub fn enabled(root: &Path, command: &str) -> Result<bool> {
    let file = tasks::store_dir(root)?.join("setup-enabled.json");
    Ok(std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<String>(&b).ok())
        .as_deref()
        == Some(command))
}
/// Read and reconcile a saved outcome without ever launching a command.
/// # Errors
/// Fails on store or service errors; disconnection never changes the saved outcome.
pub fn read(
    root: &Path,
    id: &str,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<Option<Setup>> {
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reconcile(root, id, call)
}
fn reconcile(
    root: &Path,
    id: &str,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<Option<Setup>> {
    let Some(mut setup) = tasks::stored(root, id)?.setup else {
        return Ok(None);
    };
    if setup.status == Status::Preparing
        && let Some(session) = &setup.session
    {
        let snapshot: Option<Snapshot> = serde_json::from_value(call(Request::Snapshot {
            id: session.clone(),
            output_limit: Some(0),
        })?)?;
        if let Some(s) = snapshot {
            if !s.running {
                setup.status = if s.exit_code == Some(0) {
                    Status::Ready
                } else {
                    Status::Failed
                };
                write(root, id, setup.clone())?;
            }
        } else {
            setup.status = Status::Stopped;
            write(root, id, setup.clone())?;
        }
    }
    Ok(Some(setup))
}
/// Start, stop or explicitly bypass setup. A single lock covers reservation and spawn.
/// # Errors
/// Fails if the command is not locally enabled, already runs, or the service fails.
pub fn action(
    project: &Project,
    project_id: &str,
    id: &str,
    action: &str,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<Option<Setup>> {
    if !matches!(action, "start" | "stop" | "skip") {
        bail!("Unknown setup action");
    }
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = Path::new(&project.root);
    let Some(mut setup) = reconcile(root, id, call)? else {
        return Ok(None);
    };
    let task = tasks::find(root, id)?;
    if action == "stop" || action == "skip" {
        if setup.status == Status::Preparing
            && let Some(session) = &setup.session
        {
            call(Request::Stop {
                id: session.clone(),
            })?;
        }
        setup.status = if action == "skip" {
            Status::Skipped
        } else {
            Status::Stopped
        };
        return write(root, id, setup).map(Some);
    }
    if setup.status == Status::Preparing && setup.session.is_some() {
        return Ok(Some(setup));
    }
    if !enabled(root, &setup.command)? {
        bail!("Enable this exact worktree setup command locally before running it");
    }
    setup.attempt += 1;
    let terminal_id = format!("worktree-setup-{}", setup.attempt);
    let sid = crate::model::task_session_id(
        project_id,
        crate::model::TASK_ROOT_SCOPE,
        &terminal_id,
        Some(id),
    );
    setup.status = Status::Preparing;
    setup.session = Some(sid.clone());
    write(root, id, setup.clone())?;
    let spec = SessionSpec {
        id: sid.clone(),
        command: setup.command.clone(),
        cwd: task.worktree.clone().into(),
        env: [
            ("PATCHBAY_PROJECT_ROOT".into(), project.root.clone()),
            ("PATCHBAY_WORKTREE_ROOT".into(), task.worktree),
        ]
        .into(),
        resume_command: None,
        rerun_on_resume: false,
        owns_briefing: false,
        exclusive_cwd: false,
        merge_source: None,
        ready_when: String::new(),
        service: false,
        notice: None,
        dirs: vec![],
    };
    let metadata: Metadata = serde_json::from_value(serde_json::json!({
        "projectId": project_id, "projectName": project.name, "projectRoot": project.root,
        "componentId": crate::model::TASK_ROOT_SCOPE, "terminalId": terminal_id, "task": id,
        "taskTitle": task.title, "name": "Worktree setup", "kind": "task", "command": setup.command
    }))?;
    // Keep the reservation on uncertain transport failure; reconcile before retrying.
    call(Request::Start {
        request_id: sid,
        metadata: Box::new(metadata),
        spec,
    })?;
    Ok(Some(setup))
}
/// # Errors
/// Fails until setup succeeded or the user explicitly bypassed it.
pub fn require_ready(
    root: &Path,
    id: &str,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<()> {
    if let Some(setup) = read(root, id, call)?
        && !matches!(setup.status, Status::Ready | Status::Skipped)
    {
        bail!("Worktree setup is not ready. Retry setup or explicitly continue without setup.");
    }
    Ok(())
}

/// The service boundary deferred a provider job before spawning its agent.
#[derive(Debug)]
pub struct Pending;
impl std::fmt::Display for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Worktree setup is waiting")
    }
}
impl std::error::Error for Pending {}
