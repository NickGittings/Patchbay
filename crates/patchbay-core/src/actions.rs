//! Explicit graph actions, shared by desktop and other core clients.
use crate::context;
use crate::events::EventSink;
use crate::model::{Project, TASK_SEPARATOR, TerminalAction, TerminalKind, task_session_id};
use crate::policy::AllowAll;
use crate::pty::{PtyManager, SessionSpec};
use anyhow::{Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionRequest {
    StartGroup {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    ValidateAffected {
        #[serde(rename = "componentId")]
        component_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionPlan {
    pub request: ActionRequest,
    /// Component ids per startup stage; validation keeps graph distance order.
    pub stages: Vec<Vec<String>>,
    pub skipped: Vec<String>,
    pub sessions: Vec<String>,
    /// The task whose worktree the terminals run in; `None` for the open one.
    pub task: Option<String>,
}

impl ActionPlan {
    /// Resolve which components and terminals an action runs, in order.
    /// `project` should already be the task's ([`crate::tasks::project_in`]).
    ///
    /// # Errors
    /// Fails for an invalid map, an unknown group or component, a dependency
    /// cycle in an ordered group, an out-of-range readiness timeout, a graph
    /// action that isn't a task with a command, or a group with nothing to start.
    pub fn build(project: &Project, request: ActionRequest, task: Option<&str>) -> Result<Self> {
        project.validate()?;
        let (stages, action) = match &request {
            ActionRequest::StartGroup { group_id } => {
                let group = project
                    .groups
                    .iter()
                    .find(|g| &g.id == group_id)
                    .ok_or_else(|| anyhow!("Unknown group {group_id}"))?;
                ensure!(
                    !group.component_ids.is_empty(),
                    "Group {} has no components",
                    group.name
                );
                ensure!(
                    (1..=3600).contains(&group.readiness_timeout_seconds),
                    "Readiness timeout of {} must be between 1 and 3600 seconds",
                    group.name
                );
                let stages = if group.ordered_startup {
                    startup_stages(project, &group.component_ids)?
                } else {
                    vec![group.component_ids.clone()]
                };
                (stages, TerminalAction::Development)
            }
            ActionRequest::ValidateAffected { component_id } => {
                ensure!(
                    project.component(component_id).is_some(),
                    "Unknown component {component_id}"
                );
                let mut ids = vec![component_id.clone()];
                ids.extend(
                    project
                        .dependents(std::slice::from_ref(component_id))
                        .into_iter()
                        .map(|(id, _)| id),
                );
                // Invalid graph ends must not silently disappear from the report.
                for id in &ids {
                    ensure!(
                        project.component(id).is_some(),
                        "Unknown affected component {id}"
                    );
                }
                (
                    ids.into_iter().map(|id| vec![id]).collect(),
                    TerminalAction::Validation,
                )
            }
        };
        let mut skipped = Vec::new();
        let mut sessions = Vec::new();
        for id in stages.iter().flatten() {
            let component = project
                .component(id)
                .ok_or_else(|| anyhow!("Unknown component {id}"))?;
            let selected: Vec<_> = component
                .terminals
                .iter()
                .filter(|t| t.action == Some(action))
                .collect();
            if selected.is_empty() {
                skipped.push(id.clone());
            }
            for terminal in &selected {
                // Checked here rather than in `validate`, so a terminal still
                // being configured doesn't block every other command.
                ensure!(
                    terminal.kind == TerminalKind::Task && !terminal.command.trim().is_empty(),
                    "{} › {} needs to be a task with a command to run as a graph action",
                    component.name,
                    terminal.name
                );
                sessions.push(task_session_id(id, &terminal.id, task));
            }
        }
        if action == TerminalAction::Development {
            ensure!(
                !sessions.is_empty(),
                "This group has no development task terminals configured"
            );
        }
        Ok(Self {
            request,
            stages,
            skipped,
            sessions,
            task: task.map(str::to_string),
        })
    }

    #[must_use]
    pub fn component_ids(&self) -> Vec<String> {
        self.stages.iter().flatten().cloned().collect()
    }

    fn specs(&self, project: &Project) -> Result<Vec<Vec<SessionSpec>>> {
        let selected: HashSet<_> = self.sessions.iter().collect();
        self.stages
            .iter()
            .map(|stage| {
                let mut specs = Vec::new();
                for id in stage {
                    let component = project
                        .component(id)
                        .ok_or_else(|| anyhow!("Unknown component {id}"))?;
                    for terminal in &component.terminals {
                        let session = task_session_id(id, &terminal.id, self.task.as_deref());
                        if selected.contains(&session) {
                            specs.push(context::session_spec_for(
                                project,
                                id,
                                &terminal.id,
                                self.task.as_deref(),
                                &AllowAll,
                                &[],
                            )?);
                        }
                    }
                }
                Ok(specs)
            })
            .collect()
    }
}

fn startup_stages(project: &Project, ids: &[String]) -> Result<Vec<Vec<String>>> {
    let members: HashSet<_> = ids.iter().collect();
    let mut remaining = ids.to_vec();
    let mut stages = Vec::new();
    while !remaining.is_empty() {
        let stage: Vec<_> = remaining
            .iter()
            .filter(|id| {
                !project.links.iter().any(|link| {
                    &link.source == *id
                        && members.contains(&link.target)
                        && remaining.contains(&link.target)
                })
            })
            .cloned()
            .collect();
        ensure!(
            !stage.is_empty(),
            "Startup dependency cycle among: {}",
            remaining.join(", ")
        );
        remaining.retain(|id| !stage.contains(id));
        stages.push(stage);
    }
    Ok(stages)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    pub plan: ActionPlan,
    pub results: Vec<TaskResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub session_id: String,
    pub outcome: TaskOutcome,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskOutcome {
    Started,
    Reused,
    Passed,
    Failed,
    /// A validator whose terminal the user stopped, or the one running when
    /// the validation was stopped.
    Stopped,
    /// A validator that never ran because the validation was stopped.
    Cancelled,
}

/// How a validator's run ended.
enum Exit {
    Code(i32),
    Stopped,
    Cancelled,
}

/// Environments are per task: the same group runs separately in each worktree.
fn environment_key(group_id: &str, task: Option<&str>) -> String {
    match task {
        Some(task) => format!("{group_id}{TASK_SEPARATOR}{task}"),
        None => group_id.to_string(),
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Run {
    id: String,
    generation: u64,
}
struct Active {
    key: String,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
struct State {
    epoch: u64,
    active: Option<Active>,
    stopping: bool,
    environments: BTreeMap<String, Vec<Run>>,
}

/// Runs one coordinated operation at a time. Groups share managed sessions;
/// manually started sessions are reused but never owned or stopped by a group.
#[derive(Default)]
pub struct GraphActions(Mutex<State>);

impl GraphActions {
    /// The project generation; [`Self::reset`] bumps it. Callers read it
    /// before doing slow work so a project switch in between is detected.
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.0.lock().unwrap().epoch
    }

    /// Run a planned action: start a group's development terminals stage by
    /// stage, waiting for readiness, or run validators one at a time. A failed
    /// start stops what this attempt launched. A stopped validation returns the
    /// results so far (see [`Self::cancel_validation`]).
    ///
    /// # Errors
    /// Fails if the project changed since `epoch`, another action is running,
    /// the plan no longer builds, a terminal can't start, or (for a group) a
    /// task exits, times out on readiness or is cancelled before it's ready.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn execute(
        &self,
        project: &Project,
        plan: ActionPlan,
        epoch: u64,
        pty: &Arc<PtyManager>,
        sink: Arc<dyn EventSink>,
    ) -> Result<ActionReport> {
        // Rebuild against the current map; callers may have edited it since previewing.
        let plan = ActionPlan::build(project, plan.request, plan.task.as_deref())?;
        // Resolve every launch before running any commands.
        let stages = plan.specs(project)?;
        let (key, environment, timeout) = match &plan.request {
            ActionRequest::StartGroup { group_id } => {
                let group = project.groups.iter().find(|g| &g.id == group_id).unwrap();
                let environment = environment_key(group_id, plan.task.as_deref());
                (
                    format!("group:{environment}"),
                    Some(environment),
                    Duration::from_secs(group.readiness_timeout_seconds),
                )
            }
            ActionRequest::ValidateAffected { component_id } => {
                (format!("validation:{component_id}"), None, Duration::ZERO)
            }
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.0.lock().unwrap();
            ensure!(
                state.epoch == epoch,
                "Project changed before action started"
            );
            ensure!(
                state.active.is_none() && !state.stopping,
                "Another graph action is still running or stopping"
            );
            if environment.is_none() {
                for id in &plan.sessions {
                    ensure!(
                        !pty.is_running(id),
                        "Validation terminal {id} is already running"
                    );
                }
            }
            state.active = Some(Active {
                key,
                cancelled: cancelled.clone(),
            });
        }
        let mut launched = Vec::new();
        let mut acquired = Vec::new();
        let mut participating = Vec::new();
        let mut result = (|| {
            let mut results = Vec::new();
            for stage in stages {
                let mut waits = Vec::new();
                for spec in stage {
                    if environment.is_none() && cancelled.load(Ordering::SeqCst) {
                        // Stopped by the user: report what's left as not run.
                        // A project reset changes the epoch and fails instead.
                        ensure!(self.epoch() == epoch, "Graph action cancelled");
                        results.push(TaskResult {
                            session_id: spec.id,
                            outcome: TaskOutcome::Cancelled,
                            exit_code: None,
                        });
                        continue;
                    }
                    check_cancelled(&cancelled)?;
                    check_environment_running(pty, &participating)?;
                    let id = spec.id.clone();
                    let ready = spec.ready_when.trim().to_string();
                    let session = id.clone();
                    let launched_run = loop {
                        // Stop/reset cannot interleave between spawning and recording ownership.
                        let mut state = self.0.lock().unwrap();
                        if cancelled.load(Ordering::SeqCst) {
                            // A stopped validation keeps its report, as above.
                            if environment.is_none() && state.epoch == epoch {
                                break None;
                            }
                            bail!("Graph action cancelled");
                        }
                        if state.stopping {
                            drop(state);
                            std::thread::sleep(Duration::from_millis(20));
                            continue;
                        }
                        let existing = pty.snapshot(&id).filter(|s| s.running);
                        let reused = existing.is_some();
                        if let Some(snapshot) = &existing {
                            ensure!(
                                environment.is_some(),
                                "Validation terminal {id} is already running"
                            );
                            ensure!(!snapshot.status.stopped, "Terminal {id} is still stopping");
                            ensure!(
                                pty.launch_matches(&spec),
                                "Terminal {id} configuration changed; restart it before starting this environment"
                            );
                        } else {
                            pty.spawn_managed(spec, sink.clone())?;
                        }
                        let snapshot = pty
                            .snapshot(&id)
                            .ok_or_else(|| anyhow!("No snapshot for {id}"))?;
                        if let Some(existing) = existing {
                            ensure!(
                                existing.generation == snapshot.generation,
                                "Terminal {id} was restarted during startup"
                            );
                        }
                        let run = Run {
                            id,
                            generation: snapshot.generation,
                        };
                        if !reused {
                            launched.push(run.clone());
                        }
                        if let Some(group) = &environment {
                            let managed = !reused
                                || state.environments.values().any(|runs| runs.contains(&run));
                            if managed {
                                let runs = state.environments.entry(group.clone()).or_default();
                                if !runs.contains(&run) {
                                    runs.push(run.clone());
                                    acquired.push(run.clone());
                                }
                            }
                        }
                        break Some((run, reused));
                    };
                    let Some((run, reused)) = launched_run else {
                        results.push(TaskResult {
                            session_id: session,
                            outcome: TaskOutcome::Cancelled,
                            exit_code: None,
                        });
                        continue;
                    };
                    if environment.is_some() {
                        participating.push(run.clone());
                        results.push(TaskResult {
                            session_id: run.id.clone(),
                            outcome: if reused {
                                TaskOutcome::Reused
                            } else {
                                TaskOutcome::Started
                            },
                            exit_code: None,
                        });
                        waits.push((run, ready));
                    } else {
                        let (outcome, exit_code) = match wait_for_exit(pty, &run, &cancelled)? {
                            Exit::Code(0) => (TaskOutcome::Passed, Some(0)),
                            Exit::Code(code) => (TaskOutcome::Failed, Some(code)),
                            Exit::Stopped => (TaskOutcome::Stopped, None),
                            Exit::Cancelled => {
                                ensure!(self.epoch() == epoch, "Graph action cancelled");
                                pty.stop_generation(&run.id, run.generation)?;
                                (TaskOutcome::Stopped, None)
                            }
                        };
                        results.push(TaskResult {
                            session_id: run.id,
                            outcome,
                            exit_code,
                        });
                    }
                }
                if environment.is_some() {
                    let deadline = Instant::now() + timeout;
                    for (run, ready) in &waits {
                        wait_for_readiness(pty, run, ready, deadline, &cancelled, &participating)?;
                    }
                }
            }
            if environment.is_some() {
                check_cancelled(&cancelled)?;
                check_environment_running(pty, &participating)?;
            }
            Ok(ActionReport { plan, results })
        })();
        if result.is_err() {
            let rollback = {
                let mut state = self.0.lock().unwrap();
                if let Some(group) = &environment
                    && let Some(runs) = state.environments.get_mut(group)
                {
                    runs.retain(|run| !acquired.contains(run));
                }
                let mut rollback = launched.clone();
                // A different group may have stopped while this one was starting.
                // Release reused sessions too if this attempt was their last owner.
                rollback.extend(
                    acquired
                        .iter()
                        .filter(|run| {
                            !launched.contains(run)
                                && !state.environments.values().any(|runs| runs.contains(run))
                        })
                        .cloned(),
                );
                rollback
            };
            let mut failures = Vec::new();
            for run in rollback.iter().rev() {
                if let Err(error) = pty.stop_generation(&run.id, run.generation) {
                    failures.push(error.to_string());
                    // Preserve a retryable owner when cleanup did not finish.
                    let mut state = self.0.lock().unwrap();
                    if state.epoch == epoch
                        && let Some(group) = &environment
                    {
                        state
                            .environments
                            .entry(group.clone())
                            .or_default()
                            .push(run.clone());
                    }
                }
            }
            if !failures.is_empty() {
                result = Err(anyhow!(
                    "{}; rollback incomplete: {}",
                    result.unwrap_err(),
                    failures.join("; ")
                ));
            }
        }
        self.0.lock().unwrap().active = None;
        result
    }

    /// Stop the running validation: the validator in progress is stopped,
    /// the rest are reported as cancelled. Returns whether one was running.
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    pub fn cancel_validation(&self) -> bool {
        let state = self.0.lock().unwrap();
        let Some(active) = state
            .active
            .as_ref()
            .filter(|a| a.key.starts_with("validation:"))
        else {
            return false;
        };
        active.cancelled.store(true, Ordering::SeqCst);
        true
    }

    /// Cancel in-flight startup and stop owned sessions in reverse startup order.
    ///
    /// # Errors
    /// Fails if the project changed since `epoch`, another environment is
    /// stopping, or a terminal doesn't finish stopping (it stays owned, so
    /// stopping again retries).
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    pub fn stop_group(
        &self,
        group_id: &str,
        task: Option<&str>,
        epoch: u64,
        pty: &PtyManager,
    ) -> Result<()> {
        let group_id = environment_key(group_id, task);
        let group_id = group_id.as_str();
        let runs = {
            let mut state = self.0.lock().unwrap();
            ensure!(state.epoch == epoch, "Project changed before stop started");
            ensure!(!state.stopping, "An environment is already stopping");
            if let Some(active) = &state.active
                && active.key == format!("group:{group_id}")
            {
                active.cancelled.store(true, Ordering::SeqCst);
            }
            state.stopping = true;
            let mut runs = state.environments.remove(group_id).unwrap_or_default();
            runs.retain(|run| !state.environments.values().any(|other| other.contains(run)));
            runs
        };
        let mut failures = Vec::new();
        let mut unfinished = Vec::new();
        for run in runs.iter().rev() {
            if let Err(error) = pty.stop_generation(&run.id, run.generation) {
                failures.push(error.to_string());
                unfinished.push(run.clone());
            }
        }
        let mut state = self.0.lock().unwrap();
        if state.epoch == epoch && !unfinished.is_empty() {
            unfinished.reverse();
            state
                .environments
                .entry(group_id.to_string())
                .or_default()
                .extend(unfinished);
        }
        state.stopping = false;
        ensure!(
            failures.is_empty(),
            "Environment did not finish stopping: {}",
            failures.join("; ")
        );
        Ok(())
    }

    /// Cancel actions before resetting terminals so delayed workers cannot spawn in a new project.
    /// Returns [`PtyManager::reset`]'s generation floor.
    ///
    /// # Panics
    /// Panics if the internal lock is poisoned.
    pub fn reset(&self, pty: &PtyManager) -> u64 {
        let mut state = self.0.lock().unwrap();
        state.epoch += 1;
        if let Some(active) = &state.active {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        state.environments.clear();
        pty.reset()
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    ensure!(!cancelled.load(Ordering::SeqCst), "Graph action cancelled");
    Ok(())
}

fn snapshot_run(pty: &PtyManager, run: &Run) -> Result<crate::pty::Snapshot> {
    let snapshot = pty
        .snapshot(&run.id)
        .ok_or_else(|| anyhow!("Session {} disappeared", run.id))?;
    ensure!(
        snapshot.generation == run.generation,
        "Session {} was restarted",
        run.id
    );
    ensure!(!snapshot.status.stopped, "Session {} was stopped", run.id);
    Ok(snapshot)
}

fn wait_for_exit(pty: &PtyManager, run: &Run, cancelled: &AtomicBool) -> Result<Exit> {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(Exit::Cancelled);
        }
        let snapshot = pty
            .snapshot(&run.id)
            .ok_or_else(|| anyhow!("Session {} disappeared", run.id))?;
        ensure!(
            snapshot.generation == run.generation,
            "Session {} was restarted",
            run.id
        );
        // A validator the user stopped doesn't fail the others.
        if snapshot.status.stopped {
            return Ok(Exit::Stopped);
        }
        if !snapshot.running {
            return Ok(Exit::Code(snapshot.exit_code.unwrap_or(-1)));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn check_environment_running(pty: &PtyManager, runs: &[Run]) -> Result<()> {
    for run in runs {
        let snapshot = snapshot_run(pty, run)?;
        ensure!(
            snapshot.running,
            "Development terminal {} exited before startup completed (exit {:?})",
            run.id,
            snapshot.exit_code
        );
    }
    Ok(())
}

fn wait_for_readiness(
    pty: &PtyManager,
    run: &Run,
    ready: &str,
    deadline: Instant,
    cancelled: &AtomicBool,
    participating: &[Run],
) -> Result<()> {
    loop {
        check_cancelled(cancelled)?;
        check_environment_running(pty, participating)?;
        let snapshot = snapshot_run(pty, run)?;
        if !snapshot.running {
            bail!(
                "Development terminal {} exited before startup completed (exit {:?})",
                run.id,
                snapshot.exit_code
            );
        }
        // Empty means no configured readiness gate; do not infer one from URLs.
        if ready.is_empty() || snapshot.status.ready {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "Timed out waiting for {} to report: {ready}",
            run.id
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TerminalKind;
    use serde_json::json;

    fn project() -> Project {
        serde_json::from_value(json!({
            "name": "shop", "root": "/tmp",
            "components": [
                {"id":"web","name":"Web","path":".","terminals":[
                    {"id":"dev","name":"Dev","kind":"task","command":"sleep 30","action":"development"},
                    {"id":"check","name":"Check","kind":"task","command":"exit 0","action":"validation"}
                ]},
                {"id":"api","name":"API","path":".","terminals":[
                    {"id":"dev","name":"Dev","kind":"task","command":"printf 'ready\\n'; sleep 30","readyWhen":"READY","action":"development"},
                    {"id":"check","name":"Check","kind":"task","command":"exit 3","action":"validation"}
                ]},
                {"id":"lib","name":"Library","path":".","terminals":[]}
            ],
            "links": [
                {"id":"web-api","source":"web","target":"api"},
                {"id":"api-lib","source":"api","target":"lib"},
                {"id":"web-lib","source":"web","target":"lib"}
            ],
            "groups":[{"id":"dev","name":"Development","componentIds":["web","api","lib"],"orderedStartup":true}]
        })).unwrap()
    }

    fn build(project: &Project, request: ActionRequest) -> Result<ActionPlan> {
        ActionPlan::build(project, request, None)
    }

    fn start() -> ActionRequest {
        ActionRequest::StartGroup {
            group_id: "dev".into(),
        }
    }

    #[test]
    fn old_maps_default_to_manual_tasks_and_no_groups() {
        let p: Project = serde_json::from_value(json!({"name":"old","components":[{
            "id":"api","name":"API","path":".","terminals":[{
                "id":"dev","name":"Dev","kind":"task","command":"npm run dev"
            }]
        }]}))
        .unwrap();
        assert!(p.groups.is_empty());
        assert_eq!(p.components[0].terminals[0].action, None);
        assert!(build(&p, start()).is_err());
    }

    #[test]
    fn configuration_round_trips_and_rejects_invalid_members_and_roles() {
        let mut p = project();
        let encoded = serde_json::to_string(&p).unwrap();
        let decoded: Project = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.groups[0].readiness_timeout_seconds, 30);
        assert_eq!(
            decoded.components[0].terminals[0].action,
            Some(TerminalAction::Development)
        );
        p.groups[0].component_ids.push("missing".into());
        assert!(p.validate().is_err());
        p.groups[0].component_ids.pop();
        p.groups[0].component_ids.push("web".into());
        assert!(p.validate().is_err());
        p.groups[0].component_ids.pop();
        // A half-configured role only fails the action, never the whole map.
        p.components[0].terminals[0].kind = TerminalKind::Shell;
        assert!(p.validate().is_ok());
        assert!(build(&p, start()).is_err());
        p.components[0].terminals[0].kind = TerminalKind::Task;
        p.components[0].terminals[0].command.clear();
        assert!(p.validate().is_ok());
        let error = build(&p, start()).unwrap_err().to_string();
        assert!(
            error.contains("needs to be a task with a command"),
            "{error}"
        );
        p.components[0].terminals[0].command = "sleep 30".into();
        p.groups[0].readiness_timeout_seconds = 0;
        assert!(p.validate().is_ok());
        assert!(build(&p, start()).is_err());
    }

    #[test]
    fn task_plans_use_task_session_ids() {
        let plan = ActionPlan::build(&project(), start(), Some("t1")).unwrap();
        assert_eq!(plan.sessions, ["api/dev@task-t1", "web/dev@task-t1"]);
        assert_eq!(environment_key("dev", Some("t1")), "dev@task-t1");
        assert_eq!(environment_key("dev", None), "dev");
    }

    #[test]
    fn startup_is_ordered_only_when_configured_and_stays_inside_group() {
        let mut p = project();
        let plan = build(&p, start()).unwrap();
        assert_eq!(plan.stages, [vec!["lib"], vec!["api"], vec!["web"]]);
        assert_eq!(plan.skipped, ["lib"]);
        p.groups[0].ordered_startup = false;
        assert_eq!(
            build(&p, start()).unwrap().stages,
            [vec!["web", "api", "lib"]]
        );
        p.groups[0].component_ids = vec!["web".into()];
        p.groups[0].ordered_startup = true;
        assert_eq!(build(&p, start()).unwrap().sessions, ["web/dev"]);
    }

    #[test]
    fn ordering_cycles_fail_and_validation_deduplicates_diamonds_and_cycles() {
        let mut p = project();
        p.links.push(crate::Link {
            id: "cycle".into(),
            source: "lib".into(),
            target: "web".into(),
            label: None,
        });
        assert!(
            build(&p, start())
                .unwrap_err()
                .to_string()
                .contains("cycle")
        );
        let plan = build(
            &p,
            ActionRequest::ValidateAffected {
                component_id: "lib".into(),
            },
        )
        .unwrap();
        assert_eq!(plan.sessions, ["api/check", "web/check"]);
        assert_eq!(plan.skipped, ["lib"]);
        assert_eq!(plan.component_ids(), ["lib", "api", "web"]);
    }

    #[cfg(unix)]
    mod execution {
        use super::*;
        use crate::TerminalEvent;
        use std::sync::atomic::AtomicU64;
        struct Fixture {
            project: Project,
            pty: Arc<PtyManager>,
            actions: Arc<GraphActions>,
        }
        struct Silent;
        impl EventSink for Silent {
            fn emit(&self, _: TerminalEvent) {}
        }
        impl Fixture {
            fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(0);
                let root = std::env::temp_dir().join(format!(
                    "patchbay-actions-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&root).unwrap();
                let mut project = project();
                project.root = root.canonicalize().unwrap().display().to_string();
                Self {
                    project,
                    pty: Arc::new(PtyManager::new()),
                    actions: Arc::new(GraphActions::default()),
                }
            }
            fn run(&self, request: ActionRequest) -> Result<ActionReport> {
                let plan = build(&self.project, request)?;
                self.actions.execute(
                    &self.project,
                    plan,
                    self.actions.epoch(),
                    &self.pty,
                    Arc::new(Silent),
                )
            }
            fn start_in_thread(&self) -> std::thread::JoinHandle<Result<ActionReport>> {
                let project = self.project.clone();
                let pty = self.pty.clone();
                let actions = self.actions.clone();
                let epoch = actions.epoch();
                std::thread::spawn(move || {
                    actions.execute(
                        &project,
                        build(&project, start())?,
                        epoch,
                        &pty,
                        Arc::new(Silent),
                    )
                })
            }
            fn wait_running(&self, id: &str) {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !self.pty.is_running(id) {
                    assert!(Instant::now() < deadline, "{id} never started");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                self.actions.reset(&self.pty);
                let _ = std::fs::remove_dir_all(&self.project.root);
            }
        }

        #[test]
        fn readiness_gates_consumers_and_shared_groups_release_the_last_owner() {
            let mut f = Fixture::new();
            f.project.components[1].terminals[0].command =
                "sleep 0.2; touch ready; printf '\\033[32mREADY\\033[0m\\n'; sleep 30".into();
            f.project.components[0].terminals[0].command =
                "test -f ready || exit 7; sleep 30".into();
            let report = f.run(start()).unwrap();
            assert_eq!(report.results.len(), 2);
            assert!(f.pty.snapshot("api/dev").unwrap().status.ready);
            assert!(f.pty.is_running("web/dev"));
            let mut second = f.project.groups[0].clone();
            second.id = "second".into();
            f.project.groups.push(second);
            let report = f
                .run(ActionRequest::StartGroup {
                    group_id: "second".into(),
                })
                .unwrap();
            assert!(
                report
                    .results
                    .iter()
                    .all(|r| matches!(r.outcome, TaskOutcome::Reused))
            );
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            assert!(f.pty.is_running("api/dev"));
            f.actions.stop_group("second", None, 0, &f.pty).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while f.pty.is_running("api/dev") || f.pty.is_running("web/dev") {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        #[test]
        fn readiness_timeout_does_not_accept_a_url_and_rolls_back_new_tasks() {
            let mut f = Fixture::new();
            f.project.groups[0].readiness_timeout_seconds = 1;
            f.project.components[1].terminals[0].command =
                "printf 'http://localhost:9999\\n'; sleep 30".into();
            let error = f.run(start()).unwrap_err().to_string();
            assert!(error.contains("Timed out"), "{error}");
            assert!(!f.pty.is_running("api/dev"));
            assert!(f.pty.snapshot("web/dev").is_none());
        }

        #[test]
        fn startup_early_exit_stops_before_consumers_and_preserves_manual_sessions() {
            let mut f = Fixture::new();
            // A manually launched API is reused and must survive stopping the group.
            f.pty
                .spawn(
                    context::session_spec(&f.project, "api", "dev", &AllowAll, &[]).unwrap(),
                    Arc::new(Silent),
                )
                .unwrap();
            f.run(start()).unwrap();
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            assert!(f.pty.is_running("api/dev"));
            f.actions.reset(&f.pty);
            f.project.components[1].terminals[0].command = "exit 2".into();
            assert!(
                f.run(start())
                    .unwrap_err()
                    .to_string()
                    .contains("exited before")
            );
            assert!(f.pty.snapshot("web/dev").is_none());
        }

        #[test]
        fn a_ready_task_exiting_during_other_tasks_startup_rolls_back_the_environment() {
            for ordered in [true, false] {
                let mut f = Fixture::new();
                f.project.groups[0].ordered_startup = ordered;
                f.project.components[1].terminals[0].command =
                    "printf 'READY\\n'; sleep 0.3; exit 7".into();
                f.project.components[0].terminals[0].command =
                    "sleep 1; printf 'WEB READY\\n'; cat".into();
                f.project.components[0].terminals[0].ready_when = "WEB READY".into();
                let error = f.run(start()).unwrap_err().to_string();
                assert!(
                    error.contains("api/dev") && error.contains("exited"),
                    "{error}"
                );
                assert!(!f.pty.is_running("api/dev"));
                assert!(!f.pty.is_running("web/dev"));
                assert!(f.pty.snapshot("web/dev").unwrap().status.stopped);
            }
        }

        #[test]
        fn stop_and_project_reset_cancel_pending_startup() {
            let mut f = Fixture::new();
            f.project.components[1].terminals[0].command = "sleep 30".into();
            let worker = f.start_in_thread();
            f.wait_running("api/dev");
            assert!(f.run(start()).is_err());
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            assert!(worker.join().unwrap().is_err());
            assert!(f.pty.snapshot("web/dev").is_none());
            let worker = f.start_in_thread();
            f.wait_running("api/dev");
            f.actions.reset(&f.pty);
            assert!(worker.join().unwrap().is_err());
            assert!(f.pty.snapshot("web/dev").is_none());
            assert!(
                f.actions
                    .execute(
                        &f.project,
                        build(&f.project, start()).unwrap(),
                        0,
                        &f.pty,
                        Arc::new(Silent)
                    )
                    .is_err()
            );
        }

        #[test]
        fn validators_continue_after_failures_and_skip_unconfigured_components() {
            let f = Fixture::new();
            let report = f
                .run(ActionRequest::ValidateAffected {
                    component_id: "lib".into(),
                })
                .unwrap();
            assert_eq!(report.plan.skipped, ["lib"]);
            assert_eq!(report.results.len(), 2);
            assert!(matches!(report.results[0].outcome, TaskOutcome::Failed));
            assert_eq!(report.results[0].exit_code, Some(3));
            assert!(matches!(report.results[1].outcome, TaskOutcome::Passed));
        }

        #[test]
        fn stopping_a_validation_keeps_its_results() {
            let mut f = Fixture::new();
            f.project.components[1].terminals[1].command = "exit 0".into();
            f.project.components[0].terminals[1].command = "sleep 30".into();
            let mut extra = f.project.components[0].clone();
            extra.id = "app".into();
            extra.terminals[1].command = "exit 0".into();
            f.project.components.push(extra);
            f.project.links.push(crate::Link {
                id: "app-web".into(),
                source: "app".into(),
                target: "web".into(),
                label: None,
            });
            let worker = {
                let project = f.project.clone();
                let actions = f.actions.clone();
                let pty = f.pty.clone();
                std::thread::spawn(move || {
                    let request = ActionRequest::ValidateAffected {
                        component_id: "lib".into(),
                    };
                    actions.execute(
                        &project,
                        build(&project, request)?,
                        0,
                        &pty,
                        Arc::new(Silent),
                    )
                })
            };
            f.wait_running("web/check");
            assert!(f.actions.cancel_validation());
            let report = worker.join().unwrap().unwrap();
            let outcomes: Vec<_> = report
                .results
                .iter()
                .map(|r| (r.session_id.as_str(), r.outcome))
                .collect();
            assert!(matches!(
                outcomes[..],
                [
                    ("api/check", TaskOutcome::Passed),
                    ("web/check", TaskOutcome::Stopped),
                    ("app/check", TaskOutcome::Cancelled)
                ]
            ));
            assert!(!f.pty.is_running("web/check"));
            assert!(f.pty.snapshot("app/check").is_none());
            assert!(!f.actions.cancel_validation());
        }

        #[test]
        fn a_validator_stopped_by_the_user_does_not_end_the_validation() {
            let mut f = Fixture::new();
            f.project.components[1].terminals[1].command = "sleep 30".into();
            let worker = {
                let project = f.project.clone();
                let actions = f.actions.clone();
                let pty = f.pty.clone();
                std::thread::spawn(move || {
                    let request = ActionRequest::ValidateAffected {
                        component_id: "lib".into(),
                    };
                    actions.execute(
                        &project,
                        build(&project, request)?,
                        0,
                        &pty,
                        Arc::new(Silent),
                    )
                })
            };
            f.wait_running("api/check");
            f.pty.kill("api/check");
            let report = worker.join().unwrap().unwrap();
            assert!(matches!(report.results[0].outcome, TaskOutcome::Stopped));
            assert!(matches!(report.results[1].outcome, TaskOutcome::Passed));
        }

        #[test]
        fn running_validator_is_rejected_before_other_tasks_launch() {
            let mut f = Fixture::new();
            f.project.components[0].terminals[1].command = "sleep 30".into();
            f.pty
                .spawn(
                    context::session_spec(&f.project, "web", "check", &AllowAll, &[]).unwrap(),
                    Arc::new(Silent),
                )
                .unwrap();
            assert!(
                f.run(ActionRequest::ValidateAffected {
                    component_id: "lib".into()
                })
                .is_err()
            );
            assert!(f.pty.snapshot("api/check").is_none());
        }

        #[test]
        fn failed_shared_start_releases_new_ownership() {
            let mut f = Fixture::new();
            f.run(start()).unwrap();
            let mut second = f.project.groups[0].clone();
            second.id = "second".into();
            f.project.groups.push(second);
            // The API is reused before the changed web configuration fails.
            f.project.components[0].terminals[0].command = "sleep 29".into();
            assert!(
                f.run(ActionRequest::StartGroup {
                    group_id: "second".into()
                })
                .is_err()
            );
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            assert!(
                !f.pty.is_running("api/dev"),
                "failed group retained a shared owner"
            );
        }

        #[test]
        fn unordered_groups_still_wait_for_explicit_readiness() {
            let mut f = Fixture::new();
            f.project.groups[0].ordered_startup = false;
            f.project.groups[0].readiness_timeout_seconds = 1;
            f.project.components[1].terminals[0].command = "sleep 30".into();
            assert!(
                f.run(start())
                    .unwrap_err()
                    .to_string()
                    .contains("Timed out")
            );
            assert!(f.pty.snapshot("web/dev").unwrap().status.stopped);
            assert!(!f.pty.is_running("api/dev"));
        }

        #[test]
        fn changed_readiness_cannot_reuse_a_manual_runs_ready_status() {
            let mut f = Fixture::new();
            f.pty
                .spawn(
                    context::session_spec(&f.project, "api", "dev", &AllowAll, &[]).unwrap(),
                    Arc::new(Silent),
                )
                .unwrap();
            f.project.components[1].terminals[0].ready_when = "a different gate".into();
            let error = f.run(start()).unwrap_err().to_string();
            assert!(error.contains("configuration changed"), "{error}");
            assert!(f.pty.is_running("api/dev"));
            assert!(f.pty.snapshot("web/dev").is_none());
        }

        #[test]
        fn group_stop_escalates_and_never_signals_a_newer_generation() {
            let mut f = Fixture::new();
            f.project.groups[0].component_ids = vec!["api".into()];
            f.project.components[1].terminals[0].command =
                "trap '' HUP; printf 'READY\\n'; cat".into();
            f.run(start()).unwrap();
            let generation = f.pty.snapshot("api/dev").unwrap().generation;
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            assert!(
                !f.pty.is_running("api/dev"),
                "Stop returned before the process exited"
            );
            assert!(
                !f.pty.snapshot("api/dev").unwrap().running,
                "Stop returned before the terminal lifecycle completed"
            );
            f.run(start()).unwrap();
            f.pty.stop_generation("api/dev", generation).unwrap();
            assert!(f.pty.is_running("api/dev"));
            assert!(f.pty.snapshot("api/dev").unwrap().generation > generation);
        }

        #[test]
        fn startup_waits_before_reusing_a_run_selected_for_shutdown() {
            let mut f = Fixture::new();
            let mut stubborn = f.project.components[1].clone();
            stubborn.id = "stubborn".into();
            stubborn.terminals[0].command =
                "trap '' HUP; printf 'READY\\n'; while :; do sleep 1; done".into();
            f.project.components.push(stubborn);
            f.project.components[0].terminals[0].command =
                "sleep 0.3; printf 'READY\\n'; cat".into();
            f.project.components[0].terminals[0].ready_when = "READY".into();
            f.project.components[1].terminals[0].command = "printf 'READY\\n'; cat".into();
            f.project.links = serde_json::from_value(serde_json::json!([
                {"id":"one", "source":"stubborn", "target":"api"},
                {"id":"two", "source":"api", "target":"web"}
            ]))
            .unwrap();
            f.project.groups[0].component_ids = vec!["api".into(), "stubborn".into()];
            f.run(start()).unwrap();
            let generation = f.pty.snapshot("api/dev").unwrap().generation;
            let mut second = f.project.groups[0].clone();
            second.id = "second".into();
            second.component_ids = vec!["api".into(), "web".into()];
            f.project.groups.push(second);
            let worker = {
                let project = f.project.clone();
                let actions = f.actions.clone();
                let pty = f.pty.clone();
                std::thread::spawn(move || {
                    actions.execute(
                        &project,
                        build(
                            &project,
                            ActionRequest::StartGroup {
                                group_id: "second".into(),
                            },
                        )?,
                        0,
                        &pty,
                        Arc::new(Silent),
                    )
                })
            };
            f.wait_running("web/dev");
            f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
            worker.join().unwrap().unwrap();
            assert!(f.pty.is_running("api/dev"));
            assert!(f.pty.snapshot("api/dev").unwrap().generation > generation);
            f.actions.stop_group("second", None, 0, &f.pty).unwrap();
            assert!(!f.pty.is_running("api/dev"));
        }

        #[test]
        fn stop_and_rollback_clean_up_background_workers_after_the_shell_exits() {
            for rollback in [false, true] {
                let mut f = Fixture::new();
                f.project.components[1].terminals[0].command =
                    "sh -c 'trap \"\" HUP; echo $$ > worker.pid; printf \"READY\\n\"; while :; do sleep 1; done' & wait".into();
                if rollback {
                    f.project.components[0].terminals[0].command = "exit 7".into();
                    f.project.components[0].terminals[0].ready_when = "WEB READY".into();
                    assert!(f.run(start()).is_err());
                } else {
                    f.project.groups[0].component_ids = vec!["api".into()];
                    f.run(start()).unwrap();
                    f.actions.stop_group("dev", None, 0, &f.pty).unwrap();
                }
                let pid = std::fs::read_to_string(
                    std::path::Path::new(&f.project.root).join("worker.pid"),
                )
                .unwrap()
                .trim()
                .parse::<u32>()
                .unwrap();
                let mut system = sysinfo::System::new();
                let pid = sysinfo::Pid::from_u32(pid);
                system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
                assert!(
                    system.process(pid).is_none_or(|process| matches!(
                        process.status(),
                        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
                    )),
                    "background worker survived {}",
                    if rollback { "rollback" } else { "Stop" }
                );
            }
        }

        #[test]
        fn saved_groups_and_task_roles_survive_loading_the_project() {
            let f = Fixture::new();
            f.project.save().unwrap();
            let loaded = Project::load(std::path::Path::new(&f.project.root))
                .unwrap()
                .unwrap();
            assert_eq!(loaded.groups[0].component_ids, ["web", "api", "lib"]);
            assert!(loaded.groups[0].ordered_startup);
            assert_eq!(
                loaded.components[0].terminals[1].action,
                Some(TerminalAction::Validation)
            );
            assert_eq!(loaded.schema_version, crate::model::SCHEMA_VERSION);
            let file = std::path::Path::new(&f.project.root).join(crate::model::PROJECT_FILE);
            let text = std::fs::read_to_string(&file).unwrap().replacen(
                &format!("\"schemaVersion\": {}", crate::model::SCHEMA_VERSION),
                "\"schemaVersion\": 99",
                1,
            );
            std::fs::write(&file, text).unwrap();
            let error = Project::load(std::path::Path::new(&f.project.root))
                .unwrap_err()
                .to_string();
            assert!(error.contains("newer Patchbay"), "{error}");
        }
    }
}
