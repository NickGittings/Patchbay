//! Headless orchestration for authenticated agent commands and manual graph actions.
use crate::actions::{ActionPlan, ActionReport, ActionRequest};
use crate::agent_bridge::{Action, LaunchContext};
use crate::session::{Record, Request};
use crate::{Project, access::AccessSnapshot, context, tasks};
use anyhow::Result;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Desktop-owned state supplied at the integration boundary.
pub trait Host {
    /// Snapshot backend-owned permissions and the current configured map.
    ///
    /// # Errors
    /// Fails if the launch project is no longer open.
    fn project(&self, id: &str) -> Result<ProjectScope>;
    /// Send a typed request to the session service.
    ///
    /// # Errors
    /// Fails if the service is unavailable or rejects the request.
    fn request(&self, request: Request) -> Result<Value>;
    fn activities(&self) -> Vec<Activity>;
    fn emit_activity(&self, activity: &Activity);
    fn proposal_submitted(&self, launch: &LaunchContext);
    fn links_proposed(&self, launch: &LaunchContext);
}

pub struct ProjectScope {
    pub access: AccessSnapshot,
    pub project: Option<Project>,
    pub roots: Vec<PathBuf>,
}
impl ProjectScope {
    fn project(&self) -> Result<Project> {
        let mut project = self
            .project
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Open the launch project in Patchbay"))?;
        self.access.trust(&mut project)?;
        Ok(project)
    }
}
fn call<T: DeserializeOwned>(host: &impl Host, request: Request) -> Result<T> {
    Ok(serde_json::from_value(host.request(request)?)?)
}

/// Bounded activity history shared by all windows.
#[derive(Default)]
pub struct ActivityLog(Mutex<Vec<Activity>>);
impl ActivityLog {
    pub fn record(&self, activity: &Activity) {
        let mut activities = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(previous) = activities.iter_mut().find(|a| a.id == activity.id) {
            *previous = activity.clone();
        } else {
            activities.push(activity.clone());
        }
        if activities.len() > 200
            && let Some(index) = activities.iter().position(|a| a.state != "running")
        {
            activities.remove(index);
        }
    }
    #[must_use]
    pub fn list(&self) -> Vec<Activity> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Move a trusted, restricted project into its stored task worktree.
///
/// # Errors
/// Fails if the task or required components are unavailable.
pub fn for_task(
    project: Project,
    task: Option<&str>,
    required: &[String],
    roots: Vec<PathBuf>,
) -> Result<(Project, Vec<PathBuf>, Option<context::ContextSection>)> {
    let Some(id) = task else {
        return Ok((project, roots, None));
    };
    let task = tasks::stored(Path::new(&project.root), id)?;
    let (moved, dropped) = tasks::project_in(&project, &task, required)?;
    let section = tasks::context_section(&moved, &task, &dropped);
    let roots = vec![PathBuf::from(&moved.root)];
    Ok((moved, roots, Some(section)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    id: String,
    pub project_id: String,
    task: Option<String>,
    initiator: String,
    action: Action,
    state: String,
    report: Option<ActionReport>,
    error: Option<String>,
    preview_urls: Vec<String>,
}

fn records(state: &impl Host, launch: &LaunchContext) -> Result<Vec<Record>> {
    Ok(call::<Vec<Record>>(state, Request::List)?
        .into_iter()
        .filter(|record| {
            record.metadata.project_id == launch.project_id && record.metadata.task == launch.task
        })
        .collect())
}

fn previews(state: &impl Host, ids: impl IntoIterator<Item = String>) -> Result<Vec<String>> {
    call(
        state,
        Request::PreviewUrlsBatch {
            ids: ids.into_iter().collect(),
        },
    )
}

fn emit(host: &impl Host, activity: &Activity) {
    host.emit_activity(activity);
}

/// Run a graph action, recorded as task activity. Returns the report and the preview URLs
/// its sessions printed.
///
/// # Errors
/// Fails for inaccessible components, unavailable tasks or service errors.
pub fn run_action(
    app: &impl Host,
    project_id: &str,
    mut project: Project,
    request: ActionRequest,
    task: Option<&str>,
    initiator: &str,
) -> Result<(ActionReport, Vec<String>)> {
    let action = Action::from(request.clone());
    let mut activity = Activity {
        id: crate::agent_bridge::new_id(),
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
    let state = app;
    let result = (|| {
        let scoped = state.project(project_id)?;
        let access = scoped.access;
        access.trust(&mut project)?;
        // Affected traversal precedes restriction, preserving missing/locked component errors.
        let plan = ActionPlan::build(&project, project_id, request, task)?;
        let ids = plan.component_ids();
        let project = access.restrict(project, &ids)?;
        let (project, _, _) = for_task(project, task, &ids, scoped.roots)?;
        call::<ActionReport>(
            state,
            Request::ActionRun {
                project: Box::new(project),
                plan: Box::new(plan),
            },
        )
    })();
    let result = result.map(|report| {
        let urls = previews(state, report.session_ids()).unwrap_or_default();
        (report, urls)
    });
    match &result {
        Ok((report, urls)) => {
            // The report still lists components without a validator.
            activity.state = if report.failed() {
                "failed"
            } else {
                "finished"
            }
            .into();
            activity.report = Some(report.clone());
            activity.preview_urls.clone_from(urls);
        }
        Err(error) => {
            activity.state = "failed".into();
            activity.error = Some(error.to_string());
        }
    }
    emit(app, &activity);
    result
}

/// Stops by id rather than by the map, so an environment whose group was renamed or
/// deleted can still be stopped.
///
/// # Errors
/// Fails if the project, task or session service is unavailable.
pub fn stop_group(
    app: &impl Host,
    project_id: &str,
    root: &std::path::Path,
    group_id: &str,
    task: Option<&str>,
    initiator: &str,
) -> Result<()> {
    let mut activity = Activity {
        id: crate::agent_bridge::new_id(),
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
    let state = app;
    let result = (|| {
        state.project(project_id)?;
        if let Some(task) = task {
            crate::tasks::stored(root, task)?;
        }
        call(
            state,
            Request::ActionStopGroup {
                project_id: project_id.into(),
                group_id: group_id.into(),
                task: task.map(Into::into),
            },
        )
    })();
    activity.state = if result.is_ok() { "finished" } else { "failed" }.into();
    activity.error = result.as_ref().err().map(ToString::to_string);
    emit(app, &activity);
    result
}

/// Whether a provider `conversation` is the one the session's native status follows;
/// any is accepted until the session has reported one.
fn current_conversation(current: Option<&str>, conversation: Option<&str>) -> bool {
    match (current, conversation) {
        (Some(current), Some(conversation)) => current == conversation,
        _ => true,
    }
}

/// The checkout holding a planner's plan, for its own provider conversation only: a
/// nested run (`claude -p`) inherits the planner's capability but not its conversation.
fn planner_root(
    state: &impl Host,
    scoped: ProjectScope,
    launch: &LaunchContext,
    conversation: Option<&str>,
) -> Result<PathBuf> {
    anyhow::ensure!(launch.planner, "Only planner sessions can save plans");
    let snapshot: Option<crate::pty::Snapshot> = call(
        state,
        Request::Snapshot {
            id: launch.agent_session.clone(),
        },
    )?;
    anyhow::ensure!(
        current_conversation(
            snapshot
                .as_ref()
                .and_then(|s| s.status.agent.as_ref()?.conversation_id.as_deref()),
            conversation
        ),
        "Only the planner's own conversation can save its plan"
    );
    let project = scoped.project()?;
    let readable = scoped.access.restrict(project, &[])?;
    let (mapped, _, _) = for_task(readable, launch.task.as_deref(), &[], scoped.roots)?;
    Ok(PathBuf::from(mapped.root))
}

/// Execute an authenticated command in its fixed launch context.
///
/// # Errors
/// Fails for unavailable projects, invalid actions or service errors.
pub fn dispatch(app: &impl Host, launch: &LaunchContext, action: Action) -> Result<Value> {
    let state = app;
    let scoped = state.project(&launch.project_id)?;
    anyhow::ensure!(
        !launch.mapper
            || matches!(
                action,
                Action::Context {} | Action::Status {} | Action::ProposeLinks { .. }
            ),
        "Dependency detection can only read context and propose links"
    );
    match action {
        Action::Context {} => {
            let project = scoped.project()?;
            let readable = scoped.access.restrict(project, &[])?;
            let (mapped, _, _) = for_task(readable, launch.task.as_deref(), &[], scoped.roots)?;
            let root = std::path::Path::new(&mapped.root);
            let task = launch
                .task
                .as_deref()
                .map(|id| crate::tasks::find(root, id))
                .transpose()?;
            // A task without components hasn't been scoped yet, so the whole map is in scope.
            let scope = match &task {
                Some(t) if !t.components.is_empty() => t.components.clone(),
                _ => mapped.components.iter().map(|c| c.id.clone()).collect(),
            };
            let plan = crate::plans::read(root, launch.task.as_deref()).ok();
            let assignments = crate::proposals::read(root, launch.task.as_deref(), true)
                .ok()
                .flatten()
                .map(|p| p.assignments);
            Ok(
                json!({"projectId":launch.project_id,"taskId":launch.task,"task":task,"scope":scope,"plan":plan,"assignments":assignments,"agentSessionId":launch.agent_session,"project":mapped}),
            )
        }
        Action::Status {} => {
            let sessions = records(state, launch)?;
            let urls = previews(state, sessions.iter().map(|s| s.id.clone()))?;
            let activities: Vec<_> = state
                .activities()
                .into_iter()
                .filter(|a| a.project_id == launch.project_id && a.task == launch.task)
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
            let record = records(state, launch)?
                .into_iter()
                .find(|r| r.id == session_id)
                .ok_or_else(|| anyhow::anyhow!("Session is outside the launch task"))?;
            let snapshot: Option<crate::pty::Snapshot> = call(
                state,
                Request::Snapshot {
                    id: session_id.clone(),
                },
            )?;
            let output = snapshot
                .as_ref()
                .map(|s| String::from_utf8_lossy(&s.data).into_owned())
                .unwrap_or_default();
            Ok(
                json!({"sessionId":record.id,"output":output,"running":snapshot.as_ref().is_some_and(|s| s.running),"truncated":snapshot.as_ref().is_some_and(|s| s.truncated),"previewUrls":previews(state, [session_id])?}),
            )
        }
        Action::SavePlan {
            plan,
            conversation,
            presented,
        } => {
            anyhow::ensure!(!plan.trim().is_empty(), "The plan is empty");
            let root = planner_root(state, scoped, launch, conversation.as_deref())?;
            // PreToolUse, PermissionRequest and PostToolUse can carry the same plan.
            // Leave applied assignments intact when its contents haven't changed.
            if crate::plans::capture(&root, launch.task.as_deref(), &plan, presented)? {
                app.proposal_submitted(launch);
            }
            Ok(json!({"saved":true}))
        }
        Action::WithdrawPlan { conversation } => {
            let root = planner_root(state, scoped, launch, conversation.as_deref())?;
            let withdrawn = crate::plans::withdraw(&root, launch.task.as_deref())?;
            if withdrawn {
                app.proposal_submitted(launch);
            }
            Ok(json!({"withdrawn":withdrawn}))
        }
        Action::ProposeLinks { proposal } => {
            anyhow::ensure!(
                launch.mapper,
                "Only dependency detection sessions can propose links"
            );
            // Locked components are unknown ids to the agent.
            let readable = scoped.access.restrict(scoped.project()?, &[])?;
            let pending =
                crate::link_proposals::submit(&readable, &launch.agent_session, &proposal)?;
            app.links_proposed(launch);
            Ok(
                json!({"submitted":pending.links.len(),"alreadyOnMap":pending.skipped.len(),"applied":false}),
            )
        }
        Action::Propose { proposal } => {
            let project = scoped.project()?;
            let readable = scoped.access.restrict(project, &[])?;
            let (mapped, _, _) = for_task(readable, launch.task.as_deref(), &[], scoped.roots)?;
            if !launch.planner {
                anyhow::bail!("Only planner sessions can submit proposals");
            }
            crate::proposals::submit(&mapped, launch.task.as_deref(), &proposal)?;
            app.proposal_submitted(launch);
            Ok(json!({"submitted":true,"applied":false}))
        }
        Action::EnvironmentStop { group_id } => {
            stop_group(
                app,
                &launch.project_id,
                &scoped
                    .access
                    .root()
                    .ok_or_else(|| anyhow::anyhow!("Project unavailable"))?,
                &group_id,
                launch.task.as_deref(),
                &launch.agent_session,
            )?;
            Ok(json!({"stopped":true,"groupId":group_id}))
        }
        action @ (Action::EnvironmentStart { .. }
        | Action::Validate { .. }
        | Action::ValidateChanged { .. }) => {
            let request = ActionRequest::try_from(action)?;
            let validation = !matches!(request, ActionRequest::StartGroup { .. });
            if launch.planner {
                anyhow::bail!(
                    "Switch to implementation before {}",
                    if validation {
                        "running checks"
                    } else {
                        "starting environments"
                    }
                );
            }
            let (report, urls) = run_action(
                app,
                &launch.project_id,
                scoped.project()?,
                request,
                launch.task.as_deref(),
                &launch.agent_session,
            )?;
            if validation {
                Ok(
                    json!({"passed":report.succeeded(),"missingValidators":report.plan.skipped,"sessionIds":report.session_ids(),"report":report,"previewUrls":urls}),
                )
            } else {
                Ok(json!({"report":report,"sessionIds":report.session_ids(),"previewUrls":urls}))
            }
        }
    }
}

impl From<ActionRequest> for Action {
    fn from(request: ActionRequest) -> Self {
        match request {
            ActionRequest::StartGroup { group_id } => Self::EnvironmentStart { group_id },
            ActionRequest::ValidateAffected { component_id } => Self::Validate { component_id },
            ActionRequest::ValidateChanged { component_ids } => {
                Self::ValidateChanged { component_ids }
            }
        }
    }
}

impl TryFrom<Action> for ActionRequest {
    type Error = anyhow::Error;

    fn try_from(action: Action) -> Result<Self> {
        match action {
            Action::EnvironmentStart { group_id } => Ok(Self::StartGroup { group_id }),
            Action::Validate { component_id } => Ok(Self::ValidateAffected { component_id }),
            Action::ValidateChanged { component_ids } => {
                Ok(Self::ValidateChanged { component_ids })
            }
            Action::Context {}
            | Action::Status {}
            | Action::Logs { .. }
            | Action::EnvironmentStop { .. }
            | Action::Propose { .. }
            | Action::ProposeLinks { .. }
            | Action::SavePlan { .. }
            | Action::WithdrawPlan { .. } => anyhow::bail!("Unsupported graph command"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_commands_round_trip_with_their_payloads() {
        for request in [
            ActionRequest::StartGroup {
                group_id: "env".into(),
            },
            ActionRequest::ValidateAffected {
                component_id: "web".into(),
            },
            ActionRequest::ValidateChanged {
                component_ids: vec!["web".into(), "api".into()],
            },
        ] {
            let expected = serde_json::to_value(&request).unwrap();
            let action = Action::from(request);
            let actual = ActionRequest::try_from(action).unwrap();
            assert_eq!(serde_json::to_value(actual).unwrap(), expected);
        }
        assert!(ActionRequest::try_from(Action::Context {}).is_err());
        assert!(
            ActionRequest::try_from(Action::EnvironmentStop {
                group_id: "env".into()
            })
            .is_err()
        );
    }

    struct Fixture {
        calls: Mutex<Vec<Request>>,
        project: Option<Project>,
        saves: Mutex<usize>,
    }
    impl Host for Fixture {
        fn project(&self, _: &str) -> Result<ProjectScope> {
            if let Some(project) = &self.project {
                let access = crate::access::Access::default();
                access.open(project)?;
                return Ok(ProjectScope {
                    access: access.snapshot(),
                    project: Some(project.clone()),
                    roots: vec![PathBuf::from(&project.root)],
                });
            }
            // No map or checkout: status and logs must use session records only.
            Ok(ProjectScope {
                access: AccessSnapshot::default(),
                project: None,
                roots: vec![],
            })
        }
        fn request(&self, request: Request) -> Result<Value> {
            let response = match &request {
                Request::List => json!([
                    record("one", "task"),
                    record("two", "task"),
                    record("other", "elsewhere")
                ]),
                Request::PreviewUrlsBatch { ids } => {
                    assert!(!ids.contains(&"other".to_string()));
                    json!(["http://localhost:3000"])
                }
                Request::Snapshot { id } => {
                    assert_eq!(id, "one");
                    Value::Null
                }
                _ => panic!("unexpected service request"),
            };
            self.calls.lock().unwrap().push(request);
            Ok(response)
        }
        fn activities(&self) -> Vec<Activity> {
            vec![]
        }
        fn emit_activity(&self, _: &Activity) {}
        fn proposal_submitted(&self, _: &LaunchContext) {
            *self.saves.lock().unwrap() += 1;
        }
        fn links_proposed(&self, _: &LaunchContext) {
            *self.saves.lock().unwrap() += 1;
        }
    }
    fn record(id: &str, task: &str) -> Value {
        json!({"id":id,"metadata":{"projectId":"p","projectName":"P","projectRoot":"/missing",
            "componentId":"web","terminalId":"agent","task":task,"name":"Agent","kind":"agent"},
            "spec":{"id":id,"command":"cat","cwd":"/missing","env":{},"ready_when":"","service":false,"notice":null,"dirs":[]},
            "snapshot":null,"history":[],"interrupted":false,"requestIds":[]})
    }
    fn launch() -> LaunchContext {
        LaunchContext {
            project_id: "p".into(),
            task: Some("task".into()),
            agent_session: "one".into(),
            planner: false,
            mapper: false,
        }
    }
    #[test]
    fn status_uses_one_preview_scan_without_resolving_the_map_or_task() {
        let host = Fixture {
            calls: Mutex::default(),
            project: None,
            saves: Mutex::default(),
        };
        let result = dispatch(&host, &launch(), Action::Status {}).unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
        assert_eq!(result["previewUrls"][0], "http://localhost:3000");
        let calls = host.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(matches!(&calls[1], Request::PreviewUrlsBatch { ids } if ids == &["one", "two"]));
    }
    #[test]
    fn logs_remain_task_bound_without_resolving_a_checkout() {
        let host = Fixture {
            calls: Mutex::default(),
            project: None,
            saves: Mutex::default(),
        };
        let result = dispatch(
            &host,
            &launch(),
            Action::Logs {
                session_id: "one".into(),
            },
        )
        .unwrap();
        assert_eq!(result["sessionId"], "one");
        assert!(
            dispatch(
                &host,
                &launch(),
                Action::Logs {
                    session_id: "other".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn link_proposals_are_mapper_only_and_mappers_run_nothing_else() {
        let host = Fixture {
            calls: Mutex::default(),
            saves: Mutex::default(),
            project: Some(Project {
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Map fixture".into(),
                root: std::env::temp_dir().display().to_string(),
                components: vec![],
                links: vec![],
                groups: vec![],
            }),
        };
        let propose = || Action::ProposeLinks {
            proposal: serde_json::from_value(json!({"version":1,"links":[]})).unwrap(),
        };
        let mut session = launch();
        session.task = None;
        let err = dispatch(&host, &session, propose())
            .unwrap_err()
            .to_string();
        assert!(err.contains("Only dependency detection"), "{err}");
        session.mapper = true;
        // Validated before anything is saved.
        let err = dispatch(&host, &session, propose())
            .unwrap_err()
            .to_string();
        assert!(err.contains("needs links"), "{err}");
        for action in [
            Action::Validate {
                component_id: "web".into(),
            },
            Action::Logs {
                session_id: "other".into(),
            },
            Action::EnvironmentStart {
                group_id: "env".into(),
            },
            Action::Propose {
                proposal: serde_json::from_value(
                    json!({"version":1,"plan":"p","assignments":[{"componentId":"web","assignment":"a"}]}),
                )
                .unwrap(),
            },
        ] {
            let err = dispatch(&host, &session, action).unwrap_err().to_string();
            assert!(err.contains("only read context and propose links"), "{err}");
        }
        assert_eq!(*host.saves.lock().unwrap(), 0);
        assert!(host.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn captured_plans_are_planner_only_task_bound_and_idempotent() {
        let root =
            std::env::temp_dir().join(format!("patchbay-native-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        let root = root.canonicalize().unwrap();
        let host = Fixture {
            calls: Mutex::default(),
            saves: Mutex::default(),
            project: Some(Project {
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Plan fixture".into(),
                root: root.display().to_string(),
                components: vec![],
                links: vec![],
                groups: vec![],
            }),
        };
        let mut planner = launch();
        planner.task = None;
        let save = || Action::SavePlan {
            plan: "# Native plan".into(),
            conversation: None,
            presented: false,
        };
        assert!(dispatch(&host, &planner, save()).is_err());
        assert!(crate::plans::read(&root, None).unwrap().text.is_empty());
        planner.planner = true;
        crate::plans::write(&root, Some("other"), "Other task's plan").unwrap();
        dispatch(&host, &planner, save()).unwrap();
        let stamp = std::fs::metadata(crate::plans::plan_file(&root, None).unwrap())
            .unwrap()
            .modified()
            .unwrap();
        dispatch(&host, &planner, save()).unwrap();
        assert_eq!(*host.saves.lock().unwrap(), 1);
        assert_eq!(
            std::fs::metadata(crate::plans::plan_file(&root, None).unwrap())
                .unwrap()
                .modified()
                .unwrap(),
            stamp
        );
        assert_eq!(
            crate::plans::read(&root, None).unwrap().text,
            "# Native plan"
        );
        assert_eq!(
            crate::plans::read(&root, Some("other")).unwrap().text,
            "Other task's plan"
        );
        planner.task = Some("unknown-task".into());
        assert!(dispatch(&host, &planner, save()).is_err());
        planner.task = None;
        assert!(
            dispatch(
                &host,
                &planner,
                Action::SavePlan {
                    plan: " ".into(),
                    conversation: None,
                    presented: false,
                }
            )
            .is_err()
        );
        assert!(
            dispatch(
                &host,
                &planner,
                Action::SavePlan {
                    plan: "x".repeat(crate::plans::PLAN_LIMIT + 1),
                    conversation: None,
                    presented: false,
                }
            )
            .is_err()
        );
        // A plan shown for approval is put back when the dialog closes without it.
        let shown = Action::SavePlan {
            plan: "# Shown".into(),
            conversation: Some("12345678-conversation".into()),
            presented: true,
        };
        dispatch(&host, &planner, shown).unwrap();
        assert_eq!(crate::plans::read(&root, None).unwrap().text, "# Shown");
        let withdraw = Action::WithdrawPlan { conversation: None };
        assert_eq!(
            dispatch(&host, &planner, withdraw).unwrap()["withdrawn"],
            true
        );
        assert_eq!(
            crate::plans::read(&root, None).unwrap().text,
            "# Native plan"
        );
        // The planner's own session is the only one consulted.
        assert!(
            host.calls
                .lock()
                .unwrap()
                .iter()
                .all(|r| matches!(r, Request::Snapshot { .. }))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn only_the_planners_conversation_hands_over_plans() {
        assert!(current_conversation(None, Some("nested")));
        assert!(current_conversation(Some("planner"), None));
        assert!(current_conversation(Some("planner"), Some("planner")));
        assert!(!current_conversation(Some("planner"), Some("nested")));
    }
}
