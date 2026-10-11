//! Tauri integration for the core agent-command engine.
use crate::{AppState, CmdResult, Project, blocking, err, for_task};
use patchbay_core::agent_bridge::{LaunchContext, Server};
pub use patchbay_core::agent_commands::Activity;
use patchbay_core::agent_commands::{Host, ProjectScope};
use patchbay_core::session::{AgentSession, Request};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

struct Desktop(AppHandle);
impl Host for Desktop {
    fn project(&self, id: &str) -> anyhow::Result<ProjectScope> {
        let scoped = self
            .0
            .state::<AppState>()
            .project(id)
            .map_err(anyhow::Error::msg)?;
        let project = scoped
            .agent_project
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        Ok(ProjectScope {
            access: scoped.access.snapshot(),
            project,
            roots: scoped.roots(),
        })
    }
    fn request(&self, request: Request) -> anyhow::Result<serde_json::Value> {
        self.0
            .state::<AppState>()
            .service
            .call(request)
            .map_err(anyhow::Error::msg)
    }
    fn activities(&self) -> Vec<Activity> {
        self.0.state::<AppState>().activities.list()
    }
    fn emit_activity(&self, activity: &Activity) {
        self.0.state::<AppState>().activities.record(activity);
        let _ = self.0.emit("patchbay://task-activity", activity);
    }
    fn proposal_submitted(&self, launch: &LaunchContext) {
        let _ = self.0.emit(
            "patchbay://proposal",
            serde_json::json!({"projectId":launch.project_id,"task":launch.task}),
        );
    }
}

pub fn run_action(
    app: &AppHandle,
    project_id: &str,
    project: Project,
    request: patchbay_core::actions::ActionRequest,
    task: Option<&str>,
    initiator: &str,
) -> CmdResult<(patchbay_core::actions::ActionReport, Vec<String>)> {
    patchbay_core::agent_commands::run_action(
        &Desktop(app.clone()),
        project_id,
        project,
        request,
        task,
        initiator,
    )
    .map_err(err)
}
pub fn stop_group(
    app: &AppHandle,
    project_id: &str,
    root: &std::path::Path,
    group_id: &str,
    task: Option<&str>,
    initiator: &str,
) -> CmdResult<()> {
    patchbay_core::agent_commands::stop_group(
        &Desktop(app.clone()),
        project_id,
        root,
        group_id,
        task,
        initiator,
    )
    .map_err(err)
}

pub fn start(app: AppHandle) -> anyhow::Result<std::sync::Arc<Server>> {
    let endpoint = patchbay_core::workspace::home()?.join("agent-endpoint");
    let lookup = app.clone();
    Server::start(
        endpoint,
        move |token| authenticate(&lookup, token),
        move |launch, action| {
            patchbay_core::agent_commands::dispatch(&Desktop(app.clone()), launch, action)
        },
    )
}

/// The running session a token was launched with; the service keeps it with the session,
/// so tokens outlive a desktop restart but not their process.
fn authenticate(app: &AppHandle, token: &str) -> Option<LaunchContext> {
    let state = app.state::<AppState>();
    let session: Option<AgentSession> = state
        .service
        .call(Request::AgentSession {
            token: token.into(),
        })
        .ok()?;
    let session = session?;
    Some(LaunchContext {
        planner: session.metadata.component_id == patchbay_core::model::PLAN_SCOPE,
        project_id: session.metadata.project_id,
        task: session.metadata.task,
        agent_session: session.id,
    })
}

pub fn cli() -> CmdResult<PathBuf> {
    let path = std::env::current_exe()
        .map_err(err)?
        .with_file_name(if cfg!(windows) {
            "patchbay-cli.exe"
        } else {
            "patchbay-cli"
        });
    if !path.is_file() {
        return Err("the packaged Patchbay CLI is missing; run prepare:sessiond".into());
    }
    path.canonicalize().map_err(err)
}

/// Give an agent its command token; without the bridge or CLI it still starts, with a notice.
pub fn inject(
    server: Option<std::sync::Arc<Server>>,
    project_id: &str,
    task: Option<&str>,
    spec: &mut patchbay_core::pty::SessionSpec,
) {
    let reason = match (server, cli()) {
        (Some(server), Ok(cli)) => {
            server.inject(project_id, task, &cli, &mut spec.env);
            return;
        }
        (None, _) => "the desktop bridge didn't start".to_string(),
        (_, Err(e)) => e,
    };
    patchbay_core::agent_bridge::unavailable(spec, &reason);
}

#[tauri::command]
pub fn task_activities(project_id: String, state: State<'_, AppState>) -> CmdResult<Vec<Activity>> {
    state.project(&project_id)?;
    Ok(state
        .activities
        .list()
        .into_iter()
        .filter(|a| a.project_id == project_id)
        .collect())
}

#[tauri::command]
pub async fn proposal_read(
    project_id: String,
    task: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<Option<patchbay_core::proposals::Proposal>> {
    let (root, _) = crate::task_repo(&state, &project_id)?;
    blocking(move || {
        if let Some(id) = &task {
            patchbay_core::tasks::find(&root, id).map_err(err)?;
        }
        patchbay_core::proposals::read(&root, task.as_deref(), false).map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn proposal_apply(
    project_id: String,
    project: Project,
    task: Option<String>,
    expected: patchbay_core::proposals::Proposal,
    state: State<'_, AppState>,
) -> CmdResult<Vec<String>> {
    let scoped = state.project(&project_id)?;
    blocking(move || {
        let ids = expected
            .assignments
            .iter()
            .map(|a| a.component_id.clone())
            .collect::<Vec<_>>();
        let project = scoped
            .access
            .snapshot()
            .restrict(project, &ids)
            .map_err(err)?;
        let (project, _, _) = for_task(project, task.as_deref(), &ids, scoped.roots())?;
        patchbay_core::proposals::apply(&project, task.as_deref(), &expected).map_err(err)
    })
    .await
}

/// Keep configured IDs and commands current without changing an agent's launch identity.
#[tauri::command]
pub fn sync_agent_project(
    project_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<()> {
    crate::main_only(&window)?;
    let scoped = state.project(&project_id)?;
    scoped.access.snapshot().trust(&mut project).map_err(err)?;
    project.validate().map_err(err)?;
    *scoped
        .agent_project
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(project);
    Ok(())
}
