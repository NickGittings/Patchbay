//! Desktop boundary for persistent provider runs. Core owns records, scopes and Git operations.
use crate::{AppState, CmdResult, Project, blocking, err, service, task_repo};
use patchbay_core::orchestration::{self, Control, Draft, Run};
use patchbay_core::session::Request;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use tauri::{State, WebviewWindow};

pub(crate) static RESTORED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

#[tauri::command]
pub async fn provider_runs(project_id: String, state: State<'_, AppState>) -> CmdResult<Vec<Run>> {
    let (root, _) = task_repo(&state, &project_id)?;
    let bridge = state.service.clone();
    blocking(move || {
        let sampled_ms = orchestration::now_ms();
        let records = bridge.list()?;
        let mut restored = RESTORED.lock().unwrap();
        let restoring = !restored.contains(&project_id);
        let runs = orchestration::reconcile_at(&root, &project_id, &records, restoring, sampled_ms)
            .map_err(err)?;
        restored.insert(project_id);
        Ok(runs)
    })
    .await
}
#[tauri::command]
pub async fn provider_run_create(
    window: WebviewWindow,
    project_id: String,
    mut project: Project,
    draft: Draft,
    state: State<'_, AppState>,
) -> CmdResult<Run> {
    crate::main_only(&window)?;
    let (root, scoped) = task_repo(&state, &project_id)?;
    let access = scoped.access.snapshot();
    let bridge = state.service.clone();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        let project = access.restrict(project, &draft.components).map_err(err)?;
        // Existing runs restore paused even when creation is the first operation after restart.
        let mut restored = RESTORED.lock().unwrap();
        if !restored.contains(&project_id) {
            let sampled_ms = orchestration::now_ms();
            orchestration::reconcile_at(&root, &project_id, &bridge.list()?, true, sampled_ms)
                .map_err(err)?;
            restored.insert(project_id.clone());
        }
        drop(restored);
        orchestration::create(&project, &project_id, draft).map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn provider_run_control(
    window: WebviewWindow,
    project_id: String,
    id: String,
    control: Control,
    state: State<'_, AppState>,
) -> CmdResult<Run> {
    crate::main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    let bridge = state.service.clone();
    blocking(move || {
        let previous = orchestration::read(&root, &project_id, &id).map_err(err)?;
        if previous.chat_team.is_some() {
            return Err("Use Chat worker controls for chat-owned rounds".into());
        }
        if let Control::ContinueJob { job, request_id } = &control {
            let owned = previous
                .jobs
                .iter()
                .chain(previous.coordinator.iter())
                .find(|j| &j.id == job && &j.request_id == request_id)
                .ok_or("Provider job ownership changed")?;
            let records = bridge.list()?;
            let ready = records.iter().any(|r| {
                r.request_ids.last() == Some(request_id)
                    && owned.session_id.as_deref() == Some(&r.id)
                    && r.snapshot.as_ref().is_some_and(|s| {
                        s.running
                            && !s.status.stopped
                            && s.status.agent.as_ref().is_some_and(|a| {
                                a.authoritative
                                    && !a.approval_pending
                                    && matches!(
                                        a.state,
                                        patchbay_core::status::AgentState::Idle
                                            | patchbay_core::status::AgentState::Review
                                    )
                            })
                    })
            });
            if !ready {
                return Err("Provider job is not at an owned conversational prompt".into());
            }
        }
        let stopping = matches!(control, Control::Stop | Control::ContinueScan);
        let retry = match &control {
            Control::Retry { job } => Some(job.as_str()),
            _ => None,
        };
        // Stop an old failed process before a retry makes its preserved checkout schedulable.
        let stop_jobs = |run: &Run, only: Option<&str>| -> CmdResult<()> {
            let records = bridge.list()?;
            for job in run.jobs.iter().chain(run.coordinator.iter()).filter(|j| {
                only.is_none()
                    || (Some(j.id.as_str()) == only && j.state == orchestration::JobState::Failed)
            }) {
                if let Some(record) = records.iter().find(|r| {
                    r.request_ids.last() == Some(&job.request_id)
                        && job.session_id.as_deref() == Some(&r.id)
                }) {
                    bridge.call::<()>(Request::Stop {
                        id: record.id.clone(),
                    })?;
                }
            }
            Ok(())
        };
        if let Some(job) = retry {
            stop_jobs(&previous, Some(job))?;
        }
        let result =
            orchestration::control(&root, &project_id, &id, control.clone()).map_err(err)?;
        // The final record includes launches that settled while Stop waited for the core lock.
        if stopping {
            stop_jobs(&result, None)?;
        }
        Ok(result)
    })
    .await
}
#[tauri::command]
pub async fn provider_job_start(
    window: WebviewWindow,
    project_id: String,
    project: Project,
    id: String,
    job: String,
    state: State<'_, AppState>,
) -> CmdResult<Run> {
    crate::main_only(&window)?;
    let (root, scoped) = task_repo(&state, &project_id)?;
    let access = scoped.access.snapshot();
    let bridge = state.service.clone();
    let server = state.agent_commands.lock().unwrap().clone();
    blocking(move || {
        let saved = orchestration::read(&root, &project_id, &id).map_err(err)?;
        let project = access.restrict(project, &saved.components).map_err(err)?;
        if saved.chat_team.is_some() {
            if server.is_none() { return Err("The agent command bridge is unavailable; restart Patchbay or continue locally in the lead terminal".into()); }
            crate::agent_commands::cli()?;
        }
        orchestration::launch(&root, &project_id, &id, &job, &project, |mut launch| {
            if let Some(task) = launch.task.as_deref() {
                let mut call = |r| bridge.call(r).map_err(anyhow::Error::msg);
                let setup = patchbay_core::worktree_setup::read(&root, task, &mut call)?;
                if let Some(setup) = setup {
                    if setup.attempt == 0
                        && setup.status == patchbay_core::worktree_setup::Status::Preparing
                        && patchbay_core::worktree_setup::enabled(&root, &setup.command)?
                    {
                        patchbay_core::worktree_setup::action(
                            &project,
                            &project_id,
                            task,
                            "start",
                            &mut call,
                        )?;
                    }
                    if patchbay_core::worktree_setup::require_ready(&root, task, &mut call).is_err()
                    {
                        return Err(patchbay_core::worktree_setup::Pending.into());
                    }
                }
            }
            let mut metadata =
                service::metadata(&project_id, &launch.project, launch.scope, &launch.terminal);
            metadata.task.clone_from(&launch.task);
            metadata.project_root.clone_from(&project.root);
            crate::agent_commands::inject(
                server,
                &project_id,
                launch.task.as_deref(),
                &mut launch.spec,
            );
            bridge
                .launch(launch.spec, metadata, launch.request_id, false)
                .map_err(anyhow::Error::msg)
        })
        .map_err(err)
    })
    .await
}
