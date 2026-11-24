//! Tauri integration for the core agent-command engine.
use crate::{AppState, CmdResult, Project, blocking, err, for_task};
use patchbay_core::agent_bridge::{LaunchContext, Role, Server};
pub use patchbay_core::agent_commands::Activity;
use patchbay_core::agent_commands::{Host, ProjectScope};
use patchbay_core::agent_questions::{Asked, Pending};
use patchbay_core::session::{AgentSession, Request};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

const TASK_ACTIVITY_EVENT: &str = "patchbay://task-activity";
const PROPOSAL_EVENT: &str = "patchbay://proposal";
const MAP_LINKS_EVENT: &str = "patchbay://map-links";
const STACK_PROPOSALS_EVENT: &str = "patchbay://stack-proposals";
const AUTO_SETUP_EVENT: &str = "patchbay://auto-setup";
const AGENT_QUESTION_EVENT: &str = "patchbay://agent-question";
const AGENT_QUESTION_CLOSED_EVENT: &str = "patchbay://agent-question-closed";

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
        let _ = self.0.emit(TASK_ACTIVITY_EVENT, activity);
    }
    fn proposal_submitted(&self, launch: &LaunchContext) {
        let _ = self.0.emit(
            PROPOSAL_EVENT,
            serde_json::json!({"projectId":launch.project_id,"task":launch.task}),
        );
    }
    fn links_proposed(&self, launch: &LaunchContext) {
        let _ = self.0.emit(
            MAP_LINKS_EVENT,
            serde_json::json!({"projectId":launch.project_id}),
        );
    }
    fn stack_proposed(&self, launch: &LaunchContext) {
        let _ = self.0.emit(
            STACK_PROPOSALS_EVENT,
            serde_json::json!({"projectId":launch.project_id}),
        );
    }
    fn auto_setup_enabled(&self, project_id: &str) -> bool {
        self.0
            .state::<AppState>()
            .project(project_id)
            .is_ok_and(|p| !p.auto_setup_off.load(std::sync::atomic::Ordering::Relaxed))
    }
    /// The main window starts (or shows) detection with the asking agent's provider and
    /// reports the outcome through `auto_setup_report`.
    fn request_setup(&self, launch: &LaunchContext) -> anyhow::Result<()> {
        self.0
            .emit(
                AUTO_SETUP_EVENT,
                serde_json::json!({
                    "projectId": launch.project_id,
                    "task": launch.task,
                    "sessionId": launch.agent_session,
                }),
            )
            .map_err(anyhow::Error::from)
    }
    /// Runs on the bridge's connection thread, so waiting blocks only this hook.
    fn ask_user(
        &self,
        launch: &LaunchContext,
        questions: Vec<patchbay_core::agent_hooks::UserQuestion>,
        permission: bool,
        wait: std::time::Duration,
    ) -> Option<Vec<String>> {
        let asked = Asked {
            project_id: launch.project_id.clone(),
            task: launch.task.clone(),
            session_id: launch.agent_session.clone(),
            generation: launch.generation,
            questions,
            permission,
        };
        let mut id = None;
        let answer = self.0.state::<AppState>().questions.ask(
            asked,
            patchbay_core::agent_questions::CLAIM_WAIT,
            wait,
            |offered| {
                id = Some(offered.id.clone());
                let _ = self.0.emit(AGENT_QUESTION_EVENT, offered);
            },
        );
        if let Some(id) = id {
            let _ = self.0.emit(
                AGENT_QUESTION_CLOSED_EVENT,
                serde_json::json!({"id":id,"answered":answer.is_some()}),
            );
        }
        answer
    }
}

/// Whether agents may set up run & test for the project themselves.
#[tauri::command]
pub fn auto_setup_set(
    project_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    state
        .project(&project_id)?
        .auto_setup_off
        .store(!enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// What the main window did with an automatic run & test detection; the agents waiting
/// on it continue.
#[tauri::command]
pub fn auto_setup_report(
    project_id: String,
    outcome: patchbay_core::auto_setup::Outcome,
    window: tauri::WebviewWindow,
) -> CmdResult<bool> {
    crate::main_only(&window)?;
    Ok(patchbay_core::auto_setup::finish(&project_id, outcome))
}

/// Agent questions waiting for Chat, for a window that opened after they were asked.
#[tauri::command]
pub fn agent_questions(state: State<'_, AppState>) -> Vec<Pending> {
    state.questions.list()
}

/// The sessions whose questions Chat shows; others ask in their terminals at once.
#[tauri::command]
pub fn agent_questions_watch(session_ids: Vec<String>, state: State<'_, AppState>) {
    state.questions.watch(session_ids);
}

/// Chat shows the question, so its hook keeps waiting for the answer.
#[tauri::command]
pub fn agent_question_claim(id: String, state: State<'_, AppState>) -> bool {
    state.questions.claim(&id)
}

/// The user's answers, one per question, or `None` to answer in the agent's terminal.
#[tauri::command]
pub fn agent_question_answer(
    id: String,
    answers: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> bool {
    state.questions.answer(&id, answers)
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
        generation: Some(session.generation),
        role: Role::of(
            &session.metadata.component_id,
            &session.metadata.terminal_id,
        ),
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

fn project_root(state: &AppState, project_id: &str) -> CmdResult<String> {
    Ok(crate::task_repo(state, project_id)?.0.display().to_string())
}

/// Dependencies a detection agent proposed for the project, awaiting review.
#[tauri::command]
pub async fn map_links_read(
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<patchbay_core::link_proposals::Pending>> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::link_proposals::read(&root).map_err(err)).await
}

/// Forget a reviewed proposal; a newer submission stays.
#[tauri::command]
pub async fn map_links_clear(
    project_id: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::link_proposals::clear(&root, &id).map_err(err)).await
}

/// The stack a detection agent proposed for the project, awaiting review.
#[tauri::command]
pub async fn stack_proposal_read(
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<patchbay_core::stack_proposals::Pending>> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::stack_proposals::read(&root).map_err(err)).await
}

/// Forget a reviewed stack proposal; a newer submission stays.
#[tauri::command]
pub async fn stack_proposal_clear(
    project_id: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::stack_proposals::clear(&root, &id).map_err(err)).await
}

/// A submission the retired validation discovery agent left, reviewed once more.
#[tauri::command]
pub async fn validation_proposal_read(
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<patchbay_core::validation_proposals::Pending>> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::validation_proposals::read(&root).map_err(err)).await
}

/// Forget the retired discovery agent's reviewed submission.
#[tauri::command]
pub async fn validation_proposal_clear(
    project_id: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    let root = project_root(&state, &project_id)?;
    blocking(move || patchbay_core::validation_proposals::clear(&root, &id).map_err(err)).await
}

#[tauri::command]
pub async fn proposal_read(
    project_id: String,
    task: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<Option<patchbay_core::proposals::Proposal>> {
    let (root, _) = crate::task_repo(&state, &project_id)?;
    blocking(move || {
        if let Some(id) = patchbay_core::planning::checkout_task(task.as_deref()) {
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
    target: Option<String>,
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
        // `task` holds the proposal; `target` (default: the same) receives it.
        let target = target.or_else(|| task.clone());
        let (project, _, _) = for_task(project, target.as_deref(), &ids, scoped.roots())?;
        patchbay_core::proposals::apply(&project, task.as_deref(), target.as_deref(), &expected)
            .map_err(err)
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
