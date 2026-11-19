//! Agents set up run & test themselves: when an agent validates or starts an environment
//! in a project that has neither been detected nor has checks (or stacks) to run, Patchbay
//! starts run & test detection (`stack_proposals.rs`), the desktop applies its proposal
//! without review (with Undo), and the agent's request continues with the new
//! configuration. Agents in several worktrees asking at once join the same detection.
use crate::actions::{ActionPlan, ActionRequest};
use crate::agent_bridge::{LaunchContext, progress};
use crate::agent_commands::Host;
use crate::model::Project;
use crate::session::Request;
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// How long an agent's request waits for detection and its application.
pub const TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long worktree setup may run before the request continues without it.
pub const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a finished detection session may wait for the desktop's report.
const ENDED_GRACE: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(5);
const PROGRESS_EVERY: Duration = Duration::from_secs(30);

/// What the desktop did with an automatic detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// Applied to the map; `setup` is the worktree preparation it enabled, if any.
    Applied {
        #[serde(default)]
        setup: Option<String>,
    },
    /// Left for the user's review (map recovery, a save conflict, another project open).
    Review { reason: String },
    /// Detection couldn't start or finish.
    Failed { reason: String },
}

struct Entry {
    generation: u64,
    started: Instant,
    outcome: Option<Outcome>,
}

#[derive(Default)]
struct Registry {
    next: u64,
    entries: HashMap<String, Entry>,
}

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);
static CHANGED: Condvar = Condvar::new();

fn registry() -> std::sync::MutexGuard<'static, Option<Registry>> {
    REGISTRY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Join the running detection for `project_id`, or start a new one (`true`). A detection
/// older than [`TIMEOUT`] without an outcome is abandoned.
fn begin(project_id: &str, now: Instant) -> (u64, bool) {
    let mut guard = registry();
    let registry = guard.get_or_insert_with(Registry::default);
    if let Some(entry) = registry.entries.get(project_id)
        && entry.outcome.is_none()
        && now.duration_since(entry.started) < TIMEOUT
    {
        return (entry.generation, false);
    }
    registry.next += 1;
    let generation = registry.next;
    registry.entries.insert(
        project_id.into(),
        Entry {
            generation,
            started: now,
            outcome: None,
        },
    );
    (generation, true)
}

/// Record what the desktop did with the project's automatic detection, waking every agent
/// waiting on it. Returns whether one was waiting.
pub fn finish(project_id: &str, outcome: Outcome) -> bool {
    let mut guard = registry();
    let Some(entry) = guard
        .as_mut()
        .and_then(|r| r.entries.get_mut(project_id))
        .filter(|e| e.outcome.is_none())
    else {
        return false;
    };
    entry.outcome = Some(outcome);
    CHANGED.notify_all();
    true
}

/// Whether an automatic detection is under way for the project.
#[must_use]
pub fn running(project_id: &str) -> bool {
    registry()
        .as_ref()
        .and_then(|r| r.entries.get(project_id))
        .is_some_and(|e| e.outcome.is_none() && e.started.elapsed() < TIMEOUT)
}

/// Wait for generation `generation`'s outcome until `deadline`, calling `tick` between
/// waits; `tick` may give up early with an error.
fn wait(
    project_id: &str,
    generation: u64,
    deadline: Instant,
    mut tick: impl FnMut() -> Result<()>,
) -> Result<Outcome> {
    loop {
        {
            let mut guard = registry();
            let mut waited = false;
            loop {
                let entry = guard
                    .as_ref()
                    .and_then(|r| r.entries.get(project_id))
                    .filter(|e| e.generation == generation);
                match entry {
                    Some(Entry {
                        outcome: Some(outcome),
                        ..
                    }) => return Ok(outcome.clone()),
                    Some(_) => {}
                    None => bail!("Run & test setup was replaced by a newer one; retry"),
                }
                if waited {
                    break;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                guard = CHANGED
                    .wait_timeout(guard, TICK.min(left))
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
                waited = true;
            }
        }
        if Instant::now() >= deadline {
            bail!(
                "Run & test setup didn't finish within {} minutes",
                TIMEOUT.as_secs() / 60
            );
        }
        if let Err(e) = tick() {
            finish(
                project_id,
                Outcome::Failed {
                    reason: e.to_string(),
                },
            );
            return Err(e);
        }
    }
}

/// Whether an agent's `request` should set run & test up first: detection was never
/// applied or declined, and there is nothing to run (no Validation terminal in the
/// validation's plan, or no stack at all for an environment start).
#[must_use]
pub fn needed(
    project: &Project,
    project_id: &str,
    request: &ActionRequest,
    task: Option<&str>,
) -> bool {
    if project.instances.as_ref().is_some_and(|i| i.detected) {
        return false;
    }
    match request {
        ActionRequest::StartGroup { .. } => project.groups.is_empty(),
        _ => ActionPlan::build(project, project_id, request.clone(), task)
            .is_ok_and(|plan| plan.sessions.is_empty()),
    }
}

/// The hint an agent gets when setting up by itself is turned off.
pub const DISABLED_HINT: &str = "Run & test isn't set up for this project. Ask the user to run \"Detect run & test setup\" in the Stack panel, or to turn on \"Let agents set up run & test automatically\" there.";

/// Detect and apply run & test for the launch's project, joining a detection already
/// under way, then run the worktree preparation it enabled in the caller's worktree.
/// Reports progress to the waiting CLI. Returns lines for the agent's report.
///
/// # Errors
/// Fails when detection can't start, ends without an applied proposal, waits for the
/// user's review, or takes longer than [`TIMEOUT`].
pub fn run(app: &impl Host, launch: &LaunchContext, project: &Project) -> Result<Vec<String>> {
    run_within(app, launch, project, TIMEOUT)
}

fn run_within(
    app: &impl Host,
    launch: &LaunchContext,
    project: &Project,
    timeout: Duration,
) -> Result<Vec<String>> {
    let started = Instant::now();
    let (generation, launching) = begin(&launch.project_id, started);
    if launching {
        progress(
            "Setting up run & test for this project: an agent is detecting how to run and test it. This can take a few minutes…",
        );
        if let Err(e) = app.request_setup(launch) {
            finish(
                &launch.project_id,
                Outcome::Failed {
                    reason: e.to_string(),
                },
            );
            return Err(e.context("Patchbay couldn't start run & test detection"));
        }
    } else {
        progress("Waiting for run & test setup already under way for this project…");
    }
    let detection = crate::model::task_session_id(
        &launch.project_id,
        crate::model::MAP_SCOPE,
        crate::stack_proposals::STACK_TERMINAL,
        None,
    );
    let mut reported = started;
    let mut ended: Option<Instant> = None;
    let outcome = wait(&launch.project_id, generation, started + timeout, || {
        let now = Instant::now();
        if now.duration_since(reported) >= PROGRESS_EVERY {
            reported = now;
            progress(&format!(
                "Still setting up run & test ({} min)…",
                now.duration_since(started).as_secs() / 60
            ));
        }
        let snapshot: Option<crate::pty::Snapshot> =
            serde_json::from_value(app.request(Request::Snapshot {
                id: detection.clone(),
                output_limit: Some(0),
            })?)?;
        match snapshot {
            Some(s) if s.running => ended = None,
            Some(_) => {
                let since = *ended.get_or_insert(now);
                if now.duration_since(since) >= ENDED_GRACE {
                    bail!("Run & test detection ended without an applied proposal");
                }
            }
            None if now.duration_since(started) >= ENDED_GRACE => {
                bail!("Patchbay didn't start run & test detection")
            }
            None => {}
        }
        Ok(())
    })?;
    let setup = match outcome {
        Outcome::Applied { setup } => setup,
        Outcome::Review { reason } => {
            bail!(
                "Run & test detection finished, but its proposal waits for the user's review: {reason}"
            )
        }
        Outcome::Failed { reason } => bail!("Run & test setup failed: {reason}"),
    };
    let mut lines = vec![
        "Patchbay set up run & test for this project from an automatic detection; the user can review or undo it."
            .to_string(),
    ];
    if let (Some(command), Some(task)) = (
        setup,
        crate::planning::checkout_task(launch.task.as_deref()),
    ) {
        progress("Running the detected worktree setup in this worktree…");
        let mut call = |request| app.request(request);
        match crate::worktree_setup::run_now(
            project,
            &launch.project_id,
            task,
            &command,
            &mut call,
            SETUP_TIMEOUT,
        ) {
            Ok(setup) if setup.status == crate::worktree_setup::Status::Ready => {
                lines.push(format!(
                    "Worktree setup `{command}` finished in this worktree."
                ));
            }
            Ok(setup) => lines.push(format!(
                "Worktree setup `{command}` didn't finish ({:?}); continuing without it.",
                setup.status
            )),
            Err(e) => lines.push(format!(
                "Worktree setup `{command}` couldn't run: {e:#}; continuing without it."
            )),
        }
    }
    Ok(lines)
}

/// The project as the desktop holds it now, trusted, for a request that continues after
/// setup changed the map.
///
/// # Errors
/// Fails if the project was closed meanwhile.
pub fn reload(app: &impl Host, project_id: &str) -> Result<Project> {
    let scoped = app.project(project_id)?;
    let mut project = scoped
        .project
        .clone()
        .ok_or_else(|| anyhow!("Open the launch project in Patchbay"))?;
    scoped.access.trust(&mut project)?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_join_one_detection_and_a_finished_one_starts_again() {
        let id = format!("join-{}", uuid::Uuid::new_v4());
        let now = Instant::now();
        let (first, launch) = begin(&id, now);
        assert!(launch);
        assert!(running(&id));
        let (joined, launch) = begin(&id, now);
        assert!(!launch);
        assert_eq!(joined, first);
        // A detection that outlived the timeout is abandoned.
        let (stale, launch) = begin(&id, now + TIMEOUT);
        assert!(launch);
        assert_ne!(stale, first);
        assert!(finish(&id, Outcome::Applied { setup: None }));
        assert!(!finish(&id, Outcome::Applied { setup: None }), "only once");
        assert!(!running(&id));
        assert_eq!(
            wait(&id, stale, Instant::now() + TICK, || Ok(())).unwrap(),
            Outcome::Applied { setup: None }
        );
        assert!(wait(&id, first, Instant::now() + TICK, || Ok(())).is_err());
        let (_, launch) = begin(&id, Instant::now());
        assert!(launch, "a later request after an outcome detects again");
    }

    #[test]
    fn waiting_times_out_or_stops_when_a_tick_fails() {
        let id = format!("wait-{}", uuid::Uuid::new_v4());
        let (generation, _) = begin(&id, Instant::now());
        let err = wait(&id, generation, Instant::now(), || Ok(()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("didn't finish within 15 minutes"), "{err}");
        let err = wait(&id, generation, Instant::now() + TIMEOUT, || bail!("ended"))
            .unwrap_err()
            .to_string();
        assert_eq!(err, "ended");
        // Others waiting on it learn it failed.
        assert!(!running(&id));
    }

    #[test]
    fn setup_is_needed_only_without_checks_or_stacks_and_before_detection() {
        let mut project: Project = serde_json::from_value(serde_json::json!({
            "schemaVersion": 5, "name": "p", "root": "/tmp/p", "links": [],
            "components": [{"id":"api","name":"API","kind":"backend","path":"api","terminals":[
                {"id":"test","name":"Test","kind":"task","command":"npm test"}]}]
        }))
        .unwrap();
        let validate = ActionRequest::ValidateSelected {
            component_ids: vec!["api".into()],
        };
        let start = ActionRequest::StartGroup {
            group_id: "local".into(),
        };
        assert!(needed(&project, "p", &validate, None));
        assert!(needed(&project, "p", &start, Some("t")));
        project.components[0].terminals[0].action = Some(crate::model::TerminalAction::Validation);
        assert!(!needed(&project, "p", &validate, None));
        project.components[0].terminals[0].action = None;
        project.instances = Some(crate::model::Instances {
            detected: true,
            ..Default::default()
        });
        assert!(!needed(&project, "p", &validate, None));
        assert!(!needed(&project, "p", &start, None));
        // Unknown components keep their ordinary error.
        project.instances = None;
        let unknown = ActionRequest::ValidateSelected {
            component_ids: vec!["db".into()],
        };
        assert!(!needed(&project, "p", &unknown, None));
    }

    /// A desktop whose detection ends with `outcome` (or fails to start), and whose detection
    /// session is `running`.
    struct Desktop {
        outcome: Option<Outcome>,
        running: bool,
        launched: Mutex<usize>,
    }
    impl Host for Desktop {
        fn project(&self, _: &str) -> Result<crate::agent_commands::ProjectScope> {
            bail!("unused")
        }
        fn request(&self, request: Request) -> Result<serde_json::Value> {
            assert!(matches!(request, Request::Snapshot { .. }));
            Ok(serde_json::json!({
                "data":"", "end":0, "generation":1, "running":self.running,
                "startedMs":1, "status":crate::status::SessionStatus::default()
            }))
        }
        fn activities(&self) -> Vec<crate::agent_commands::Activity> {
            vec![]
        }
        fn emit_activity(&self, _: &crate::agent_commands::Activity) {}
        fn proposal_submitted(&self, _: &LaunchContext) {}
        fn links_proposed(&self, _: &LaunchContext) {}
        fn stack_proposed(&self, _: &LaunchContext) {}
        fn request_setup(&self, launch: &LaunchContext) -> Result<()> {
            *self.launched.lock().unwrap() += 1;
            let Some(outcome) = self.outcome.clone() else {
                bail!("no agent preset");
            };
            let id = launch.project_id.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                finish(&id, outcome);
            });
            Ok(())
        }
    }
    fn launch() -> LaunchContext {
        LaunchContext {
            generation: None,
            project_id: format!("auto-{}", uuid::Uuid::new_v4()),
            task: None,
            agent_session: "agent".into(),
            role: crate::agent_bridge::Role::Component,
        }
    }
    fn desktop(outcome: Option<Outcome>, running: bool) -> Desktop {
        Desktop {
            outcome,
            running,
            launched: Mutex::new(0),
        }
    }
    fn project() -> Project {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 5, "name": "p", "root": "/tmp/p", "components": [], "links": []
        }))
        .unwrap()
    }

    #[test]
    fn an_applied_detection_continues_the_request() {
        let host = desktop(Some(Outcome::Applied { setup: None }), true);
        let lines = run(&host, &launch(), &project()).unwrap();
        assert!(lines[0].contains("review or undo"), "{lines:?}");
        assert_eq!(*host.launched.lock().unwrap(), 1);
    }

    #[test]
    fn failures_reviews_and_ended_detection_report_why() {
        let l = launch();
        let err = run(&desktop(None, true), &l, &project()).unwrap_err();
        assert!(format!("{err:#}").contains("no agent preset"), "{err:#}");
        assert!(!running(&l.project_id), "joiners learn it failed");
        let review = Outcome::Review {
            reason: "the map has a save conflict".into(),
        };
        let err = run(&desktop(Some(review), true), &launch(), &project()).unwrap_err();
        assert!(
            err.to_string().contains("waits for the user's review"),
            "{err}"
        );
        // A detection whose session ended is given up once its grace has passed.
        struct Ended(Desktop);
        let host = Ended(desktop(Some(Outcome::Applied { setup: None }), false));
        let l = launch();
        let (generation, _) = begin(&l.project_id, Instant::now());
        let mut ended = None;
        let err = wait(&l.project_id, generation, Instant::now() + TIMEOUT, || {
            let now = Instant::now() + ENDED_GRACE;
            let _ = host.0.request(Request::Snapshot {
                id: "x".into(),
                output_limit: Some(0),
            })?;
            let since = *ended.get_or_insert(Instant::now());
            if now.duration_since(since) >= ENDED_GRACE {
                bail!("Run & test detection ended without an applied proposal");
            }
            Ok(())
        })
        .unwrap_err();
        assert!(err.to_string().contains("ended without"), "{err}");
    }
}
