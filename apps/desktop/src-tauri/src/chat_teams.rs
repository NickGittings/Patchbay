//! Session transport for chat coordination. All durable scheduling decisions live in core.
use crate::orchestration::RESTORED;
use crate::{AppState, CmdResult, blocking, err, task_repo};
use patchbay_core::{
    orchestration::{
        self,
        chat::{self, Control, Team},
    },
    session::{Record, Request},
};
use std::path::{Path, PathBuf};
use tauri::{State, WebviewWindow};

fn target(root: &Path, task: Option<&str>) -> CmdResult<PathBuf> {
    let path = match task {
        Some(task) => PathBuf::from(
            patchbay_core::tasks::find(root, task)
                .map_err(err)?
                .worktree,
        ),
        None => root.to_path_buf(),
    };
    patchbay_core::git::repo_root(&path).ok_or_else(|| {
        "Chat teams need a supported Git repository; continue locally in the lead terminal".into()
    })
}
#[tauri::command]
pub async fn chat_teams(
    window: WebviewWindow,
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<Team>> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    let bridge = state.service.clone();
    let server = state.agent_commands.lock().unwrap().clone();
    blocking(move || {
        let sampled_ms = orchestration::now_ms();
        let records = bridge.list()?;
        let mut restored = RESTORED.lock().unwrap();
        let restoring = !restored.contains(&project_id);
        orchestration::reconcile_at(&root, &project_id, &records, restoring, sampled_ms)
            .map_err(err)?;
        let teams = chat::reconcile(&root, &project_id, &records, restoring).map_err(err)?;
        restored.insert(project_id.clone());
        drop(restored);
        if !restoring {
            for team in &teams {
                let mut call = |mut request: Request| {
                    if let Request::NewConversation { spec, metadata, .. } = &mut request {
                        crate::agent_commands::inject(
                            server.clone(),
                            &project_id,
                            metadata.task.as_deref(),
                            spec,
                        );
                    }
                    if let Request::Prompt {
                        id,
                        viewer,
                        generation,
                        text,
                        force,
                    } = request
                    {
                        return match bridge
                            .call::<patchbay_core::session::ChatPrompt>(Request::ChatPrompt {
                                id,
                                viewer,
                                generation,
                                text,
                                force,
                            })
                            .map_err(anyhow::Error::msg)?
                        {
                            patchbay_core::session::ChatPrompt::Delivered => {
                                Ok(serde_json::Value::Null)
                            }
                            patchbay_core::session::ChatPrompt::Refused { error } => {
                                Err(chat::DeliveryRefused(error).into())
                            }
                            patchbay_core::session::ChatPrompt::Uncertain { error } => {
                                Err(anyhow::anyhow!(error))
                            }
                        };
                    }
                    bridge.call(request).map_err(anyhow::Error::msg)
                };
                chat::replace_lead(&root, &project_id, &team.id, &records, &mut call)
                    .map_err(err)?;
                // A replacement must rebind before any delivery can resume.
                let fresh: Vec<Record> = bridge.list()?;
                chat::reconcile(&root, &project_id, &fresh, false).map_err(err)?;
                chat::deliver(&root, &project_id, &team.id, &fresh, &mut call).map_err(err)?;
            }
        }
        chat::list(&root, &project_id).map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn chat_team_initialize(
    window: WebviewWindow,
    project_id: String,
    seed: chat::Initialize,
    state: State<'_, AppState>,
) -> CmdResult<Team> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    let bridge = state.service.clone();
    blocking(move || {
        let sampled_ms = orchestration::now_ms();
        let records = bridge.list()?;
        let mut restored = RESTORED.lock().unwrap();
        if !restored.contains(&project_id) {
            orchestration::reconcile_at(&root, &project_id, &records, true, sampled_ms)
                .map_err(err)?;
            restored.insert(project_id.clone());
        }
        drop(restored);
        let target = target(&root, seed.task.as_deref())?;
        let session = seed.session_id.clone();
        let team = chat::initialize(&root, &project_id, &target, seed, &records).map_err(err)?;
        let briefing: String = bridge.call(Request::ChatBriefing { id: session })?;
        chat::retain_briefing(&root, &project_id, &team.id, &briefing).map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn chat_team_control(
    window: WebviewWindow,
    project_id: String,
    id: String,
    control: Control,
    state: State<'_, AppState>,
) -> CmdResult<Team> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    let bridge = state.service.clone();
    blocking(move || {
        let records = bridge.list()?;
        let before = chat::list(&root, &project_id)
            .map_err(err)?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or("Unknown chat team")?;
        let stop_workers = |only: Option<&str>| -> CmdResult<()> {
            let runs = orchestration::list(&root, &project_id).map_err(err)?;
            let records = bridge.list()?;
            for job in runs
                .iter()
                .filter(|r| r.chat_team.as_deref() == Some(&before.id))
                .flat_map(|r| &r.jobs)
                .filter(|j| {
                    only.is_none_or(|id| j.id == id && j.state == orchestration::JobState::Failed)
                })
            {
                if let Some(record) = records.iter().find(|r| {
                    job.session_id.as_deref() == Some(&r.id)
                        && r.request_ids.last() == Some(&job.request_id)
                }) {
                    bridge.call::<()>(Request::Stop {
                        id: record.id.clone(),
                    })?;
                }
            }
            Ok(())
        };
        if let Control::Retry { assignment } = &control {
            stop_workers(Some(assignment))?;
        }
        let stopping = matches!(control, Control::Stop);
        let result = chat::control(&root, &project_id, &id, control, &records).map_err(err)?;
        if stopping {
            stop_workers(None)?;
        }
        Ok(result)
    })
    .await
}
#[tauri::command]
pub async fn chat_team_message(
    window: WebviewWindow,
    project_id: String,
    id: String,
    assignment: String,
    message_id: String,
    text: String,
    state: State<'_, AppState>,
) -> CmdResult<Team> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || {
        chat::side_message(&root, &project_id, &id, &assignment, message_id, text).map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn auto_worktree_ownership(
    window: WebviewWindow,
    project_id: String,
    task: Option<String>,
    id: String,
    acquire: bool,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || {
        let tree = if acquire {
            target(&root, task.as_deref())?
        } else {
            root.clone()
        };
        chat::auto_ownership(&root, &project_id, &tree, &id, acquire).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn chat_team_new_lead(
    window: WebviewWindow,
    project_id: String,
    project: patchbay_core::Project,
    id: String,
    terminal: patchbay_core::TerminalSpec,
    request_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Team> {
    crate::main_only(&window)?;
    let (root, scoped) = task_repo(&state, &project_id)?;
    let access = scoped.access.snapshot();
    blocking(move || {
        let project = access.restrict(project, &[]).map_err(err)?;
        chat::new_lead(&root, &project, &project_id, &id, terminal, request_id).map_err(err)
    })
    .await
}

/// Main-window workflow driver uses the same authenticated lead command and durable job IDs.
#[tauri::command]
pub async fn chat_team_delegate_shared(
    window: WebviewWindow,
    project_id: String,
    project: patchbay_core::Project,
    id: String,
    request_id: String,
    assignments: Vec<orchestration::AssignmentDraft>,
    state: State<'_, AppState>,
) -> CmdResult<Team> {
    crate::main_only(&window)?;
    let (root, scoped) = task_repo(&state, &project_id)?;
    let access = scoped.access.snapshot();
    let bridge = state.service.clone();
    blocking(move || {
        let project = access.restrict(project, &[]).map_err(err)?;
        let team = chat::list(&root, &project_id)
            .map_err(err)?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or("Unknown team")?;
        let launch = patchbay_core::agent_bridge::LaunchContext {
            generation: Some(team.lead.generation),
            project_id,
            task: team.task,
            agent_session: team.lead.session_id,
            role: patchbay_core::agent_bridge::Role::Component,
        };
        chat::command(
            &root,
            &project,
            &launch,
            &bridge.list()?,
            chat::Command::DelegateShared {
                id: request_id,
                assignments,
            },
        )
        .map_err(err)
    })
    .await
}

/// Resolve the worktree's existing conversation before submitting a user message.
#[tauri::command]
pub async fn chat_continue(
    window: WebviewWindow,
    project_id: String,
    project: patchbay_core::Project,
    id: String,
    saved_context: String,
    state: State<'_, AppState>,
) -> Result<chat::Continuation, chat::ContinuationFailure> {
    use chat::{ContinuationFailure, FailureKind};
    crate::main_only(&window)
        .map_err(|e| ContinuationFailure::new(FailureKind::Configuration, e))?;
    let (root, scoped) = task_repo(&state, &project_id)
        .map_err(|e| ContinuationFailure::new(FailureKind::Configuration, e))?;
    let access = scoped.access.snapshot();
    let bridge = state.service.clone();
    let server = state.agent_commands.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<chat::Continuation> {
        let project = access
            .restrict(project, &[])
            .map_err(|e| ContinuationFailure::new(FailureKind::Access, e.to_string()))?;
        chat::continue_lead(
            &root,
            &project,
            &project_id,
            &id,
            &saved_context,
            |mut request| {
                if let Request::ChatResume { id, .. } | Request::ResetConversation { id, .. } =
                    &request
                {
                    let records = bridge
                        .list()
                        .map_err(|e| ContinuationFailure::new(FailureKind::Connection, e))?;
                    let record = records.iter().find(|r| &r.id == id).ok_or_else(|| {
                        ContinuationFailure::new(
                            FailureKind::Connection,
                            "Session unavailable; retry to reconcile",
                        )
                    })?;
                    let mut roots = match &record.metadata.task {
                        Some(task) => vec![target(&root, Some(task)).map_err(anyhow::Error::msg)?],
                        None => scoped.roots(),
                    };
                    roots.extend(patchbay_core::plans::existing_dir(&root));
                    patchbay_core::session::check_resume(record, &roots).map_err(|e| {
                        ContinuationFailure::new(FailureKind::Access, format!("{e:#}"))
                    })?;
                }
                if let Request::NewConversation { spec, metadata, .. } = &mut request {
                    crate::agent_commands::inject(
                        server.clone(),
                        &project_id,
                        metadata.task.as_deref(),
                        spec,
                    );
                }
                bridge
                    .call_reporting(request)
                    .map_err(|(message, uncertain)| {
                        ContinuationFailure::new(
                            if uncertain {
                                FailureKind::Uncertain
                            } else {
                                FailureKind::Connection
                            },
                            message,
                        )
                        .into()
                    })
            },
        )
    })
    .await
    .map_err(|e| ContinuationFailure::new(FailureKind::Uncertain, e.to_string()))?
    .map_err(ContinuationFailure::from_error)
}
