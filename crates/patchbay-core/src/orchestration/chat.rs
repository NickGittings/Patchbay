//! Durable chat ownership and inbox. Visible history is deliberately not a source of truth.
use super::*;
use crate::session::Request;

const MESSAGE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lead {
    pub session_id: String,
    pub generation: u64,
    pub conversation: Option<String>,
    pub preset: TerminalSpec,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub goal: String,
    pub constraints: String,
    pub decisions: String,
    pub remaining: String,
    pub validation: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryState {
    Pending,
    Sending,
    Delivered,
    Uncertain,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub sequence: u64,
    pub sender: String,
    pub recipient: String,
    pub assignment: Option<String>,
    pub text: String,
    pub state: DeliveryState,
    pub generation: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub recipient: String,
    pub generation: u64,
    pub ready_since: u64,
    pub ids: Vec<String>,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadLaunch {
    pub metadata: crate::session::Metadata,
    pub spec: SessionSpec,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reset {
    #[serde(default)]
    pub launch: Option<LeadLaunch>,
    pub id: String,
    pub next_session: String,
    pub phase: ResetPhase,
    pub clear_history: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetPhase {
    Queued,
    Launching,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    #[serde(default)]
    pub started_ms: u64,
    pub id: String,
    pub session_id: String,
    pub generation: u64,
    pub text: String,
    pub clear_history: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub project_id: String,
    pub task: Option<String>,
    pub target: String,
    pub lead: Lead,
    pub state: State,
    pub workers: Vec<TerminalSpec>,
    pub limit: usize,
    pub rounds: Vec<String>,
    pub checkpoint: Checkpoint,
    pub messages: Vec<Message>,
    pub deliveries: Vec<Delivery>,
    pub reset: Option<Reset>,
    pub handoff: Option<Handoff>,
    pub last_compaction_ms: Option<u64>,
    pub recovery: bool,
    #[serde(default)]
    pub checkpoint_required: bool,
    #[serde(default)]
    pub last_reset_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub project_id: String,
    pub target: String,
    pub kind: String,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Inspect,
    Checkpoint {
        checkpoint: Checkpoint,
    },
    Delegate {
        id: String,
        assignments: Vec<AssignmentDraft>,
    },
    Send {
        id: String,
        to: String,
        text: String,
    },
    Report {
        summary: String,
    },
    Result {
        summary: String,
        commit: String,
    },
    Integrate {
        assignment: String,
    },
    Finish {
        validation: String,
    },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Control {
    Pause,
    Block {
        reason: String,
    },
    Resume,
    Stop,
    Retry {
        assignment: String,
    },
    Settings {
        workers: Vec<TerminalSpec>,
        limit: usize,
    },
    Reset {
        id: String,
        session: String,
        #[serde(rename = "clearHistory")]
        clear_history: bool,
    },
    ResolveDelivery {
        id: String,
        delivered: bool,
    },
    HandoffApplied {
        id: String,
    },
}
fn team<'a>(store: &'a mut Store, project: &str, id: &str) -> Result<&'a mut Team> {
    store
        .teams
        .iter_mut()
        .find(|t| t.project_id == project && t.id == id)
        .ok_or_else(|| anyhow!("Unknown chat team"))
}
fn member<'a>(store: &'a Store, t: &Team, id: &str) -> Option<&'a Job> {
    store
        .runs
        .iter()
        .filter(|r| r.chat_team.as_deref() == Some(&t.id))
        .flat_map(|r| &r.jobs)
        .find(|j| j.id == id)
}
fn record<'a>(records: &'a [Record], project: &str, sid: &str) -> Result<&'a Record> {
    records
        .iter()
        .find(|r| r.id == sid && r.metadata.project_id == project)
        .ok_or_else(|| anyhow!("Session is unavailable; open its terminal to recover"))
}
fn generation(r: &Record) -> Result<u64> {
    r.snapshot
        .as_ref()
        .map(|s| s.generation)
        .ok_or_else(|| anyhow!("Session has no generation"))
}
fn ready(r: &Record) -> bool {
    !r.interrupted
        && r.snapshot.as_ref().is_some_and(|s| {
            s.running
                && s.status.context.compaction != crate::agent_context::Compaction::Compacting
                && !s.status.stopped
                && s.status.agent.as_ref().is_some_and(|a| {
                    a.authoritative
                        && !a.approval_pending
                        && matches!(
                            a.state,
                            crate::status::AgentState::Idle | crate::status::AgentState::Review
                        )
                })
        })
}
fn supported(t: &TerminalSpec) -> bool {
    t.kind == crate::TerminalKind::Agent
        && !t.command.trim().is_empty()
        && (t.adapter.is_some() || crate::adapters::Adapter::default_for(&t.command).is_some())
}
/// Same lock as launch reservations and run creation: UI races cannot split ownership.
pub(super) fn ensure_available(
    store: &Store,
    project: &str,
    target: &Path,
    auto: bool,
) -> Result<()> {
    ensure!(
        !store.owners.iter().any(|o| Path::new(&o.target) == target
            && !(auto && o.project_id == project && o.kind == "auto")),
        "This worktree is controlled by coordinated chat or Auto; stop its owner first"
    );
    Ok(())
}
/// Guard manual/Auto implementation entry points using the same durable worktree lease.
pub fn implementation_available(
    root: &Path,
    project: &str,
    target: &Path,
    auto: bool,
) -> Result<()> {
    if crate::git::repo_root(target).is_none() {
        return Ok(());
    }
    modify(root, |s| ensure_available(s, project, target, auto))
}
pub fn auto_ownership(
    root: &Path,
    project: &str,
    target: &Path,
    id: &str,
    acquire: bool,
) -> Result<()> {
    modify(root, |s| {
        if acquire {
            if s.owners.iter().any(|o| {
                o.project_id == project
                    && o.target == target.to_string_lossy()
                    && o.kind == "auto"
                    && o.id == id
            }) {
                return Ok(());
            }
            ensure_available(s, project, target, false)?;
            ensure!(
                !s.runs.iter().any(|r| Path::new(&r.target) == target
                    && !(r.project_id == project && r.auto.is_some())
                    && matches!(r.state, State::Running | State::Paused)),
                "An unfinished provider run controls this worktree"
            );
            s.owners.push(Owner {
                project_id: project.into(),
                target: target.display().to_string(),
                kind: "auto".into(),
                id: id.into(),
            });
        } else {
            s.owners
                .retain(|o| !(o.project_id == project && o.kind == "auto" && o.id == id));
        }
        Ok(())
    })
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initialize {
    pub task: Option<String>,
    pub session_id: String,
    pub preset: TerminalSpec,
    pub paused: bool,
    pub checkpoint: Checkpoint,
}
/// Adopts the saved selected session without launching workers or discarding history.
pub fn initialize(
    root: &Path,
    project: &str,
    target: &Path,
    seed: Initialize,
    records: &[Record],
) -> Result<Team> {
    let Initialize {
        task,
        session_id,
        preset,
        paused,
        checkpoint,
    } = seed;
    let sid = session_id.as_str();
    let r = record(records, project, sid)?;
    ensure!(
        r.metadata.task == task && r.metadata.kind == crate::TerminalKind::Agent,
        "Choose an agent from this worktree"
    );
    ensure!(
        !matches!(
            r.metadata.component_id.as_str(),
            SCAN_SCOPE
                | WORKER_SCOPE
                | COORDINATOR_SCOPE
                | crate::model::MAP_SCOPE
                | crate::model::REVIEW_SCOPE
        ),
        "Choose an interactive lead"
    );
    ensure!(
        supported(&preset),
        "Chat teams support Claude and Codex presets with status integration"
    );
    modify(root, |s| {
        if let Some(t) = s
            .teams
            .iter()
            .find(|t| t.project_id == project && t.task == task)
        {
            return Ok(t.clone());
        }
        ensure_available(s, project, target, false)?;
        ensure!(
            !s.runs.iter().any(|r| r.project_id == project
                && Path::new(&r.target) == target
                && matches!(r.state, State::Running | State::Paused)),
            "An unfinished provider run controls this worktree"
        );
        let t = Team {
            id: new_id(),
            project_id: project.into(),
            task,
            target: target.display().to_string(),
            lead: Lead {
                session_id: sid.into(),
                generation: generation(r)?,
                conversation: r
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.status.agent.as_ref())
                    .and_then(|a| a.conversation_id.clone())
                    .or_else(|| r.metadata.conversation_id.clone()),
                preset: preset.clone(),
            },
            state: if paused {
                State::Paused
            } else {
                State::Running
            },
            workers: vec![preset],
            limit: 2,
            rounds: vec![],
            checkpoint,
            messages: vec![],
            deliveries: vec![],
            reset: None,
            handoff: None,
            last_compaction_ms: None,
            recovery: true,
            checkpoint_required: false,
            last_reset_id: None,
            error: None,
        };
        s.owners.push(Owner {
            project_id: project.into(),
            target: t.target.clone(),
            kind: "chat".into(),
            id: t.id.clone(),
        });
        s.teams.push(t.clone());
        Ok(t)
    })
}
pub fn list(root: &Path, project: &str) -> Result<Vec<Team>> {
    modify(root, |s| {
        Ok(s.teams
            .iter()
            .filter(|t| t.project_id == project)
            .cloned()
            .collect())
    })
}
fn append(
    t: &mut Team,
    id: String,
    sender: &str,
    recipient: &str,
    assignment: Option<String>,
    text: String,
) -> Result<()> {
    valid_id(&id)?;
    ensure!(
        !text.trim().is_empty() && text.len() <= MESSAGE_LIMIT,
        "Message must contain 1–65536 bytes"
    );
    if let Some(m) = t.messages.iter().find(|m| m.id == id) {
        ensure!(
            m.sender == sender
                && m.recipient == recipient
                && m.assignment == assignment
                && m.text == text,
            "Message identity has different contents"
        );
        return Ok(());
    }
    let sequence = t.messages.last().map_or(1, |m| m.sequence + 1);
    t.messages.push(Message {
        id,
        sequence,
        sender: sender.into(),
        recipient: recipient.into(),
        assignment,
        text,
        state: DeliveryState::Pending,
        generation: None,
    });
    Ok(())
}
fn actor(s: &Store, launch: &LaunchContext, records: &[Record]) -> Result<(usize, String)> {
    let r = record(records, &launch.project_id, &launch.agent_session)?;
    ensure!(
        launch.generation == Some(generation(r)?)
            && r.metadata.task == launch.task
            && r.snapshot.as_ref().is_some_and(|s| s.running),
        "Session launch ownership changed"
    );
    for (i, t) in s
        .teams
        .iter()
        .enumerate()
        .filter(|(_, t)| t.project_id == launch.project_id)
    {
        if t.lead.session_id == launch.agent_session {
            ensure!(
                t.lead.generation == generation(r)?
                    && t.reset
                        .as_ref()
                        .is_none_or(|r| r.phase == ResetPhase::Queued),
                "This lead was superseded or is being replaced"
            );
            return Ok((i, "lead".into()));
        }
        if let Some(j) = s
            .runs
            .iter()
            .filter(|r| r.chat_team.as_deref() == Some(&t.id))
            .flat_map(|r| &r.jobs)
            .find(|j| {
                j.session_id.as_deref() == Some(&launch.agent_session)
                    && j.task == launch.task
                    && r.request_ids.last() == Some(&j.request_id)
            })
        {
            return Ok((i, j.id.clone()));
        }
    }
    Err(anyhow!("Session is not a current member of a chat team"))
}
fn active_run<'a>(s: &'a mut Store, t: &Team) -> Result<&'a mut Run> {
    s.runs
        .iter_mut()
        .rev()
        .find(|r| {
            r.chat_team.as_deref() == Some(&t.id)
                && !matches!(r.state, State::Complete | State::Stopped)
        })
        .ok_or_else(|| anyhow!("No active delegation round"))
}
/// Authenticated members derive their own team and task; caller-supplied team IDs are forbidden.
pub fn command(
    root: &Path,
    project: &Project,
    launch: &LaunchContext,
    records: &[Record],
    command: Command,
) -> Result<Team> {
    modify(root, |s| {
        let (index, who) = actor(s, launch, records)?;
        let mut t = s.teams[index].clone();
        let lead = who == "lead";
        match command {
            Command::Inspect => {}
            Command::Checkpoint { checkpoint } => {
                ensure!(lead, "Only the lead can checkpoint");
                ensure!(
                    serde_json::to_vec(&checkpoint)?.len() <= 64 * 1024,
                    "Checkpoint is too large"
                );
                t.checkpoint = checkpoint;
                t.checkpoint_required = false;
            }
            Command::Delegate { id, assignments } => {
                ensure!(
                    lead && t.state == State::Running && t.reset.is_none(),
                    "Delegation is paused; continue locally or Resume"
                );
                ensure!(
                    !t.checkpoint.goal.trim().is_empty(),
                    "Checkpoint the goal, constraints, decisions, remaining work and validation before delegating"
                );
                valid_id(&id)?;
                if let Some(existing) = s.runs.iter().find(|r| r.id == id) {
                    ensure!(
                        existing.chat_team.as_deref() == Some(&t.id),
                        "Round identity belongs to another team"
                    );
                    let mut copy = existing.clone();
                    let count = copy.jobs.len();
                    add_assignments(&mut copy, assignments)?;
                    ensure!(copy.jobs.len() == count, "Round identity already used");
                    return Ok(t);
                }
                ensure!(
                    s.runs.iter().all(|r| r.chat_team.as_deref() != Some(&t.id)
                        || matches!(r.state, State::Complete | State::Stopped)),
                    "Finish the existing round before delegating again"
                );
                ensure!(!assignments.is_empty(), "Create at least one assignment");
                ensure!(
                    assignments
                        .iter()
                        .all(|a| member(s, &t, &a.id).is_none() && a.id != "lead"),
                    "Assignment IDs must be unique across team rounds"
                );
                let tree = Path::new(&t.target);
                if assignments
                    .iter()
                    .any(|a| a.result_kind == ResultKind::Code)
                {
                    clean(tree)?;
                }
                let mut coordinator = Job::new(t.lead.preset.clone());
                coordinator.session_id = Some(t.lead.session_id.clone());
                coordinator.state = JobState::Running;
                let mut r = Run {
                    chat_team: Some(t.id.clone()),
                    auto: None,
                    id: id.clone(),
                    project_id: t.project_id.clone(),
                    task: t.task.clone(),
                    kind: Kind::Implementation,
                    state: State::Running,
                    goal: t.checkpoint.goal.clone(),
                    components: vec![],
                    target: t.target.clone(),
                    branch: branch(tree)?,
                    source_revision: head(tree)?,
                    source_roots: vec![],
                    integrated_head: head(tree)?,
                    jobs: vec![],
                    coordinator: Some(coordinator),
                    workers: t.workers.clone(),
                    sealed: true,
                    accepted_partial: false,
                    error: None,
                };
                r.components = project.components.iter().map(|c| c.id.clone()).collect();
                let mapped = target_project(project, t.task.as_deref(), &r.components)?;
                for assignment in &assignments {
                    ensure!(
                        assignment
                            .components
                            .iter()
                            .all(|id| r.components.contains(id)),
                        "Assignment contains an unknown or unavailable component"
                    );
                    if assignment.result_kind == ResultKind::Code {
                        for c in mapped.components.iter().filter(|c| {
                            assignment.components.is_empty()
                                || assignment.components.contains(&c.id)
                        }) {
                            ensure!(
                                crate::git::repo_root(&mapped.component_dir(c)).as_deref()
                                    == Some(tree),
                                "Code delegation requires components in the target repository; continue locally for this repository layout"
                            );
                        }
                    }
                }
                add_assignments(&mut r, assignments)?;
                t.rounds.push(id);
                s.runs.push(r);
            }
            Command::Send { id, to, text } => {
                ensure!(
                    lead || to == "lead",
                    "Workers communicate only with their owning lead"
                );
                ensure!(
                    to == "lead" || member(s, &t, &to).is_some(),
                    "Recipient belongs to another team or does not exist"
                );
                append(
                    &mut t,
                    id,
                    &who,
                    &to,
                    if lead {
                        (to != "lead").then(|| to.clone())
                    } else {
                        Some(who.clone())
                    },
                    text,
                )?;
            }
            Command::Report { summary } => {
                ensure!(
                    !lead && !summary.trim().is_empty() && summary.len() <= 60 * 1024,
                    "Workers must explicitly submit a report"
                );
                let r = s
                    .runs
                    .iter_mut()
                    .find(|r| {
                        r.chat_team.as_deref() == Some(&t.id) && r.jobs.iter().any(|j| j.id == who)
                    })
                    .unwrap();
                let j = r.jobs.iter_mut().find(|j| j.id == who).unwrap();
                ensure!(
                    j.result_kind == ResultKind::Report,
                    "Code assignments require committed results"
                );
                if let Some(previous) = &j.summary {
                    ensure!(previous == &summary, "Report already submitted");
                }
                j.summary = Some(summary.clone());
                j.state = JobState::Complete;
                j.error = None;
                let text = format!(
                    "Report from {} (committed baseline {}):\n{}",
                    who,
                    j.base.as_deref().unwrap_or(&r.source_revision),
                    summary
                );
                append(
                    &mut t,
                    format!("report-{}", j.request_id),
                    &who,
                    "lead",
                    Some(who.clone()),
                    text,
                )?;
                resume_after_submission(r);
            }
            Command::Result { summary, commit } => {
                ensure!(
                    !lead && !summary.trim().is_empty() && summary.len() <= 60 * 1024,
                    "Only workers submit code results"
                );
                let r = s
                    .runs
                    .iter_mut()
                    .find(|r| {
                        r.chat_team.as_deref() == Some(&t.id) && r.jobs.iter().any(|j| j.id == who)
                    })
                    .unwrap();
                let j = r.jobs.iter_mut().find(|j| j.id == who).unwrap();
                ensure!(
                    j.result_kind == ResultKind::Code,
                    "Report assignments submit reports"
                );
                if let Some(old) = &j.commit {
                    ensure!(
                        old == &commit && j.summary.as_ref() == Some(&summary),
                        "Result already submitted"
                    );
                }
                let task = tasks::find(
                    root,
                    j.task
                        .as_deref()
                        .ok_or_else(|| anyhow!("No worker checkout"))?,
                )?;
                let tree = Path::new(&task.worktree);
                clean(tree)?;
                ensure!(
                    commit.chars().all(|c| c.is_ascii_hexdigit())
                        && commit == head(tree)?
                        && j.base.as_ref() != Some(&commit)
                        && ancestor(tree, j.base.as_deref().unwrap_or(""), &commit)?,
                    "Submit committed HEAD based on the assigned revision"
                );
                if !matches!(j.state, JobState::Integrated | JobState::Integrating) {
                    j.state = JobState::Complete;
                }
                j.commit = Some(commit.clone());
                j.summary = Some(summary.clone());
                j.error = None;
                append(
                    &mut t,
                    format!("result-{}", j.request_id),
                    &who,
                    "lead",
                    Some(who.clone()),
                    format!(
                        "Code result from {who}: {commit}\n{summary}\nIntegrate serially, verify, then checkpoint."
                    ),
                )?;
                resume_after_submission(r);
            }
            Command::Integrate { assignment } => {
                ensure!(
                    lead && t.state == State::Running && t.reset.is_none(),
                    "Integration is paused"
                );
                let r = s
                    .runs
                    .iter_mut()
                    .find(|r| {
                        r.chat_team.as_deref() == Some(&t.id)
                            && r.jobs.iter().any(|j| j.id == assignment)
                    })
                    .ok_or_else(|| anyhow!("Unknown assignment"))?;
                if r.jobs
                    .iter()
                    .any(|j| j.id == assignment && j.state == JobState::Integrated)
                {
                    return Ok(t);
                }
                ensure!(r.state != State::Stopped, "Round was stopped");
                // Resolution of a journalled merge is allowed after explicit Resume.
                r.state = State::Running;
                let result = integrate(r, &assignment);
                if let Err(e) = result {
                    t.state = State::Paused;
                    t.error = r.error.clone().or_else(|| Some(e.to_string()));
                    s.teams[index] = t;
                    return Err(e);
                }
                t.checkpoint_required = true;
            }
            Command::Finish { validation } => {
                ensure!(
                    lead && t.state == State::Running
                        && t.reset.is_none()
                        && !validation.trim().is_empty()
                        && !t.checkpoint_required,
                    "The active lead must verify and record validation"
                );
                if !s.runs.iter().any(|r| {
                    r.chat_team.as_deref() == Some(&t.id)
                        && !matches!(r.state, State::Stopped | State::Complete)
                }) && t.checkpoint.validation == validation
                {
                    return Ok(t);
                }
                let r = active_run(s, &t)?;
                ensure!(
                    r.jobs.iter().all(job_done),
                    "Every report must be submitted and every code result integrated"
                );
                r.state = State::Complete;
                t.checkpoint.validation = validation;
            }
        }
        s.teams[index] = t.clone();
        Ok(t)
    })
}
fn resume_after_submission(r: &mut Run) {
    if r.state == State::Paused
        && !r
            .jobs
            .iter()
            .any(|j| matches!(j.state, JobState::Failed | JobState::Integrating))
    {
        r.state = State::Running;
        r.error = None;
    }
}
/// Reserve under the orchestration lock; excludes the persistent lead from the worker budget.
pub(super) fn reserve_check(s: &Store, project: &str, run: &str, job: &str) -> Result<()> {
    let r = s
        .runs
        .iter()
        .find(|r| r.id == run && r.project_id == project)
        .ok_or_else(|| anyhow!("Unknown run"))?;
    if let Some(id) = &r.chat_team {
        let t = s
            .teams
            .iter()
            .find(|t| &t.id == id)
            .ok_or_else(|| anyhow!("Missing team"))?;
        ensure!(
            t.state == State::Running && t.reset.is_none(),
            "Team is paused or replacing its lead"
        );
        ensure!(
            r.jobs.iter().any(|j| j.id == job),
            "The chat lead is attached, never launched as a coordinator"
        );
        let occupied = s
            .runs
            .iter()
            .filter(|r| r.chat_team.as_deref() == Some(id) && r.state != State::Stopped)
            .flat_map(|r| &r.jobs)
            .filter(|j| j.id != job && matches!(j.state, JobState::Launching | JobState::Running))
            .count();
        ensure!(occupied < t.limit, "Worker concurrency limit reached");
    }
    Ok(())
}

pub fn control(
    root: &Path,
    project: &str,
    id: &str,
    control: Control,
    records: &[Record],
) -> Result<Team> {
    modify(root, |s| {
        let mut t = team(s, project, id)?.clone();
        match control {
            Control::Pause => t.state = State::Paused,
            Control::Block { reason } => {
                t.state = State::Paused;
                t.error = Some(reason.chars().take(8000).collect());
            }
            Control::Resume => {
                ensure_available_for_team(s, &t)?;
                match record(records, project, &t.lead.session_id) {
                    Ok(r) => ensure!(
                        generation(r)? == t.lead.generation,
                        "Lead generation changed; refresh team state first"
                    ),
                    Err(error) => {
                        let Some(reset) = &t.reset else {
                            return Err(error);
                        };
                        // A new preset carries its own launch template. Switching to
                        // a retained session instead requires that target to exist.
                        if reset.launch.is_none() {
                            record(records, project, &reset.next_session)?;
                        }
                    }
                }
                ensure!(
                    t.reset
                        .as_ref()
                        .is_none_or(|r| r.phase != ResetPhase::Launching),
                    "Reconcile the pending lead replacement first"
                );
                if let Some(reset) = &mut t.reset {
                    reset.phase = ResetPhase::Queued;
                    reset.error = None;
                }
                t.state = State::Running;
                t.error = None;
                for r in s
                    .runs
                    .iter_mut()
                    .filter(|r| r.chat_team.as_deref() == Some(&t.id) && r.state == State::Paused)
                {
                    ensure!(
                        !r.jobs.iter().any(|j| j.state == JobState::Failed),
                        "Retry failed workers before resuming"
                    );
                    r.state = State::Running;
                }
                if !s.owners.iter().any(|o| o.kind == "chat" && o.id == t.id) {
                    s.owners.push(Owner {
                        project_id: project.into(),
                        target: t.target.clone(),
                        kind: "chat".into(),
                        id: t.id.clone(),
                    });
                }
                t.recovery = true;
            }
            Control::Stop => {
                t.state = State::Stopped;
                t.reset = None;
                for r in s
                    .runs
                    .iter_mut()
                    .filter(|r| r.chat_team.as_deref() == Some(&t.id) && r.state != State::Complete)
                {
                    r.state = State::Stopped;
                }
                s.owners.retain(|o| !(o.kind == "chat" && o.id == t.id));
            }
            Control::Retry { assignment } => {
                let r = active_run(s, &t)?;
                let j = r
                    .jobs
                    .iter_mut()
                    .find(|j| j.id == assignment)
                    .ok_or_else(|| anyhow!("Unknown assignment"))?;
                ensure!(
                    matches!(j.state, JobState::Failed | JobState::Launching),
                    "Only a failed or unconfirmed assignment can retry"
                );
                // Failed owned sessions are stopped by the desktop before this operation.
                if j.state == JobState::Failed {
                    j.request_id = new_id();
                    j.session_id = None;
                }
                j.state = JobState::Pending;
                j.observed_working = false;
                j.error = None;
                r.state = State::Running;
                r.error = None;
                t.error = None;
            }
            Control::Settings { workers, limit } => {
                ensure!(
                    (1..=8).contains(&limit)
                        && !workers.is_empty()
                        && workers.iter().all(supported),
                    "Choose supported Claude/Codex presets and 1–8 workers"
                );
                let ids: HashSet<_> = workers.iter().map(|w| &w.id).collect();
                ensure!(ids.len() == workers.len(), "Worker presets must be unique");
                t.workers = workers;
                t.limit = limit;
            }
            Control::Reset {
                id,
                session,
                clear_history,
            } => {
                valid_id(&id)?;
                ensure_available_for_team(s, &t)?;
                let r = record(records, project, &session)?;
                ensure!(
                    r.metadata.task == t.task
                        && !matches!(
                            r.metadata.component_id.as_str(),
                            WORKER_SCOPE
                                | COORDINATOR_SCOPE
                                | SCAN_SCOPE
                                | crate::model::REVIEW_SCOPE
                                | crate::model::MAP_SCOPE
                        ),
                    "Choose an interactive lead in this worktree"
                );
                if let Some(reset) = &t.reset {
                    ensure!(
                        reset.id == id
                            && reset.next_session == session
                            && reset.clear_history == clear_history,
                        "A lead replacement is already pending"
                    );
                } else if t.last_reset_id.as_deref() != Some(&id)
                    && t.handoff.as_ref().is_none_or(|h| h.id != id)
                {
                    if t.state == State::Stopped {
                        s.owners.push(Owner {
                            project_id: project.into(),
                            target: t.target.clone(),
                            kind: "chat".into(),
                            id: t.id.clone(),
                        });
                        t.state = State::Running;
                    }
                    t.reset = Some(Reset {
                        launch: None,
                        id,
                        next_session: session,
                        phase: ResetPhase::Queued,
                        clear_history,
                        error: None,
                    });
                }
            }
            Control::ResolveDelivery { id, delivered } => {
                let m = t
                    .messages
                    .iter_mut()
                    .find(|m| m.id == id)
                    .ok_or_else(|| anyhow!("Unknown message"))?;
                ensure!(
                    m.state == DeliveryState::Uncertain,
                    "Only uncertain deliveries need recovery"
                );
                let recipient = m.recipient.clone();
                m.state = if delivered {
                    DeliveryState::Delivered
                } else {
                    DeliveryState::Pending
                };
                if !delivered {
                    t.deliveries.retain(|d| d.recipient != recipient);
                }
            }
            Control::HandoffApplied { id } => {
                if t.handoff.as_ref().is_some_and(|h| h.id == id) {
                    t.handoff = None;
                }
            }
        }
        *team(s, project, &t.id)? = t.clone();
        Ok(t)
    })
}
fn ensure_available_for_team(s: &Store, t: &Team) -> Result<()> {
    ensure!(
        !s.owners
            .iter()
            .any(|o| o.target == t.target && !(o.kind == "chat" && o.id == t.id)),
        "Auto or another owner controls this worktree"
    );
    ensure!(
        !s.runs.iter().any(|r| r.target == t.target
            && r.chat_team.as_deref() != Some(&t.id)
            && matches!(r.state, State::Running | State::Paused)),
        "An unfinished provider run controls this worktree"
    );
    Ok(())
}
pub fn side_message(
    root: &Path,
    project: &str,
    id: &str,
    assignment: &str,
    message_id: String,
    text: String,
) -> Result<Team> {
    modify(root, |s| {
        let t = team(s, project, id)?.clone();
        ensure!(
            member(s, &t, assignment).is_some(),
            "Worker is outside this team"
        );
        let t = team(s, project, id)?;
        append(
            t,
            message_id.clone(),
            "user",
            assignment,
            Some(assignment.into()),
            text.clone(),
        )?;
        append(
            t,
            format!("copy-{message_id}"),
            "user",
            "lead",
            Some(assignment.into()),
            format!("Side-thread message to {assignment}:\n{text}"),
        )?;
        Ok(t.clone())
    })
}
const INSTRUCTIONS: &str = "You are this worktree's persistent Patchbay lead. You may automatically delegate investigation, review and code work to Patchbay-managed workers. Do not use provider-native subagents. Before delegating and after integration, save a durable checkpoint with $PATCHBAY_CLI agent team-checkpoint --file <json> (goal, constraints, decisions, remaining, validation). Inspect authoritative state with agent team; create a round with agent team-delegate --id <unique-round-id> --file <json-array> where assignments have globally unique id, instructions, components, dependencies, preset, resultKind (report or code). Use only configured worker presets. Report workers inspect the committed baseline; compare their findings with local edits. Code delegation requires a clean Git checkpoint: when local changes exist, explain the constraint and continue locally; never automatically commit or stash user changes. While code workers run, keep target edits under coordinator control. Route dependencies and messages with agent team-send --id <unique-id> --to <assignment-id> --text <message>. Workers contact only you. Integrate code SERIALly using agent team-integrate <assignment-id>, verify the result, checkpoint, then agent team-finish --validation <checks-and-results>. Process exit is never success. After native compaction or a new conversation inspect agent team before acting; checkpoint, assignments, messages, commits and integration facts are authoritative. Preserve workers and worktrees. Continue locally when authentication, status hooks or repository layout prevent delegation.";
fn excerpt(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut end = limit - "…".len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
fn recovery_text(s: &Store, t: &Team) -> Result<String> {
    let rounds: Vec<_> = s.runs.iter().filter(|r| r.chat_team.as_deref() == Some(&t.id)).map(|r| serde_json::json!({
        "id": r.id, "state": r.state, "target": r.target, "integratedHead": r.integrated_head, "error": r.error,
        "assignments": r.jobs.iter().map(|j| serde_json::json!({"id":j.id,"instructions":j.instructions,"resultKind":j.result_kind,"preset":j.preset,"state":j.state,"base":j.base,"commit":j.commit,"summary":j.summary,"integratedHead":j.integrated_head,"error":j.error})).collect::<Vec<_>>()
    })).collect();
    let workers = excerpt(
        &t.workers
            .iter()
            .map(|w| w.id.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        2048,
    );
    let render = |checkpoint: &Checkpoint, rounds: &[serde_json::Value]| -> Result<String> {
        Ok(format!(
            "Patchbay coordination handoff\n{INSTRUCTIONS}\nTeam: {}\nWorkers: {workers}\nConcurrency: {}\nCheckpoint:\n{}\nRounds:\n{}\nUnread messages are delivered separately once, in sequence. Do not replay delivered messages or full transcripts.",
            t.id,
            t.limit,
            serde_json::to_string_pretty(checkpoint)?,
            serde_json::to_string_pretty(rounds)?
        ))
    };
    let full = render(&t.checkpoint, &rounds)?;
    if full.len() <= MESSAGE_LIMIT {
        return Ok(full);
    }
    // A valid checkpoint or accumulated results can outgrow one inbox message.
    // Summarize transport only; the durable records keep every byte and assignment.
    let checkpoint = Checkpoint {
        goal: excerpt(&t.checkpoint.goal, 1024),
        constraints: excerpt(&t.checkpoint.constraints, 1024),
        decisions: excerpt(&t.checkpoint.decisions, 1024),
        remaining: excerpt(&t.checkpoint.remaining, 1024),
        validation: excerpt(&t.checkpoint.validation, 1024),
    };
    let rounds: Vec<_> = s.runs.iter().rev().filter(|r| r.chat_team.as_deref() == Some(&t.id)).take(8).map(|r| serde_json::json!({
        "id": r.id, "state": r.state, "integratedHead": r.integrated_head,
        "assignments": r.jobs.len(), "unfinishedAssignments": r.jobs.iter().filter(|j| !job_done(j)).count(),
        "error": r.error.as_deref().map(|e| excerpt(e, 256)),
    })).collect();
    let compact = render(&checkpoint, &rounds)?;
    let notice = "This handoff is abbreviated. The complete checkpoint, assignment instructions, results and older rounds remain in durable storage. Run $PATCHBAY_CLI agent team to inspect the complete state before continuing.";
    Ok(format!(
        "{}\n\n{notice}",
        excerpt(&compact, MESSAGE_LIMIT - notice.len() - 2)
    ))
}
pub(super) fn restore(s: &mut Store, project: &str) {
    for t in s.teams.iter_mut().filter(|t| t.project_id == project) {
        if t.state == State::Running {
            t.state = State::Paused;
            t.error = Some("Restored after restart — Resume to continue coordination".into());
        }
        for m in &mut t.messages {
            if m.state == DeliveryState::Sending {
                m.state = DeliveryState::Uncertain;
            }
        }
        t.recovery = true;
        if let Some(reset) = &mut t.reset
            && reset.phase == ResetPhase::Launching
        {
            reset.phase = ResetPhase::Failed;
            reset.error =
                Some("Replacement interrupted. Resume reconciles the same launch identity.".into());
        }
    }
}
/// Reconciliation runs outside Chat's lifecycle. Restarts pause before launching or delivering.
pub fn reconcile(
    root: &Path,
    project: &str,
    records: &[Record],
    restoring: bool,
) -> Result<Vec<Team>> {
    modify(root, |s| {
        for index in 0..s.teams.len() {
            let mut t = s.teams[index].clone();
            if t.project_id != project {
                continue;
            }
            if restoring {
                if t.state == State::Running {
                    t.state = State::Paused;
                    t.error =
                        Some("Restored after restart — Resume to continue coordination".into());
                }
                for m in &mut t.messages {
                    if m.state == DeliveryState::Sending {
                        m.state = DeliveryState::Uncertain;
                    }
                }
            }
            if let Some(reset) = t.reset.clone() {
                if let Some(r) = records.iter().find(|r| {
                    r.id == reset.next_session
                        && r.metadata.project_id == project
                        && r.request_ids.last() == Some(&reset.id)
                }) {
                    if let Ok(generation) = generation(r) {
                        t.lead.session_id = r.id.clone();
                        t.lead.generation = generation;
                        t.lead.conversation = r.metadata.conversation_id.clone();
                        if !r.metadata.command.is_empty() {
                            t.lead.preset.command = r.metadata.command.clone();
                        }
                        t.lead.preset.name = r.metadata.name.clone();
                        t.lead.preset.adapter = r.metadata.adapter;
                        let text = format!(
                            "Goal: {}\nConstraints: {}\nDecisions: {}\nRemaining: {}\nValidation: {}\nRetained delegation rounds: {}. Pending worker updates will be delivered when ready.",
                            t.checkpoint.goal,
                            t.checkpoint.constraints,
                            t.checkpoint.decisions,
                            t.checkpoint.remaining,
                            t.checkpoint.validation,
                            t.rounds.len()
                        );
                        t.handoff = Some(Handoff {
                            started_ms: r.snapshot.as_ref().map_or(0, |s| s.started_ms),
                            id: reset.id.clone(),
                            session_id: r.id.clone(),
                            generation,
                            text,
                            clear_history: reset.clear_history,
                        });
                        t.last_reset_id = Some(reset.id.clone());
                        t.reset = None;
                        t.recovery = true;
                        for run in s
                            .runs
                            .iter_mut()
                            .filter(|run| run.chat_team.as_deref() == Some(&t.id))
                        {
                            if let Some(c) = &mut run.coordinator {
                                c.session_id = Some(r.id.clone());
                            }
                        }
                    }
                } else if restoring && reset.phase == ResetPhase::Launching {
                    let reset = t.reset.as_mut().unwrap();
                    reset.phase = ResetPhase::Failed;
                    reset.error = Some("Replacement not confirmed. Resume retries the same launch identity; history is preserved.".into());
                }
            } else if let Ok(r) = record(records, project, &t.lead.session_id) {
                if let Ok(generation) = generation(r)
                    && generation > t.lead.generation
                {
                    t.lead.generation = generation;
                    t.recovery = true;
                }
                if generation(r).is_ok_and(|g| g < t.lead.generation) {
                    s.teams[index] = t;
                    continue;
                }
                let conversation = r
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.status.agent.as_ref())
                    .and_then(|a| a.conversation_id.clone())
                    .or_else(|| r.metadata.conversation_id.clone());
                if conversation.is_some() && conversation != t.lead.conversation {
                    t.lead.conversation = conversation;
                    t.recovery = true;
                }
                let compact = r
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.status.context.last_compaction_ms);
                if compact.is_some() && compact != t.last_compaction_ms {
                    t.last_compaction_ms = compact;
                    t.recovery = true;
                }
            }
            let notices: Vec<_> = s
                .runs
                .iter()
                .filter(|r| r.chat_team.as_deref() == Some(&t.id))
                .flat_map(|r| &r.jobs)
                .filter(|j| j.state == JobState::Failed)
                .map(|j| {
                    (
                        format!("failed-{}", j.request_id),
                        j.id.clone(),
                        j.error
                            .clone()
                            .unwrap_or_else(|| "Worker exited without an explicit result".into()),
                    )
                })
                .collect();
            let questions: Vec<_> = s
                .runs
                .iter()
                .filter(|r| r.chat_team.as_deref() == Some(&t.id))
                .flat_map(|r| &r.jobs)
                .filter_map(|j| {
                    let r = j
                        .session_id
                        .as_deref()
                        .and_then(|sid| record(records, project, sid).ok())?;
                    if r.request_ids.last() != Some(&j.request_id) {
                        return None;
                    }
                    let a = r.snapshot.as_ref()?.status.agent.as_ref()?;
                    (a.authoritative && a.state == crate::status::AgentState::NeedsInput).then(
                        || {
                            (
                                format!("question-{}-{}", j.request_id, a.since_ms),
                                j.id.clone(),
                                a.message.clone().unwrap_or_else(|| {
                                    "Input is needed in the worker terminal".into()
                                }),
                            )
                        },
                    )
                })
                .collect();
            for (id, assignment, question) in questions {
                append(
                    &mut t,
                    id,
                    &assignment,
                    "lead",
                    Some(assignment.clone()),
                    format!(
                        "Worker {assignment} needs input: {question}. Open its side thread or terminal. Automated delivery waits for a ready prompt."
                    ),
                )?;
            }
            for (id, assignment, error) in notices {
                append(
                    &mut t,
                    id,
                    &assignment,
                    "lead",
                    Some(assignment.clone()),
                    format!(
                        "Worker {assignment} failed: {error}. Inspect and Retry or continue locally."
                    ),
                )?;
            }
            s.teams[index] = t;
        }
        Ok(s.teams
            .iter()
            .filter(|t| t.project_id == project)
            .cloned()
            .collect())
    })
}
/// Queue a new lead preset without launching a temporary coordinator or a second conversation.
pub fn new_lead(
    root: &Path,
    project: &Project,
    project_id: &str,
    id: &str,
    terminal: TerminalSpec,
    request_id: String,
) -> Result<Team> {
    valid_id(&request_id)?;
    ensure!(supported(&terminal), "Choose a supported lead preset");
    modify(root, |s| {
        let t = team(s, project_id, id)?.clone();
        ensure_available_for_team(s, &t)?;
        if let Some(reset) = &t.reset {
            ensure!(reset.id == request_id, "A lead replacement is pending");
            return Ok(t);
        }
        if t.last_reset_id.as_deref() == Some(&request_id) {
            return Ok(t);
        }
        let mapped = target_project(project, t.task.as_deref(), &[])?;
        let spec = context::task_root_session_spec(
            &mapped,
            &[],
            &terminal,
            t.task.as_deref(),
            &AllowAll,
            &[ContextSection {
                title: "Persistent chat lead".into(),
                body: recovery_text(s, &t)?,
            }],
            None,
        )?;
        let metadata: crate::session::Metadata = serde_json::from_value(serde_json::json!({
            "projectId":project_id, "projectName":project.name, "projectRoot":project.root, "componentId":crate::model::TASK_ROOT_SCOPE,
            "terminalId":terminal.id, "task":t.task, "name":terminal.name, "kind":"agent", "adapter":terminal.adapter, "command":terminal.command
        }))?;
        let next_session = crate::model::task_session_id(
            project_id,
            crate::model::TASK_ROOT_SCOPE,
            &terminal.id,
            t.task.as_deref(),
        );
        if t.state == State::Stopped {
            s.owners.push(Owner {
                project_id: project_id.into(),
                target: t.target.clone(),
                kind: "chat".into(),
                id: t.id.clone(),
            });
        }
        let t = team(s, project_id, id)?;
        if t.state == State::Stopped {
            t.state = State::Running;
        }
        t.reset = Some(Reset {
            id: request_id,
            next_session,
            phase: ResetPhase::Queued,
            clear_history: true,
            error: None,
            launch: Some(LeadLaunch { metadata, spec }),
        });
        Ok(t.clone())
    })
}
/// Reserves a fresh-conversation identity before replacement. The transport must deduplicate it.
pub fn replace_lead(
    root: &Path,
    project: &str,
    id: &str,
    records: &[Record],
    mut call: impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<()> {
    modify(root, |s| {
        let t = team(s, project, id)?.clone();
        let Some(reset) = t.reset.clone() else {
            return Ok(());
        };
        if t.state != State::Running || reset.phase != ResetPhase::Queued {
            return Ok(());
        }
        if let Ok(current) = record(records, project, &t.lead.session_id)
            && (generation(current)? != t.lead.generation
                || (current.snapshot.as_ref().is_some_and(|s| s.running) && !ready(current)))
        {
            return Ok(());
        }
        let request = if let Some(launch) = &reset.launch {
            let mut spec = launch.spec.clone();
            for key in crate::agent_bridge::BRIDGE_ENV {
                spec.env.remove(key);
            }
            Request::NewConversation {
                request_id: reset.id.clone(),
                metadata: Box::new(launch.metadata.clone()),
                spec,
            }
        } else {
            let next = record(records, project, &reset.next_session)?;
            if next.snapshot.as_ref().is_some_and(|s| s.running) && !ready(next) {
                return Ok(());
            }
            Request::ResetConversation {
                id: next.id.clone(),
                request_id: reset.id.clone(),
                generation: generation(next)?,
            }
        };
        // The next ready prompt receives recovery; the launch never pastes into a busy turn.
        team(s, project, id)?.reset.as_mut().unwrap().phase = ResetPhase::Launching;
        save(root, s)?;
        let stop = if reset.next_session != t.lead.session_id
            && record(records, project, &t.lead.session_id).is_ok()
        {
            call(Request::Stop {
                id: t.lead.session_id.clone(),
            })
        } else {
            Ok(serde_json::Value::Null)
        };
        let result = stop.and_then(|_| call(request));
        if let Err(e) = result {
            let t = team(s, project, id)?;
            let reset = t.reset.as_mut().unwrap();
            reset.phase = ResetPhase::Failed;
            reset.error = Some(e.to_string());
            t.state = State::Paused;
            t.error = Some(format!(
                "Lead replacement unconfirmed: {e}. History and workers are preserved. Resume reconciles the same launch."
            ));
        }
        Ok(())
    })
}
/// One batch per recipient and ready turn. Uncertain writes are never automatically resent.
pub fn deliver(
    root: &Path,
    project: &str,
    id: &str,
    records: &[Record],
    mut call: impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<()> {
    modify(root, |s| {
        let mut t = team(s, project, id)?.clone();
        if t.state != State::Running || t.reset.is_some() {
            return Ok(());
        }
        if t.recovery
            && record(records, project, &t.lead.session_id)
                .is_ok_and(|r| ready(r) && generation(r).ok() == Some(t.lead.generation))
        {
            let text = recovery_text(s, &t)?;
            append(&mut t, new_id(), "patchbay", "lead", None, text)?;
            t.recovery = false;
        }
        let recipients: HashSet<_> = t
            .messages
            .iter()
            .filter(|m| m.state == DeliveryState::Pending)
            .map(|m| m.recipient.clone())
            .collect();
        // The durable reserve blocks another desktop drive even if the transport loses its reply.
        for recipient in recipients {
            if t.messages.iter().any(|m| {
                m.recipient == recipient
                    && matches!(m.state, DeliveryState::Sending | DeliveryState::Uncertain)
            }) {
                continue;
            }
            let sid = if recipient == "lead" {
                Some(t.lead.session_id.clone())
            } else {
                member(s, &t, &recipient).and_then(|j| j.session_id.clone())
            };
            let Some(r) = sid
                .as_deref()
                .and_then(|sid| record(records, project, sid).ok())
            else {
                continue;
            };
            if !ready(r) {
                continue;
            }
            if recipient != "lead"
                && member(s, &t, &recipient)
                    .is_none_or(|j| r.request_ids.last() != Some(&j.request_id))
            {
                continue;
            }
            let generation = generation(r)?;
            if recipient == "lead" && generation != t.lead.generation {
                continue;
            }
            let ready_since = r
                .snapshot
                .as_ref()
                .unwrap()
                .status
                .agent
                .as_ref()
                .unwrap()
                .since_ms;
            if t.deliveries.iter().any(|d| {
                d.recipient == recipient
                    && d.generation == generation
                    && d.ready_since >= ready_since
            }) {
                continue;
            }
            let messages: Vec<_> = t
                .messages
                .iter()
                .filter(|m| m.recipient == recipient && m.state == DeliveryState::Pending)
                .take(32)
                .cloned()
                .collect();
            let ids: Vec<_> = messages.iter().map(|m| m.id.clone()).collect();
            let text = messages
                .iter()
                .map(|m| {
                    format!(
                        "[Patchbay message {} from {}{}]\n{}",
                        m.sequence,
                        m.sender,
                        m.assignment
                            .as_ref()
                            .map(|a| format!(" / {a}"))
                            .unwrap_or_default(),
                        m.text
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            for m in &mut t.messages {
                if ids.contains(&m.id) {
                    m.state = DeliveryState::Sending;
                    m.generation = Some(generation);
                }
            }
            let delivery = Delivery {
                recipient: recipient.clone(),
                generation,
                ready_since,
                ids: ids.clone(),
                text: text.clone(),
            };
            t.deliveries.retain(|d| d.recipient != recipient);
            t.deliveries.push(delivery);
            *team(s, project, id)? = t.clone();
            save(root, s)?;
            let viewer = format!("chat-team-{}", t.id);
            let claimed = call(Request::Claim {
                id: r.id.clone(),
                viewer: viewer.clone(),
                claim: true,
            });
            let result = match claimed {
                Ok(_) => call(Request::Prompt {
                    id: r.id.clone(),
                    viewer: viewer.clone(),
                    generation,
                    text,
                    force: false,
                }),
                Err(e) => {
                    for m in &mut t.messages {
                        if ids.contains(&m.id) {
                            m.state = DeliveryState::Pending;
                        }
                    }
                    t.deliveries.retain(|d| d.recipient != recipient);
                    t.error = Some(e.to_string());
                    continue;
                }
            };
            let _ = call(Request::Detach {
                id: r.id.clone(),
                viewer,
            });
            for m in &mut t.messages {
                if ids.contains(&m.id) {
                    m.state = if result.is_ok() {
                        DeliveryState::Delivered
                    } else {
                        DeliveryState::Uncertain
                    };
                }
            }
            if let Err(e) = result {
                t.error = Some(format!(
                    "Delivery unconfirmed: {e}. Inspect the side thread before explicitly resolving delivery."
                ));
            }
        }
        *team(s, project, id)? = t;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{SessionSpec, Snapshot};
    use crate::status::{AgentReport, AgentState, SessionStatus};
    struct Fixture {
        dir: PathBuf,
        project: Project,
        lead: Record,
        team: Team,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    fn preset() -> TerminalSpec {
        serde_json::from_value(serde_json::json!({"id":"codex", "name":"Codex", "kind":"agent", "command":"codex", "adapter":"codex"})).unwrap()
    }
    fn session(root: &Path, sid: &str) -> Record {
        Record {
            id: sid.into(),
            metadata: serde_json::from_value(serde_json::json!({"projectId":"p", "projectName":"P", "projectRoot":root, "componentId":"@task", "terminalId":sid, "name":"Codex", "kind":"agent", "adapter":"codex"})).unwrap(),
            spec: SessionSpec { id: sid.into(), command: "codex".into(), resume_command: None, rerun_on_resume: false, owns_briefing: false, exclusive_cwd: false, merge_source: None, cwd: root.into(), env: BTreeMap::new(), ready_when: String::new(), service: false, notice: None, dirs: vec![] },
            snapshot: Some(Snapshot { launch_directory: None, truncated: false, data: vec![], end: 0, generation: 1, running: true, exit_code: None, started_ms: 1, exited_ms: None,
                status: SessionStatus { agent: Some(AgentReport { state: AgentState::Idle, since_ms: 10, message: None, prompt: None, provider: Some(crate::adapters::Adapter::Codex), conversation_id: Some("c1".into()), turn_id: Some("turn1".into()), authoritative: true, approval_pending: false }), ..Default::default() }, activity: vec![], replies: vec![], last_reply: None, notice: None }),
            history: vec![], launch_command: String::new(), restart_context: None, briefing_backup: None, interrupted: false, request_ids: vec!["lead-request".into()],
        }
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-team-{}", new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            run(git(&dir).args(["init", "-b", "main"])).unwrap();
            run(git(&dir).args(["config", "user.email", "test@example.invalid"])).unwrap();
            run(git(&dir).args(["config", "user.name", "Test"])).unwrap();
            std::fs::write(dir.join("base"), "base").unwrap();
            run(git(&dir).args(["add", "."])).unwrap();
            run(git(&dir).args(["commit", "-m", "Initial"])).unwrap();
            let dir = dir.canonicalize().unwrap();
            let project: Project = serde_json::from_value(serde_json::json!({"name":"P", "root":dir, "components":[], "links":[], "groups":[], "schemaVersion":4})).unwrap();
            let lead = session(&dir, "lead-session");
            let seed = Initialize {
                task: None,
                session_id: lead.id.clone(),
                preset: preset(),
                paused: false,
                checkpoint: Checkpoint {
                    goal: "Build feature".into(),
                    constraints: "Keep local edits".into(),
                    ..Default::default()
                },
            };
            let team = initialize(&dir, "p", &dir, seed, std::slice::from_ref(&lead)).unwrap();
            Self {
                dir,
                project,
                lead,
                team,
            }
        }
        fn auth(&self) -> LaunchContext {
            LaunchContext {
                generation: self.lead.snapshot.as_ref().map(|s| s.generation),
                project_id: "p".into(),
                task: None,
                agent_session: self.lead.id.clone(),
                role: Role::Component,
            }
        }
        fn cmd(&self, c: Command) -> Result<Team> {
            command(
                &self.dir,
                &self.project,
                &self.auth(),
                std::slice::from_ref(&self.lead),
                c,
            )
        }
        fn delegate(&self, assignments: Vec<AssignmentDraft>) -> Run {
            self.cmd(Command::Delegate {
                id: "round1".into(),
                assignments,
            })
            .unwrap();
            super::super::read(&self.dir, "p", "round1").unwrap()
        }
        fn launch(&self, id: &str) -> (Run, Record) {
            let mut worker = None;
            let r = super::super::launch(&self.dir, "p", "round1", id, &self.project, |l| {
                let sid =
                    crate::model::task_session_id("p", l.scope, &l.terminal.id, l.task.as_deref());
                let mut record = session(&l.spec.cwd, &sid);
                record.metadata.component_id = WORKER_SCOPE.into();
                record.metadata.task = l.task;
                record.request_ids = vec![l.request_id];
                record.spec = l.spec;
                if let Some(path) = context::owned_briefing(&record.spec) {
                    context::remove_owned_briefing_file(&path);
                }
                worker = Some(record);
                Ok(sid)
            })
            .unwrap();
            (r, worker.unwrap())
        }
        fn worker_cmd(&self, worker: &Record, c: Command) -> Result<Team> {
            let launch = LaunchContext {
                generation: worker.snapshot.as_ref().map(|s| s.generation),
                project_id: "p".into(),
                task: worker.metadata.task.clone(),
                agent_session: worker.id.clone(),
                role: Role::Worker,
            };
            command(
                &self.dir,
                &self.project,
                &launch,
                &[self.lead.clone(), worker.clone()],
                c,
            )
        }
        fn state(&self) -> Team {
            list(&self.dir, "p").unwrap().remove(0)
        }
        fn send(&self, id: &str, text: &str) {
            self.cmd(Command::Send {
                id: id.into(),
                to: "lead".into(),
                text: text.into(),
            })
            .unwrap();
        }
    }
    fn assignment(id: &str, kind: ResultKind, deps: &[&str]) -> AssignmentDraft {
        AssignmentDraft {
            id: id.into(),
            instructions: format!("Do {id}"),
            components: vec![],
            dependencies: deps.iter().map(|s| (*s).into()).collect(),
            preset: "codex".into(),
            result_kind: kind,
        }
    }
    #[test]
    fn owning_lead_attaches_without_launch_and_foreign_generations_and_tasks_are_rejected() {
        let f = Fixture::new();
        let r = f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        assert_eq!(
            r.coordinator.unwrap().session_id.as_deref(),
            Some(f.lead.id.as_str())
        );
        assert!(
            super::super::launch(&f.dir, "p", "round1", "unknown", &f.project, |_| panic!())
                .is_err()
        );
        let mut foreign = f.auth();
        foreign.agent_session = "unrelated".into();
        assert!(
            command(
                &f.dir,
                &f.project,
                &foreign,
                std::slice::from_ref(&f.lead),
                Command::Inspect
            )
            .is_err()
        );
        foreign = f.auth();
        foreign.task = Some("wrong".into());
        assert!(
            command(
                &f.dir,
                &f.project,
                &foreign,
                std::slice::from_ref(&f.lead),
                Command::Inspect
            )
            .is_err()
        );
        let mut newer = f.lead.clone();
        newer.snapshot.as_mut().unwrap().generation += 1;
        assert!(command(&f.dir, &f.project, &f.auth(), &[newer], Command::Inspect).is_err());
    }
    #[test]
    fn report_dependencies_need_explicit_submission_and_workers_are_isolated_even_when_target_dirty()
     {
        let f = Fixture::new();
        std::fs::write(f.dir.join("local"), "user edits").unwrap();
        f.delegate(vec![
            assignment("a", ResultKind::Report, &[]),
            assignment("b", ResultKind::Report, &["a"]),
        ]);
        assert!(
            super::super::launch(&f.dir, "p", "round1", "b", &f.project, |_| panic!()).is_err()
        );
        let (r, worker) = f.launch("a");
        assert_ne!(worker.spec.cwd, f.dir);
        assert!(!worker.spec.cwd.join("local").exists());
        assert!(
            f.worker_cmd(
                &worker,
                Command::Result {
                    summary: "x".into(),
                    commit: r.integrated_head
                }
            )
            .is_err()
        );
        assert!(
            f.worker_cmd(
                &worker,
                Command::Send {
                    id: "cross".into(),
                    to: "b".into(),
                    text: "no".into()
                }
            )
            .is_err()
        );
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Baseline inspected".into(),
            },
        )
        .unwrap();
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Baseline inspected".into(),
            },
        )
        .unwrap();
        assert!(
            f.worker_cmd(
                &worker,
                Command::Report {
                    summary: "changed".into()
                }
            )
            .is_err()
        );
        f.launch("b");
        let t = f.state();
        assert_eq!(t.messages.iter().filter(|m| m.sender == "a").count(), 1);
        assert!(
            t.messages
                .iter()
                .any(|m| m.text.contains("committed baseline"))
        );
    }
    #[test]
    fn default_two_worker_limit_is_reserved_in_core_excluding_lead() {
        let f = Fixture::new();
        assert_eq!(f.team.limit, 2);
        f.delegate(vec![
            assignment("a", ResultKind::Report, &[]),
            assignment("b", ResultKind::Report, &[]),
            assignment("c", ResultKind::Report, &[]),
        ]);
        let (_, a) = f.launch("a");
        f.launch("b");
        assert!(
            super::super::launch(&f.dir, "p", "round1", "c", &f.project, |_| panic!()).is_err()
        );
        let r = super::super::read(&f.dir, "p", "round1").unwrap();
        assert_eq!(r.jobs[2].state, JobState::Pending);
        f.worker_cmd(
            &a,
            Command::Report {
                summary: "done".into(),
            },
        )
        .unwrap();
        f.launch("c");
    }
    #[test]
    fn code_delegation_refuses_local_edits_and_duplicate_rounds_and_cycles_are_atomic() {
        let f = Fixture::new();
        std::fs::write(f.dir.join("local"), "user").unwrap();
        assert!(
            f.cmd(Command::Delegate {
                id: "round1".into(),
                assignments: vec![assignment("a", ResultKind::Code, &[])]
            })
            .is_err()
        );
        assert!(f.state().rounds.is_empty());
        assert_eq!(
            std::fs::read_to_string(f.dir.join("local")).unwrap(),
            "user"
        );
        std::fs::remove_file(f.dir.join("local")).unwrap();
        assert!(
            f.cmd(Command::Delegate {
                id: "round1".into(),
                assignments: vec![
                    assignment("a", ResultKind::Code, &["b"]),
                    assignment("b", ResultKind::Code, &["a"])
                ]
            })
            .is_err()
        );
        assert!(f.state().rounds.is_empty());
        let drafts = vec![assignment("a", ResultKind::Code, &[])];
        f.delegate(drafts.clone());
        f.cmd(Command::Delegate {
            id: "round1".into(),
            assignments: drafts,
        })
        .unwrap();
        assert_eq!(f.state().rounds.len(), 1);
        assert!(
            f.cmd(Command::Delegate {
                id: "round1".into(),
                assignments: vec![assignment("new", ResultKind::Code, &[])]
            })
            .is_err()
        );
    }
    #[test]
    fn code_results_require_commits_serial_integration_and_a_checkpoint_before_finishing() {
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Code, &[])]);
        let (r, worker) = f.launch("a");
        assert!(
            f.worker_cmd(
                &worker,
                Command::Report {
                    summary: "done".into()
                }
            )
            .is_err()
        );
        assert!(
            f.worker_cmd(
                &worker,
                Command::Result {
                    summary: "done".into(),
                    commit: r.integrated_head
                }
            )
            .is_err()
        );
        std::fs::write(worker.spec.cwd.join("feature"), "feature").unwrap();
        run(git(&worker.spec.cwd).args(["add", "."])).unwrap();
        run(git(&worker.spec.cwd).args(["commit", "-m", "Feature"])).unwrap();
        f.worker_cmd(
            &worker,
            Command::Result {
                summary: "Implemented and checked".into(),
                commit: head(&worker.spec.cwd).unwrap(),
            },
        )
        .unwrap();
        assert!(
            f.cmd(Command::Finish {
                validation: "pass".into()
            })
            .is_err()
        );
        f.cmd(Command::Integrate {
            assignment: "a".into(),
        })
        .unwrap();
        f.cmd(Command::Integrate {
            assignment: "a".into(),
        })
        .unwrap();
        assert!(f.dir.join("feature").exists());
        assert!(
            f.cmd(Command::Finish {
                validation: "pass".into()
            })
            .is_err()
        );
        f.cmd(Command::Checkpoint {
            checkpoint: Checkpoint {
                goal: "Feature".into(),
                validation: "Checked integration".into(),
                ..Default::default()
            },
        })
        .unwrap();
        f.cmd(Command::Finish {
            validation: "Checks passed".into(),
        })
        .unwrap();
        f.cmd(Command::Delegate {
            id: "round2".into(),
            assignments: vec![assignment("b", ResultKind::Report, &[])],
        })
        .unwrap();
        assert_eq!(f.state().rounds.len(), 2);
    }
    #[test]
    fn ownership_is_exclusive_between_chat_auto_and_manual_runs_and_stop_preserves_results() {
        let f = Fixture::new();
        assert!(auto_ownership(&f.dir, "p", &f.dir, "auto", true).is_err());
        let draft = Draft {
            auto: None,
            id: "manual".into(),
            kind: Kind::Scan,
            goal: "goal".into(),
            components: vec![],
            task: None,
            presets: vec![preset()],
            coordinator: None,
        };
        assert!(super::super::create(&f.project, "p", draft).is_err());
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, worker) = f.launch("a");
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "keep".into(),
            },
        )
        .unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        assert!(worker.spec.cwd.exists());
        assert!(f.state().messages.iter().any(|m| m.text.contains("keep")));
        auto_ownership(&f.dir, "p", &f.dir, "auto", true).unwrap();
        assert!(
            control(
                &f.dir,
                "p",
                &f.team.id,
                Control::Resume,
                std::slice::from_ref(&f.lead)
            )
            .is_err()
        );
    }
    #[test]
    fn messages_batch_in_sequence_once_and_never_interrupt_busy_or_approval_turns() {
        let mut f = Fixture::new();
        // Deliver the initial briefing once; a new message waits for a new ready turn.
        let mut prompts = vec![];
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |r| {
                if let Request::Prompt { text, force, .. } = r {
                    assert!(!force);
                    prompts.push(text);
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        f.send("one", "first");
        f.send("two", "second");
        f.send("one", "first");
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("same ready prompt"),
        )
        .unwrap();
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .since_ms = 20;
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .approval_pending = true;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("approval"),
        )
        .unwrap();
        let a = f
            .lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap();
        a.approval_pending = false;
        a.state = AgentState::Working;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("working"),
        )
        .unwrap();
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Idle;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |r| {
                if let Request::Prompt { text, .. } = r {
                    prompts.push(text);
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(prompts.len(), 2);
        assert!(prompts[1].find("first").unwrap() < prompts[1].find("second").unwrap());
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate"),
        )
        .unwrap();
    }
    #[test]
    fn uncertain_delivery_and_restart_require_explicit_recovery_without_resending() {
        let mut f = Fixture::new();
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |r| {
                if matches!(r, Request::Prompt { .. }) {
                    Err(anyhow!("lost reply"))
                } else {
                    Ok(serde_json::Value::Null)
                }
            },
        )
        .unwrap();
        assert_eq!(f.state().messages[0].state, DeliveryState::Uncertain);
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .since_ms = 50;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("uncertain"),
        )
        .unwrap();
        let restored = reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), true).unwrap();
        assert_eq!(restored[0].state, State::Paused);
        assert_eq!(restored[0].messages[0].state, DeliveryState::Uncertain);
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("paused"),
        )
        .unwrap();
    }
    #[test]
    fn native_compaction_schedules_one_recovery_and_excludes_delivered_messages() {
        let mut f = Fixture::new();
        f.send("one", "PRIVATE-DELIVERED-CONTENT");
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Ok(serde_json::Value::Null),
        )
        .unwrap();
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .context
            .last_compaction_ms = Some(100);
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .since_ms = 101;
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        let mut prompts = vec![];
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |r| {
                if let Request::Prompt { text, .. } = r {
                    prompts.push(text);
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(prompts.len(), 1);
        assert!(prompts[0].contains("Build feature"));
        assert!(!prompts[0].contains("PRIVATE-DELIVERED-CONTENT"));
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate recovery"),
        )
        .unwrap();
    }
    #[test]
    fn reset_waits_for_readiness_preserves_finishing_workers_and_rebinds_before_delivery() {
        let mut f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, worker) = f.launch("a");
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "reset1".into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Working;
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("busy"),
        )
        .unwrap();
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "finished during reset".into(),
            },
        )
        .unwrap();
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            &[f.lead.clone(), worker.clone()],
            |_| panic!("reset"),
        )
        .unwrap();
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Idle;
        let mut launches = 0;
        replace_lead(&f.dir, "p", &f.team.id, std::slice::from_ref(&f.lead), |r| { assert!(matches!(r, Request::ResetConversation { ref request_id, .. } if request_id == "reset1")); launches += 1; Ok(serde_json::Value::Null) }).unwrap();
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate launch"),
        )
        .unwrap();
        assert_eq!(launches, 1);
        assert!(f.state().handoff.is_none());
        f.lead.request_ids.push("reset1".into());
        f.lead.snapshot.as_mut().unwrap().generation = 2;
        reconcile(&f.dir, "p", &[f.lead.clone(), worker], false).unwrap();
        let t = f.state();
        assert!(t.reset.is_none());
        assert!(t.handoff.is_some());
        assert_eq!(t.lead.generation, 2);
        assert!(
            t.messages
                .iter()
                .any(|m| m.text.contains("finished during reset")
                    && m.state == DeliveryState::Pending)
        );
        let mut stale = f.lead.clone();
        stale.snapshot.as_mut().unwrap().generation = 1;
        assert!(command(&f.dir, &f.project, &f.auth(), &[stale], Command::Inspect).is_err());
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::HandoffApplied {
                id: "reset1".into(),
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "reset1".into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        assert!(f.state().reset.is_none());
    }
    #[test]
    fn manual_provider_controls_cannot_mutate_chat_owned_rounds() {
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let before = serde_json::to_value(super::super::list(&f.dir, "p").unwrap()).unwrap();
        for control in [
            super::super::Control::Pause,
            super::super::Control::Resume,
            super::super::Control::Stop,
            super::super::Control::Retry { job: "a".into() },
            super::super::Control::ContinueJob {
                job: "a".into(),
                request_id: "request".into(),
            },
            super::super::Control::ContinueScan,
        ] {
            let error = super::super::control(&f.dir, "p", "round1", control).unwrap_err();
            assert!(error.to_string().contains("Chat worker controls"));
            assert_eq!(
                serde_json::to_value(super::super::list(&f.dir, "p").unwrap()).unwrap(),
                before
            );
            assert_eq!(f.state().state, State::Running);
        }
    }

    #[test]
    fn large_checkpoints_recover_without_changing_the_durable_checkpoint() {
        for goal in ["🦀".repeat(16_000), "\0".repeat(10_800)] {
            let f = Fixture::new();
            let checkpoint = Checkpoint {
                goal,
                constraints: "Keep local edits".into(),
                remaining: "Verify the current work".into(),
                validation: "Still pending".into(),
                ..Default::default()
            };
            f.cmd(Command::Checkpoint {
                checkpoint: checkpoint.clone(),
            })
            .unwrap();
            let mut prompts = 0;
            deliver(
                &f.dir,
                "p",
                &f.team.id,
                std::slice::from_ref(&f.lead),
                |request| {
                    if let Request::Prompt { text, .. } = request {
                        prompts += 1;
                        assert!(text.contains("handoff is abbreviated"));
                        assert!(text.contains("agent team"));
                        assert!(text.contains("Still pending"));
                    }
                    Ok(serde_json::Value::Null)
                },
            )
            .unwrap();
            assert_eq!(prompts, 1);
            let t = f.state();
            assert_eq!(t.checkpoint, checkpoint);
            assert!(!t.recovery);
            assert_eq!(t.messages.len(), 1);
            assert!(t.messages[0].text.len() <= MESSAGE_LIMIT);
            assert_eq!(t.messages[0].state, DeliveryState::Delivered);
            deliver(
                &f.dir,
                "p",
                &f.team.id,
                std::slice::from_ref(&f.lead),
                |_| panic!("replayed recovery"),
            )
            .unwrap();
        }
    }

    #[test]
    fn recovery_summarizes_large_rounds_without_losing_assignments_or_messages() {
        let mut f = Fixture::new();
        let mut job = assignment("large", ResultKind::Report, &[]);
        job.instructions = "Investigate the committed baseline. ".repeat(3000);
        let instructions = job.instructions.clone();
        f.delegate(vec![job]);
        f.send("unread", "Retain this pending update");
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Ok(serde_json::Value::Null),
        )
        .unwrap();
        assert_eq!(
            super::super::read(&f.dir, "p", "round1").unwrap().jobs[0].instructions,
            instructions
        );
        let t = f.state();
        assert!(
            t.messages
                .iter()
                .all(|m| m.state == DeliveryState::Delivered && m.text.len() <= MESSAGE_LIMIT)
        );
        assert!(t.messages.iter().any(|m| m.id == "unread"));
        assert!(
            t.messages
                .iter()
                .any(|m| m.text.contains("round1") && m.text.contains("unfinishedAssignments"))
        );
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .context
            .last_compaction_ms = Some(100);
        f.lead
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .since_ms = 100;
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        let mut prompts = 0;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |request| {
                if let Request::Prompt { text, .. } = request {
                    prompts += 1;
                    assert!(!text.contains("Retain this pending update"));
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(prompts, 1);
    }

    #[test]
    fn paused_team_can_replace_a_forgotten_lead_with_a_new_or_retained_session() {
        for new_preset in [true, false] {
            let f = Fixture::new();
            f.delegate(vec![assignment("pending", ResultKind::Report, &[])]);
            control(&f.dir, "p", &f.team.id, Control::Pause, &[]).unwrap();
            assert!(control(&f.dir, "p", &f.team.id, Control::Resume, &[]).is_err());
            let records = if new_preset {
                let mut next = preset();
                next.id = "replacement".into();
                new_lead(
                    &f.dir,
                    &f.project,
                    "p",
                    &f.team.id,
                    next,
                    "replacement-request".into(),
                )
                .unwrap();
                vec![]
            } else {
                let next = session(&f.dir, "replacement");
                control(
                    &f.dir,
                    "p",
                    &f.team.id,
                    Control::Reset {
                        id: "replacement-request".into(),
                        session: next.id.clone(),
                        clear_history: true,
                    },
                    std::slice::from_ref(&next),
                )
                .unwrap();
                vec![next]
            };
            replace_lead(&f.dir, "p", &f.team.id, &records, |_| {
                panic!("paused team launched a replacement")
            })
            .unwrap();
            let resumed = control(&f.dir, "p", &f.team.id, Control::Resume, &records).unwrap();
            assert_eq!(resumed.state, State::Running);
            let mut launches = 0;
            replace_lead(&f.dir, "p", &f.team.id, &records, |request| {
                match request {
                    Request::NewConversation { request_id, .. } if new_preset => {
                        assert_eq!(request_id, "replacement-request")
                    }
                    Request::ResetConversation {
                        id,
                        request_id,
                        generation,
                    } if !new_preset => {
                        assert_eq!(id, "replacement");
                        assert_eq!(request_id, "replacement-request");
                        assert_eq!(generation, 1);
                    }
                    _ => panic!("unexpected request"),
                }
                launches += 1;
                Ok(serde_json::Value::Null)
            })
            .unwrap();
            assert_eq!(launches, 1);
            let mut next = session(&f.dir, &resumed.reset.unwrap().next_session);
            next.request_ids = vec!["replacement-request".into()];
            reconcile(&f.dir, "p", std::slice::from_ref(&next), false).unwrap();
            let t = f.state();
            assert_eq!(t.lead.session_id, next.id);
            assert!(t.reset.is_none());
            assert_eq!(t.rounds, ["round1"]);
            assert_eq!(
                super::super::read(&f.dir, "p", "round1").unwrap().jobs[0].state,
                JobState::Pending
            );
        }
    }

    #[test]
    fn failed_reset_survives_restart_and_reuses_the_reserved_launch_identity() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "reset1".into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Err(anyhow!("connection lost")),
        )
        .unwrap();
        assert!(f.state().handoff.is_none());
        assert_eq!(f.state().reset.unwrap().phase, ResetPhase::Failed);
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), true).unwrap();
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("restart must pause"),
        )
        .unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Resume,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        replace_lead(&f.dir, "p", &f.team.id, std::slice::from_ref(&f.lead), |r| { assert!(matches!(r, Request::ResetConversation { ref request_id, .. } if request_id == "reset1")); Ok(serde_json::Value::Null) }).unwrap();
    }
    #[test]
    fn migration_is_paused_and_side_thread_messages_are_copied_only_to_owning_lead() {
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        side_message(
            &f.dir,
            "p",
            &f.team.id,
            "a",
            "side1".into(),
            "question".into(),
        )
        .unwrap();
        side_message(
            &f.dir,
            "p",
            &f.team.id,
            "a",
            "side1".into(),
            "question".into(),
        )
        .unwrap();
        assert_eq!(
            f.state()
                .messages
                .iter()
                .filter(|m| m.sender == "user")
                .count(),
            2
        );
        assert!(
            side_message(
                &f.dir,
                "p",
                &f.team.id,
                "foreign",
                "side2".into(),
                "no".into()
            )
            .is_err()
        );
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Pause,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        assert!(
            super::super::launch(&f.dir, "p", "round1", "a", &f.project, |_| panic!()).is_err()
        );
    }
    #[test]
    fn changing_preset_queues_one_launch_and_rejects_the_superseded_lead() {
        let f = Fixture::new();
        let mut terminal = preset();
        terminal.id = "new-lead".into();
        let queued = new_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            terminal,
            "replacement".into(),
        )
        .unwrap();
        let reset = queued.reset.unwrap();
        assert_eq!(reset.phase, ResetPhase::Queued);
        assert!(reset.launch.is_some());
        let mut launches = 0;
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |r| {
                match r {
                    Request::Stop { id } => assert_eq!(id, f.lead.id),
                    Request::NewConversation { request_id, .. } => {
                        assert_eq!(request_id, "replacement");
                        launches += 1;
                    }
                    _ => panic!("unexpected request"),
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(launches, 1);
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate launch"),
        )
        .unwrap();
        let mut next = session(&f.dir, &reset.next_session);
        next.request_ids = vec!["replacement".into()];
        reconcile(&f.dir, "p", &[f.lead.clone(), next.clone()], false).unwrap();
        assert_eq!(f.state().lead.session_id, next.id);
        assert!(
            command(
                &f.dir,
                &f.project,
                &f.auth(),
                &[f.lead.clone(), next],
                Command::Inspect
            )
            .is_err()
        );
    }
    #[test]
    fn stale_samples_never_regress_the_lead_generation_and_native_questions_notify_once() {
        let f = Fixture::new();
        let mut newer = f.lead.clone();
        newer.snapshot.as_mut().unwrap().generation = 2;
        reconcile(&f.dir, "p", std::slice::from_ref(&newer), false).unwrap();
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        assert_eq!(f.state().lead.generation, 2);
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, mut worker) = f.launch("a");
        let agent = worker
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap();
        agent.state = AgentState::NeedsInput;
        agent.message = Some("Which behavior?".into());
        for _ in 0..2 {
            reconcile(&f.dir, "p", &[f.lead.clone(), worker.clone()], false).unwrap();
        }
        let messages = f.state().messages;
        assert_eq!(
            messages
                .iter()
                .filter(|m| m.text.contains("Which behavior?"))
                .count(),
            1
        );
    }
    #[test]
    fn desktop_reset_control_accepts_the_camel_case_protocol() {
        let control: Control = serde_json::from_value(serde_json::json!({"kind":"reset", "id":"reset", "session":"lead", "clearHistory":true})).unwrap();
        assert!(matches!(
            control,
            Control::Reset {
                clear_history: true,
                ..
            }
        ));
    }
    #[test]
    fn stopped_workers_do_not_consume_capacity_in_successive_rounds() {
        let f = Fixture::new();
        f.delegate(vec![
            assignment("a", ResultKind::Report, &[]),
            assignment("b", ResultKind::Report, &[]),
        ]);
        f.launch("a");
        f.launch("b");
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Resume,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        f.cmd(Command::Delegate {
            id: "round2".into(),
            assignments: vec![assignment("c", ResultKind::Report, &[])],
        })
        .unwrap();
        super::super::launch(&f.dir, "p", "round2", "c", &f.project, |l| {
            if let Some(path) = context::owned_briefing(&l.spec) {
                context::remove_owned_briefing_file(&path);
            }
            Ok(crate::model::task_session_id(
                "p",
                l.scope,
                &l.terminal.id,
                l.task.as_deref(),
            ))
        })
        .unwrap();
    }
    #[test]
    fn a_restarted_worker_cannot_submit_for_the_previous_launch_request() {
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, mut worker) = f.launch("a");
        worker.request_ids.push("unrelated-restart".into());
        assert!(
            f.worker_cmd(
                &worker,
                Command::Report {
                    summary: "not the assigned launch".into()
                }
            )
            .is_err()
        );
    }
    #[test]
    fn restart_after_replacement_launch_adopts_it_once_and_stays_paused() {
        let mut f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "reset1".into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Ok(serde_json::Value::Null),
        )
        .unwrap();
        f.lead.request_ids.push("reset1".into());
        f.lead.snapshot.as_mut().unwrap().generation = 2;
        super::super::reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), true).unwrap();
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        let t = f.state();
        assert_eq!(t.state, State::Paused);
        assert!(t.reset.is_none());
        assert_eq!(t.lead.generation, 2);
        assert!(t.handoff.is_some());
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate replacement"),
        )
        .unwrap();
    }
    #[test]
    fn a_late_auto_release_cannot_release_a_newer_worktree_owner() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        auto_ownership(&f.dir, "p", &f.dir, "old-auto", true).unwrap();
        auto_ownership(&f.dir, "p", &f.dir, "old-auto", false).unwrap();
        auto_ownership(&f.dir, "p", &f.dir, "new-auto", true).unwrap();
        auto_ownership(&f.dir, "p", &f.dir, "old-auto", false).unwrap();
        assert!(
            control(
                &f.dir,
                "p",
                &f.team.id,
                Control::Resume,
                std::slice::from_ref(&f.lead)
            )
            .is_err()
        );
        auto_ownership(&f.dir, "p", &f.dir, "new-auto", false).unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Resume,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
    }
}
