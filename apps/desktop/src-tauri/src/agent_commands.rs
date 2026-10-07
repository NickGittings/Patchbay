//! Desktop actions shared by manual controls and authenticated agent commands.
use crate::{AppState, CmdResult, Project, blocking, err, for_task};
use patchbay_core::actions::{ActionPlan, ActionReport, ActionRequest};
use patchbay_core::agent_bridge::{Action, LaunchContext, Server};
use patchbay_core::session::{PreviewScan, Record, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    id: String,
    project_id: String,
    task: Option<String>,
    initiator: String,
    action: Action,
    state: String,
    report: Option<ActionReport>,
    error: Option<String>,
    preview_urls: Vec<String>,
}

pub fn start(app: AppHandle) -> anyhow::Result<std::sync::Arc<Server>> {
    Server::start(move |launch, action| dispatch(&app, launch, action).map_err(anyhow::Error::msg))
}

pub fn cli() -> CmdResult<PathBuf> {
    let path = std::env::current_exe()
        .map_err(err)?
        .with_file_name(if cfg!(windows) {
            "patchbay.exe"
        } else {
            "patchbay"
        });
    if !path.is_file() {
        return Err("Packaged Patchbay CLI is unavailable; run prepare:sessiond".into());
    }
    path.canonicalize().map_err(err)
}

pub fn inject(
    server: Option<std::sync::Arc<Server>>,
    launch: LaunchContext,
    spec: &mut patchbay_core::pty::SessionSpec,
) -> CmdResult<()> {
    let server = server.ok_or("Desktop agent bridge is unavailable")?;
    server.inject(launch, &cli()?, &mut spec.env);
    Ok(())
}

fn records(state: &AppState, launch: &LaunchContext) -> CmdResult<Vec<Record>> {
    Ok(state
        .service
        .list()?
        .into_iter()
        .filter(|record| {
            record.metadata.project_id == launch.project_id && record.metadata.task == launch.task
        })
        .collect())
}

fn previews(state: &AppState, ids: impl IntoIterator<Item = String>) -> CmdResult<Vec<String>> {
    let mut urls = Vec::new();
    for id in ids {
        let scan: Option<PreviewScan> = state.service.call(Request::PreviewUrls { id })?;
        for url in scan.into_iter().flat_map(|scan| scan.urls) {
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    Ok(urls)
}

fn emit(app: &AppHandle, activity: &Activity) {
    let state = app.state::<AppState>();
    let mut activities = state
        .activities
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(previous) = activities.iter_mut().find(|a| a.id == activity.id) {
        *previous = activity.clone();
    } else {
        activities.push(activity.clone());
    }
    // Keep active requests; retained session logs remain service-owned.
    if activities.len() > 200
        && let Some(index) = activities.iter().position(|a| a.state != "running")
    {
        activities.remove(index);
    }
    let _ = app.emit("patchbay://task-activity", activity);
}

pub fn run_action(
    app: &AppHandle,
    project_id: &str,
    mut project: Project,
    request: ActionRequest,
    task: Option<&str>,
    initiator: &str,
) -> CmdResult<ActionReport> {
    let action = match &request {
        ActionRequest::StartGroup { group_id } => Action::EnvironmentStart {
            group_id: group_id.clone(),
        },
        ActionRequest::ValidateAffected { component_id } => Action::Validate {
            component_id: component_id.clone(),
        },
    };
    let mut activity = Activity {
        id: patchbay_core::agent_bridge::new_id(),
        project_id: project_id.into(),
        task: task.map(Into::into),
        initiator: initiator.into(),
        action,
        state: "running".into(),
        report: None,
        error: None,
        preview_urls: vec![],
    };
    emit(app, &activity);
    let state = app.state::<AppState>();
    let result = (|| {
        let scoped = state.project(project_id)?;
        let access = scoped.access.snapshot();
        access.trust(&mut project).map_err(err)?;
        // Affected traversal precedes restriction, preserving missing/locked component errors.
        let plan = ActionPlan::build(&project, project_id, request, task).map_err(err)?;
        let ids = plan.component_ids();
        let project = access.restrict(project, &ids).map_err(err)?;
        let (project, _, _) = for_task(project, task, &ids, scoped.roots())?;
        state.service.call::<ActionReport>(Request::ActionRun {
            project: Box::new(project),
            plan: Box::new(plan),
        })
    })();
    match &result {
        Ok(report) => {
            activity.state = if report.results.iter().any(|r| {
                !matches!(
                    r.outcome,
                    patchbay_core::actions::TaskOutcome::Passed
                        | patchbay_core::actions::TaskOutcome::Started
                        | patchbay_core::actions::TaskOutcome::Reused
                )
            }) {
                "failed"
            } else {
                "finished"
            }
            .into();
            activity.report = Some(report.clone());
            activity.preview_urls =
                previews(&state, report.results.iter().map(|r| r.session_id.clone()))
                    .unwrap_or_default();
        }
        Err(error) => {
            activity.state = "failed".into();
            activity.error = Some(error.clone());
        }
    }
    emit(app, &activity);
    result
}

pub fn stop_group(
    app: &AppHandle,
    project_id: &str,
    project: &Project,
    group_id: &str,
    task: Option<&str>,
    initiator: &str,
) -> CmdResult<()> {
    let mut activity = Activity {
        id: patchbay_core::agent_bridge::new_id(),
        project_id: project_id.into(),
        task: task.map(Into::into),
        initiator: initiator.into(),
        action: Action::EnvironmentStop {
            group_id: group_id.into(),
        },
        state: "running".into(),
        report: None,
        error: None,
        preview_urls: vec![],
    };
    emit(app, &activity);
    let state = app.state::<AppState>();
    let result = (|| {
        state.project(project_id)?;
        if !project.groups.iter().any(|g| g.id == group_id) {
            return Err("Unknown configured environment group".into());
        }
        if let Some(task) = task {
            patchbay_core::tasks::stored(std::path::Path::new(&project.root), task).map_err(err)?;
        }
        state.service.call(Request::ActionStopGroup {
            project_id: project_id.into(),
            group_id: group_id.into(),
            task: task.map(Into::into),
        })
    })();
    activity.state = if result.is_ok() { "finished" } else { "failed" }.into();
    activity.error = result.as_ref().err().cloned();
    emit(app, &activity);
    result
}

fn dispatch(app: &AppHandle, launch: &LaunchContext, action: Action) -> CmdResult<Value> {
    let state = app.state::<AppState>();
    let scoped = state.project(&launch.project_id)?;
    let project = scoped
        .access
        .snapshot()
        .restrict(
            scoped
                .agent_project
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
                .unwrap_or_else(|| launch.project.clone()),
            &[],
        )
        .map_err(err)?;
    let (mapped, _, _) = for_task(project.clone(), launch.task.as_deref(), &[], scoped.roots())?;
    match action {
        Action::Context {} => {
            let root = std::path::Path::new(&mapped.root);
            let task = launch
                .task
                .as_deref()
                .map(|id| patchbay_core::tasks::find(root, id).map_err(err))
                .transpose()?;
            let scope = task.as_ref().map_or_else(
                || {
                    mapped
                        .components
                        .iter()
                        .map(|c| c.id.clone())
                        .collect::<Vec<_>>()
                },
                |t| t.components.clone(),
            );
            let plan = patchbay_core::plans::read(root, launch.task.as_deref()).ok();
            let assignments = patchbay_core::proposals::read(root, launch.task.as_deref(), true)
                .ok()
                .flatten()
                .map(|p| p.assignments);
            Ok(
                json!({"projectId":launch.project_id,"taskId":launch.task,"task":task,"scope":scope,"plan":plan,"assignments":assignments,"agentSessionId":launch.agent_session,"project":mapped}),
            )
        }
        Action::Status {} => {
            let sessions = records(&state, launch)?;
            let urls = previews(&state, sessions.iter().map(|s| s.id.clone()))?;
            let activities: Vec<_> = state
                .activities
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|a| a.project_id == launch.project_id && a.task == launch.task)
                .cloned()
                .collect();
            Ok(json!({"sessions":sessions.iter().map(|s| json!({
                    "sessionId":s.id,"componentId":s.metadata.component_id,"name":s.metadata.name,
                    "kind":s.metadata.kind,"taskId":s.metadata.task,
                    "running":s.snapshot.as_ref().is_some_and(|snapshot| snapshot.running),
                    "exitCode":s.snapshot.as_ref().and_then(|snapshot| snapshot.exit_code),
                    "status":s.snapshot.as_ref().map(|snapshot| &snapshot.status),
                    "interrupted":s.interrupted,
                })).collect::<Vec<_>>(),"activities":activities,"previewUrls":urls}))
        }
        Action::Logs { session_id } => {
            let record = records(&state, launch)?
                .into_iter()
                .find(|r| r.id == session_id)
                .ok_or("Session is outside the launch task")?;
            let snapshot: Option<patchbay_core::pty::Snapshot> =
                state.service.call(Request::Snapshot {
                    id: session_id.clone(),
                })?;
            let output = snapshot
                .as_ref()
                .map(|s| String::from_utf8_lossy(&s.data).into_owned())
                .unwrap_or_default();
            Ok(
                json!({"sessionId":record.id,"output":output,"running":snapshot.as_ref().is_some_and(|s| s.running),"truncated":snapshot.as_ref().is_some_and(|s| s.truncated),"previewUrls":previews(&state, [session_id])?}),
            )
        }
        Action::Propose { proposal } => {
            if !launch.planner {
                return Err("Only planner sessions can submit proposals".into());
            }
            patchbay_core::proposals::submit(&mapped, launch.task.as_deref(), &proposal)
                .map_err(err)?;
            let _ = app.emit(
                "patchbay://proposal",
                json!({"projectId":launch.project_id,"task":launch.task}),
            );
            Ok(json!({"submitted":true,"applied":false}))
        }
        Action::EnvironmentStop { group_id } => {
            stop_group(
                app,
                &launch.project_id,
                &project,
                &group_id,
                launch.task.as_deref(),
                &launch.agent_session,
            )?;
            Ok(json!({"stopped":true,"groupId":group_id}))
        }
        Action::EnvironmentStart { group_id } => {
            if launch.planner {
                return Err("Switch to implementation before starting environments".into());
            }
            let report = run_action(
                app,
                &launch.project_id,
                project,
                ActionRequest::StartGroup { group_id },
                launch.task.as_deref(),
                &launch.agent_session,
            )?;
            let urls = previews(&state, report.results.iter().map(|r| r.session_id.clone()))?;
            Ok(
                json!({"report":report,"sessionIds":report.results.iter().map(|r| &r.session_id).collect::<Vec<_>>(),"previewUrls":urls}),
            )
        }
        Action::Validate { component_id } => {
            if launch.planner {
                return Err("Switch to implementation before running checks".into());
            }
            let report = run_action(
                app,
                &launch.project_id,
                project,
                ActionRequest::ValidateAffected { component_id },
                launch.task.as_deref(),
                &launch.agent_session,
            )?;
            let passed = report.plan.skipped.is_empty()
                && report
                    .results
                    .iter()
                    .all(|r| matches!(r.outcome, patchbay_core::actions::TaskOutcome::Passed));
            Ok(
                json!({"passed":passed,"missingValidators":report.plan.skipped,"sessionIds":report.results.iter().map(|r| &r.session_id).collect::<Vec<_>>(),"report":report,"previewUrls":previews(&state, report.results.iter().map(|r| r.session_id.clone()))?}),
            )
        }
    }
}

#[tauri::command]
pub fn task_activities(project_id: String, state: State<'_, AppState>) -> CmdResult<Vec<Activity>> {
    state.project(&project_id)?;
    Ok(state
        .activities
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .filter(|a| a.project_id == project_id)
        .cloned()
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
