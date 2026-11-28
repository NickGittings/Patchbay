//! Durable chat ownership and inbox. Visible history is deliberately not a source of truth.
use super::*;
use crate::session::Request;
use anyhow::Context;

/// Transport confirmed that a team prompt was refused before any text was pasted.
#[derive(Debug)]
pub struct DeliveryRefused(pub String);
impl std::fmt::Display for DeliveryRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for DeliveryRefused {}

/// The reserved recipient for messages addressed to the team lead.
pub const LEAD_RECIPIENT: &str = "lead";

const MESSAGE_LIMIT: usize = 64 * 1024;
const WORKER_ROLE: &str = "worker";
// Mirrors the desktop's early startAgent failure in chatTeams.ts.
const SUB_BUILDERS_OFF: &str = "Sub-builders are off (Settings → Agent roles → Sub-builders). Use a stage such as startPlan, startBuild or startAuto, or ask the user to turn sub-builders on.";

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
    /// Waits for the recipient's next turn instead of starting one.
    #[serde(default)]
    pub passive: bool,
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
    /// The user chose a new lead: replace it now, even mid-turn or while work is paused.
    #[serde(default)]
    pub interrupt_current: bool,
    /// The worktree's task finished: the new lead starts without its checkpoint or results.
    #[serde(default)]
    pub complete_task: bool,
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
    #[serde(default)]
    pub complete_task: bool,
}
/// Work settled before a task completed. It stays stored but leaves later lead handoffs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedWork {
    #[serde(default)]
    pub rounds: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub information: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub workflows: std::collections::BTreeSet<String>,
    /// Completions already decided, so a retry after any outcome changes nothing.
    #[serde(default)]
    pub tasks: std::collections::BTreeSet<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeReservation {
    pub generation: u64,
    pub components: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowAction {
    StartAgent,
    StartPlan,
    StartBuild,
    StartReview,
    StartFix,
    StartMerge,
    StartCouncilReview,
    StartAuto,
    PauseAuto,
    ResumeAuto,
    StopAuto,
    /// Saved by another Patchbay build; kept so the shared store still loads.
    #[serde(other)]
    Unknown,
}

impl WorkflowAction {
    /// Worktree stages stay active until their agents finish, so they never overlap.
    fn is_stage(self) -> bool {
        matches!(
            self,
            Self::StartPlan
                | Self::StartBuild
                | Self::StartReview
                | Self::StartFix
                | Self::StartMerge
                | Self::StartCouncilReview
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowState {
    Queued,
    Waiting,
    Starting,
    Running,
    Completed,
    Uncertain,
    Failed,
    /// Saved by another Patchbay build; kept so the shared store still loads.
    #[serde(other)]
    Unknown,
}

impl WorkflowState {
    fn settled_label(self) -> Option<&'static str> {
        match self {
            Self::Completed => Some("completed"),
            Self::Failed => Some("failed"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRequest {
    pub id: String,
    pub action: WorkflowAction,
    pub settings: serde_json::Value,
    pub state: WorkflowState,
    pub result: Option<String>,
    #[serde(default)]
    pub council: Option<(CouncilSettings, Vec<TerminalSpec>)>,
    #[serde(default)]
    pub council_run: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InformationRequest {
    pub id: String,
    pub recipient: String,
    pub generation: u64,
    pub question: String,
    pub response: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default = "council_limit")]
    pub concurrency: usize,
}
fn council_limit() -> usize {
    2
}
impl Default for CouncilSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            members: vec![],
            concurrency: 2,
        }
    }
}
impl CouncilSettings {
    fn validate(&self, presets: &[TerminalSpec]) -> Result<()> {
        ensure!(
            (1..=8).contains(&self.concurrency),
            "Council concurrency must be 1–8"
        );
        if self.enabled {
            let unique: std::collections::BTreeSet<_> = self.members.iter().collect();
            ensure!(
                unique.len() >= 2 && unique.len() == self.members.len(),
                "Choose at least two distinct council presets"
            );
            ensure!(
                self.members
                    .iter()
                    .all(|id| presets.iter().any(|p| &p.id == id)),
                "Council preset is unavailable"
            );
        }
        Ok(())
    }
}

/// Where the lead says this chat's work stands, shown as Chat's status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadStatus {
    pub step: String,
    #[serde(default)]
    pub note: Option<String>,
    pub at_ms: u64,
}
/// Mirrors `simpleFlow.ts` `SimpleStep` (`SIMPLE_STEPS`); paired tests pin both lists.
const LEAD_STEPS: [&str; 11] = [
    "idle",
    "planning",
    "planReady",
    "building",
    "built",
    "reviewing",
    "reviewed",
    "fixing",
    "fixed",
    "merging",
    "merged",
];
/// In characters, not bytes, so every script gets the same room.
const STATUS_NOTE_LIMIT: usize = 200;

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
    #[serde(default)]
    pub presets: Vec<TerminalSpec>,
    #[serde(default)]
    pub agent_roles: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub council: CouncilSettings,
    pub limit: usize,
    pub rounds: Vec<String>,
    #[serde(default)]
    pub requests: Vec<WorkflowRequest>,
    #[serde(default)]
    pub scopes: BTreeMap<String, ScopeReservation>,
    #[serde(default)]
    pub information_requests: Vec<InformationRequest>,
    #[serde(default)]
    pub continuation_request: Option<String>,
    #[serde(default)]
    pub saved_context: String,
    #[serde(default)]
    pub current_plan: String,
    #[serde(default)]
    pub original_briefing: String,
    #[serde(default)]
    pub observed_agents: BTreeMap<String, u64>,
    /// Sessions the user started independently. Their finish does not wake the lead.
    #[serde(default)]
    pub noted_agents: std::collections::BTreeSet<String>,
    /// When each noted session's work was noted, in Unix milliseconds.
    #[serde(default)]
    pub noted_since: BTreeMap<String, u64>,
    pub checkpoint: Checkpoint,
    /// Set by the lead; `None` until it first reports one.
    #[serde(default)]
    pub status: Option<LeadStatus>,
    pub messages: Vec<Message>,
    pub deliveries: Vec<Delivery>,
    pub reset: Option<Reset>,
    pub handoff: Option<Handoff>,
    pub last_compaction_ms: Option<u64>,
    pub recovery: bool,
    /// The pending recovery follows a cleared conversation: unless work is active, it waits for
    /// the user's next message rather than starting a lead turn.
    #[serde(default)]
    pub quiet_recovery: bool,
    #[serde(default)]
    pub checkpoint_required: bool,
    #[serde(default)]
    pub last_reset_id: Option<String>,
    #[serde(default)]
    pub finished: FinishedWork,
    pub error: Option<String>,
}

/// Sub-builders are on when the worker role names at least one installed preset,
/// matching the desktop's `roleDevices(…, 'worker')` for the regular flow.
fn sub_builders_enabled(t: &Team) -> bool {
    t.agent_roles
        .get(WORKER_ROLE)
        .is_some_and(|ids| ids.iter().any(|id| t.presets.iter().any(|p| &p.id == id)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerKind {
    Chat,
    Auto,
    /// Saved by another Patchbay build; kept so the shared store still loads.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub project_id: String,
    pub target: String,
    pub kind: OwnerKind,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Inspect,
    Ask {
        id: String,
        to: String,
        text: String,
    },
    Reply {
        id: String,
        text: String,
    },
    Request {
        id: String,
        action: String,
        settings: serde_json::Value,
    },
    Coordinate {
        session: String,
        components: Vec<String>,
        #[serde(default)]
        paths: Vec<String>,
    },
    DelegateShared {
        id: String,
        assignments: Vec<AssignmentDraft>,
    },
    Checkpoint {
        checkpoint: Checkpoint,
    },
    Status {
        step: String,
        #[serde(default)]
        note: Option<String>,
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
    Catalog {
        presets: Vec<TerminalSpec>,
        #[serde(default)]
        roles: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        council: CouncilSettings,
    },
    RetryCouncil {
        id: String,
    },
    RequestState {
        id: String,
        state: WorkflowState,
        result: Option<String>,
        /// Tell the lead with its next delivery rather than starting a turn.
        #[serde(default)]
        passive: bool,
    },
    HistoryBoundary,
    Pause,
    Block {
        reason: String,
    },
    Resume,
    Stop,
    Retry {
        assignment: String,
        /// Run the assignment on this agent instead of the one that failed.
        #[serde(default)]
        terminal: Option<TerminalSpec>,
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
    /// The worktree's task finished at `since_ms`: start the next one with a fresh lead.
    CompleteTask {
        id: String,
        #[serde(default, rename = "sinceMs")]
        since_ms: Option<u64>,
    },
    ResolveDelivery {
        id: String,
        delivered: bool,
    },
    HandoffApplied {
        id: String,
    },
    /// Work the user started independently, recorded in the lead's inbox.
    Note {
        id: String,
        text: String,
        #[serde(default)]
        sessions: Vec<String>,
    },
    /// Passive lead messages the user's own prompt carried to the lead.
    NotesDelivered {
        ids: Vec<String>,
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
                && s.chat_startup != Some(crate::status::ChatStartup::Pending)
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
/// Its last turn ended on a usage limit, so a prompt would only fail again.
fn limit_stopped(r: &Record) -> bool {
    r.snapshot
        .as_ref()
        .and_then(|s| s.status.agent.as_ref())
        .is_some_and(|a| a.limit_stopped_ms.is_some())
}
/// How long a limit stop holds deliveries when no spent usage window explains it, so a brief rate
/// limit clears by itself. A delivery that hits the limit again starts a new hold.
const LIMIT_RETRY_MS: u64 = 15 * 60 * 1000;
/// Held while a delivery would only fail again: just after the stop, or until a spent window of
/// the subscription resets. OpenRouter profiles spend no subscription window.
fn limit_held(
    r: &Record,
    now_ms: u64,
    exhausted: &mut impl FnMut(crate::adapters::Adapter) -> bool,
) -> bool {
    let Some(agent) = r.snapshot.as_ref().and_then(|s| s.status.agent.as_ref()) else {
        return false;
    };
    let Some(stopped_ms) = agent.limit_stopped_ms else {
        return false;
    };
    let open_router = crate::profiles::from_command(&r.spec.command)
        .ok()
        .flatten()
        .is_some_and(|profile| profile.open_router);
    now_ms.saturating_sub(stopped_ms) < LIMIT_RETRY_MS
        || (!open_router && agent.provider.is_some_and(exhausted))
}
/// No turn is left to protect: the process ended, its turn finished, or a limit ended it.
fn replaceable(r: &Record) -> bool {
    !r.snapshot.as_ref().is_some_and(|s| s.running) || ready(r) || limit_stopped(r)
}
pub(super) fn supported(t: &TerminalSpec) -> bool {
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
    ensure_available_to(store, project, target, auto, None)
}
/// As [`ensure_available`], also admitting a stage launched for the team that owns the worktree.
fn ensure_available_to(
    store: &Store,
    project: &str,
    target: &Path,
    auto: bool,
    chat_team: Option<&str>,
) -> Result<()> {
    ensure!(
        !store.owners.iter().any(|o| Path::new(&o.target) == target
            && !(o.project_id == project
                && ((auto && (o.kind == OwnerKind::Chat || o.kind == OwnerKind::Auto))
                    || (o.kind == OwnerKind::Chat && chat_team == Some(o.id.as_str()))))),
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
    chat_team: Option<&str>,
) -> Result<()> {
    if crate::git::repo_root(target).is_none() {
        return Ok(());
    }
    modify(root, |s| {
        ensure_available_to(s, project, target, auto, chat_team)
    })
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
                    && o.kind == OwnerKind::Auto
                    && o.id == id
            }) {
                return Ok(());
            }
            ensure_available(s, project, target, true)?;
            ensure!(
                !s.runs.iter().any(|r| Path::new(&r.target) == target
                    && !(r.project_id == project && r.auto.is_some())
                    && matches!(r.state, State::Running | State::Paused)
                    && !(r.chat_team.is_some() && r.jobs.iter().all(job_done))),
                "An unfinished provider run controls this worktree"
            );
            s.owners.push(Owner {
                project_id: project.into(),
                target: target.display().to_string(),
                kind: OwnerKind::Auto,
                id: id.into(),
            });
        } else {
            s.owners
                .retain(|o| !(o.project_id == project && o.kind == OwnerKind::Auto && o.id == id));
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
        ensure_available(s, project, target, true)?;
        let briefing = r.briefing_backup.as_deref().unwrap_or_default();
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
            presets: vec![],
            agent_roles: BTreeMap::new(),
            council: CouncilSettings::default(),
            limit: 2,
            rounds: vec![],
            requests: vec![],
            scopes: BTreeMap::new(),
            information_requests: vec![],
            continuation_request: None,
            saved_context: String::new(),
            current_plan: String::new(),
            original_briefing: retained_briefing(briefing),
            observed_agents: BTreeMap::new(),
            noted_agents: Default::default(),
            noted_since: BTreeMap::new(),
            status: None,
            messages: vec![],
            deliveries: vec![],
            reset: None,
            handoff: None,
            last_compaction_ms: None,
            // A new lead briefed with its role starts on the user's first message; an adopted
            // conversation or an earlier goal still needs the handoff.
            recovery: paused
                || !checkpoint.goal.trim().is_empty()
                || !briefing.contains(LEAD_ROLE_HEADING),
            quiet_recovery: false,
            checkpoint,
            checkpoint_required: false,
            last_reset_id: None,
            finished: FinishedWork::default(),
            error: None,
        };
        s.owners.push(Owner {
            project_id: project.into(),
            target: t.target.clone(),
            kind: OwnerKind::Chat,
            id: t.id.clone(),
        });
        s.teams.push(t.clone());
        Ok(t)
    })
}
/// End the team of a task whose worktree or branch was deleted: its context and worktree lease go
/// with it. Returns the team's agent sessions, wherever they run, for the caller to close.
/// Isolated worker worktrees stay, since they can hold unintegrated commits.
///
/// # Errors
/// Fails when the orchestration store can't be read or saved.
pub fn retire_task(root: &Path, project: &str, task: Option<&str>) -> Result<Vec<String>> {
    modify(root, |s| {
        let Some(index) = s
            .teams
            .iter()
            .position(|t| t.project_id == project && t.task.as_deref() == task)
        else {
            return Ok(vec![]);
        };
        let t = s.teams.remove(index);
        let mut sessions = std::collections::BTreeSet::from([t.lead.session_id.clone()]);
        sessions.extend(t.reset.iter().map(|r| r.next_session.clone()));
        for r in s
            .runs
            .iter_mut()
            .filter(|r| r.chat_team.as_deref() == Some(&t.id))
        {
            sessions.extend(
                r.jobs
                    .iter()
                    .chain(&r.coordinator)
                    .filter_map(|j| j.session_id.clone()),
            );
            if r.state != State::Complete {
                r.state = State::Stopped;
                clear_restart_notice(&mut r.error);
            }
        }
        s.owners
            .retain(|o| !(o.kind == OwnerKind::Chat && o.id == t.id));
        Ok(sessions.into_iter().collect())
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
        passive: false,
    });
    Ok(())
}
/// Queue a lead message that rides with its next delivery rather than starting a turn.
fn append_passive(t: &mut Team, id: String, text: String) -> Result<()> {
    append(t, id.clone(), "patchbay", LEAD_RECIPIENT, None, text)?;
    if let Some(m) = t.messages.iter_mut().find(|m| m.id == id) {
        m.passive = true;
    }
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
            return Ok((i, LEAD_RECIPIENT.into()));
        }
        if t.scopes
            .get(&launch.agent_session)
            .is_some_and(|scope| Some(scope.generation) == launch.generation)
            && r.metadata.task == t.task
        {
            return Ok((i, launch.agent_session.clone()));
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

/// Authorize a board edit with the same live lead ownership as workflow requests.
pub(crate) fn with_lead<T>(
    root: &Path,
    launch: &LaunchContext,
    records: &[Record],
    edit: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let _guard = super::LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (_, who) = actor(&load(root)?, launch, records)?;
    ensure!(
        who == LEAD_RECIPIENT,
        "Only the lead or a planner can edit the story board"
    );
    edit()
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
        let lead = who == LEAD_RECIPIENT;
        ensure!(
            lead || member(s, &t, &who).is_some()
                || matches!(
                    &command,
                    Command::Inspect | Command::Send { .. } | Command::Reply { .. }
                ),
            "Existing agents may inspect and coordinate messages only"
        );
        match command {
            Command::Inspect => {}
            Command::Ask { id, to, text } => {
                ensure!(lead, "Only the lead requests information");
                valid_id(&id)?;
                ensure!(
                    !text.trim().is_empty() && text.len() <= 32000,
                    "Invalid question"
                );
                if let Some(previous) = t.information_requests.iter().find(|r| r.id == id) {
                    ensure!(
                        previous.recipient == to && previous.question == text,
                        "Information request ID already used"
                    );
                } else {
                    let sid = member(s, &t, &to)
                        .and_then(|j| j.session_id.as_deref())
                        .unwrap_or(&to);
                    let recipient = record(records, &t.project_id, sid)?;
                    ensure!(
                        to != LEAD_RECIPIENT
                            && recipient.id != t.lead.session_id
                            && recipient.metadata.kind == crate::TerminalKind::Agent,
                        "Choose an existing agent"
                    );
                    ensure!(
                        member(s, &t, &to).is_some() || recipient.metadata.task == t.task,
                        "Agent is outside this worktree"
                    );
                    let generation = generation(recipient)?;
                    if let Some(job) = member(s, &t, &to) {
                        ensure!(
                            recipient.request_ids.last() == Some(&job.request_id),
                            "Assignment launch ownership changed"
                        );
                    }
                    if member(s, &t, &to).is_none() {
                        t.scopes.entry(to.clone()).or_insert(ScopeReservation {
                            generation,
                            components: vec![],
                            paths: vec![],
                        });
                        ensure!(
                            t.scopes[&to].generation == generation,
                            "Agent generation changed; coordinate its scope first"
                        );
                    }
                    t.information_requests.push(InformationRequest {
                        id: id.clone(),
                        recipient: to.clone(),
                        generation,
                        question: text.clone(),
                        response: None,
                        error: None,
                    });
                    append(
                        &mut t,
                        format!("ask-{id}"),
                        LEAD_RECIPIENT,
                        &to,
                        Some(to.clone()),
                        format!(
                            "Information request {id}: {text}\nReply through $PATCHBAY_CLI agent team-reply --id {id} --text <findings-progress-blockers-and-validation>. Keep working within your agreed scope."
                        ),
                    )?;
                }
            }
            Command::Reply { id, text } => {
                ensure!(
                    !lead && !text.trim().is_empty() && text.len() <= 32000,
                    "Invalid information response"
                );
                let request = t
                    .information_requests
                    .iter_mut()
                    .find(|r| r.id == id)
                    .ok_or_else(|| anyhow!("Unknown information request"))?;
                ensure!(
                    request.recipient == who && Some(request.generation) == launch.generation,
                    "Information request belongs to another agent generation"
                );
                ensure!(
                    request.error.is_none(),
                    "Information request is no longer active"
                );
                if let Some(previous) = &request.response {
                    ensure!(previous == &text, "Information response already recorded");
                } else {
                    request.response = Some(text.clone());
                    append(
                        &mut t,
                        format!("reply-{id}"),
                        &who,
                        LEAD_RECIPIENT,
                        Some(who.clone()),
                        format!(
                            "Response to information request {id} from {who} (reported; verify before claiming completion):\n{text}"
                        ),
                    )?;
                }
            }

            Command::Coordinate {
                session,
                components,
                paths,
            } => {
                ensure!(lead, "Only the lead coordinates scope");
                let r = record(records, &t.project_id, &session)?;
                ensure!(
                    r.metadata.task == t.task && session != t.lead.session_id,
                    "Agent is outside this worktree"
                );
                ensure!(
                    components
                        .iter()
                        .all(|id| project.components.iter().any(|c| &c.id == id)),
                    "Unknown component"
                );
                validate_paths(&paths)?;
                t.scopes.insert(
                    session,
                    ScopeReservation {
                        generation: generation(r)?,
                        components,
                        paths,
                    },
                );
            }
            Command::Request {
                id,
                action,
                settings,
            } => {
                ensure!(lead, "Only the lead can control workflows");
                valid_id(&id)?;
                let action = WorkflowAction::deserialize(serde_json::Value::String(action))
                    .ok()
                    .filter(|a| *a != WorkflowAction::Unknown)
                    .ok_or_else(|| anyhow!("Unknown workflow action"))?;
                ensure!(
                    serde_json::to_vec(&settings)?.len() <= MESSAGE_LIMIT,
                    "Settings too large"
                );
                if let Some(previous) = t.requests.iter().find(|r| r.id == id) {
                    ensure!(
                        previous.action == action && previous.settings == settings,
                        "Request ID already used"
                    );
                } else {
                    // A story id is checked once, when the request is made, so a replay of
                    // the same request survives the story's later deletion.
                    if let Some(story) = settings.get("story").filter(|v| !v.is_null()) {
                        ensure!(
                            matches!(
                                action,
                                WorkflowAction::StartPlan | WorkflowAction::StartAuto
                            ),
                            "Only startPlan and startAuto take a story"
                        );
                        // Auto links its story to the run's worktree; the project checkout has
                        // none unless the request creates one.
                        ensure!(
                            action != WorkflowAction::StartAuto
                                || t.task.is_some()
                                || new_worktree(&settings),
                            "Auto can take a story only in a worktree. Use newWorktree: true or ask the user to start one."
                        );
                        let story = story.as_str().unwrap_or_default();
                        ensure!(
                            crate::stories::load(root)?.iter().any(|s| s.id == story),
                            "Unknown story {story:?}. Run `agent stories` for the board's ids."
                        );
                    }
                    ensure!(
                        !new_worktree(&settings)
                            || (action == WorkflowAction::StartAuto
                                && settings["story"].is_string()),
                        "newWorktree is only for startAuto with a story"
                    );
                    // Pause, resume and stop may target the run of an earlier startAuto, such as
                    // a story's own worktree, instead of this worktree's.
                    if let Some(target) = settings.get("request").filter(|v| !v.is_null()) {
                        ensure!(
                            matches!(
                                action,
                                WorkflowAction::PauseAuto
                                    | WorkflowAction::ResumeAuto
                                    | WorkflowAction::StopAuto
                            ),
                            "Only pauseAuto, resumeAuto and stopAuto take a request"
                        );
                        let target = target.as_str().unwrap_or_default();
                        ensure!(
                            t.requests
                                .iter()
                                .any(|r| r.id == target && r.action == WorkflowAction::StartAuto),
                            "Unknown startAuto request {target:?}"
                        );
                    }
                    if action == WorkflowAction::StartCouncilReview {
                        ensure!(t.council.enabled, "Review council is disabled");
                        t.council.validate(&t.presets)?;
                    }
                    if action.is_stage() {
                        ensure!(!stage_active(&t), STAGE_ACTIVE);
                        ensure!(settings.is_object(), "Stage settings must be an object");
                        ensure!(
                            action != WorkflowAction::StartPlan
                                || settings["story"].is_string()
                                || settings["goal"]
                                    .as_str()
                                    .is_some_and(|goal| !goal.trim().is_empty()),
                            "startPlan needs the user's request as goal, or a story"
                        );
                        // Store immutable launch inputs separately from the caller's settings.
                    }
                    t.requests.push(WorkflowRequest {
                        id,
                        council_run: None,
                        council: (action == WorkflowAction::StartCouncilReview).then(|| {
                            (
                                t.council.clone(),
                                t.presets
                                    .iter()
                                    .filter(|p| t.council.members.contains(&p.id))
                                    .cloned()
                                    .collect(),
                            )
                        }),
                        action,
                        settings,
                        state: WorkflowState::Queued,
                        result: None,
                    });
                }
            }
            Command::Checkpoint { checkpoint } => {
                ensure!(lead, "Only the lead can checkpoint");
                ensure!(
                    serde_json::to_vec(&checkpoint)?.len() <= 64 * 1024,
                    "Checkpoint is too large"
                );
                t.checkpoint = checkpoint;
                t.checkpoint_required = false;
            }
            Command::Status { step, note } => {
                ensure!(lead, "Only the lead sets the chat status");
                ensure!(
                    LEAD_STEPS.contains(&step.as_str()),
                    "Unknown status step; use one of {}",
                    LEAD_STEPS.join(", ")
                );
                let note = note
                    .map(|note| note.trim().to_string())
                    .filter(|note| !note.is_empty());
                ensure!(
                    note.as_ref()
                        .is_none_or(|note| note.chars().count() <= STATUS_NOTE_LIMIT),
                    "Status note is too long"
                );
                t.status = Some(LeadStatus {
                    step,
                    note,
                    at_ms: crate::pty::now_ms(),
                });
            }
            Command::Delegate { .. } | Command::DelegateShared { .. } => {
                let shared = matches!(&command, Command::DelegateShared { .. });
                let (id, assignments) = match command {
                    Command::Delegate { id, assignments }
                    | Command::DelegateShared { id, assignments } => (id, assignments),
                    _ => unreachable!(),
                };
                ensure!(
                    lead && t.state == State::Running && t.reset.is_none(),
                    "Delegation is paused; ask the user to choose Continue work"
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
                ensure!(sub_builders_enabled(&t), "{SUB_BUILDERS_OFF}");
                ensure!(
                    shared
                        || s.runs.iter().all(|r| r.chat_team.as_deref() != Some(&t.id)
                            || matches!(r.state, State::Complete | State::Stopped)),
                    "Finish the existing round before delegating again"
                );
                ensure!(!assignments.is_empty(), "Create at least one assignment");
                ensure!(
                    assignments
                        .iter()
                        .all(|a| member(s, &t, &a.id).is_none() && a.id != LEAD_RECIPIENT),
                    "Assignment IDs must be unique across team rounds"
                );
                let tree = Path::new(&t.target);
                if !shared
                    && assignments
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
                    workers: if shared && !t.presets.is_empty() {
                        t.presets.clone()
                    } else {
                        t.workers.clone()
                    },
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
                                "Code delegation requires components in the target repository; tell the user this layout cannot be delegated"
                            );
                        }
                    }
                }
                add_assignments(&mut r, assignments)?;
                for job in &mut r.jobs {
                    job.shared_worktree = shared;
                    if shared {
                        job.task.clone_from(&t.task);
                    }
                }
                t.rounds.push(id);
                s.runs.push(r);
            }
            Command::Send { id, to, text } => {
                ensure!(
                    lead || to == LEAD_RECIPIENT,
                    "Workers communicate only with their owning lead"
                );
                ensure!(
                    to == LEAD_RECIPIENT
                        || member(s, &t, &to).is_some()
                        || (lead
                            && record(records, &t.project_id, &to)
                                .is_ok_and(|r| r.metadata.task == t.task)),
                    "Recipient belongs to another team or does not exist"
                );
                if lead && to != LEAD_RECIPIENT && member(s, &t, &to).is_none() {
                    let recipient = record(records, &t.project_id, &to)?;
                    ensure!(
                        recipient.metadata.kind == crate::TerminalKind::Agent,
                        "Recipient must be an agent"
                    );
                    let generation = generation(recipient)?;
                    if t.scopes
                        .get(&to)
                        .is_none_or(|scope| scope.generation != generation)
                    {
                        t.scopes.insert(
                            to.clone(),
                            ScopeReservation {
                                generation,
                                components: vec![],
                                paths: vec![],
                            },
                        );
                    }
                }
                append(
                    &mut t,
                    id,
                    &who,
                    &to,
                    if lead {
                        (to != LEAD_RECIPIENT).then(|| to.clone())
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
                    j.result_kind == ResultKind::Report || j.shared_worktree,
                    "Code assignments require committed results"
                );
                if let Some(previous) = &j.summary {
                    ensure!(previous == &summary, "Report already submitted");
                }
                j.summary = Some(summary.clone());
                j.state = JobState::Complete;
                j.error = None;
                let text = format!(
                    "Report from {} (committed baseline {}; shared workers report live worktree edits):\n{}",
                    who,
                    j.base.as_deref().unwrap_or(&r.source_revision),
                    summary
                );
                append(
                    &mut t,
                    format!("report-{}", j.request_id),
                    &who,
                    LEAD_RECIPIENT,
                    Some(who.clone()),
                    text,
                )?;
                if j.shared_worktree && j.result_kind == ResultKind::Code {
                    t.checkpoint_required = true;
                }
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
                    j.result_kind == ResultKind::Code && !j.shared_worktree,
                    "Shared and report assignments submit team-report without commits"
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
                    LEAD_RECIPIENT,
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
                ensure!(
                    s.runs
                        .iter()
                        .filter(
                            |r| r.chat_team.as_deref() == Some(&t.id) && r.state != State::Stopped
                        )
                        .all(|r| r.jobs.iter().all(job_done)),
                    "Every report must be submitted and every code result integrated"
                );
                for r in s
                    .runs
                    .iter_mut()
                    .filter(|r| r.chat_team.as_deref() == Some(&t.id) && r.state != State::Stopped)
                {
                    r.state = State::Complete;
                }
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
pub(super) fn validate_paths(paths: &[String]) -> Result<()> {
    ensure!(
        paths.iter().all(|p| !p.is_empty()
            && Path::new(p)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))),
        "Paths must be relative paths without . or .."
    );
    Ok(())
}
fn overlaps(a: &[String], ap: &[String], b: &[String], bp: &[String]) -> bool {
    if !ap.is_empty() && !bp.is_empty() {
        return ap.iter().any(|a| {
            bp.iter()
                .any(|b| Path::new(a).starts_with(b) || Path::new(b).starts_with(a))
        });
    }
    a.is_empty() || b.is_empty() || a.iter().any(|c| b.contains(c))
}
pub fn waiting(root: &Path, project: &str, run: &str, job: &str, reason: &str) -> Result<()> {
    modify(root, |s| {
        let r = s
            .runs
            .iter_mut()
            .find(|r| r.project_id == project && r.id == run)
            .ok_or_else(|| anyhow!("Unknown run"))?;
        if let Some(j) = r
            .jobs
            .iter_mut()
            .find(|j| j.id == job && j.state == JobState::Pending)
        {
            j.error = Some(reason.into());
        }
        Ok(())
    })
}
/// Existing agents start with the whole worktree reserved until the lead records an agreed scope.
pub fn shared_launch_available(
    root: &Path,
    project: &str,
    run: &str,
    job: &str,
    records: &[Record],
) -> Result<()> {
    modify(root, |s| {
        let r = s
            .runs
            .iter()
            .find(|r| r.id == run && r.project_id == project)
            .ok_or_else(|| anyhow!("Unknown run"))?;
        let Some(j) = r.jobs.iter().find(|j| j.id == job && j.shared_worktree) else {
            return Ok(());
        };
        if j.result_kind == ResultKind::Report {
            return Ok(());
        }
        let t = s
            .teams
            .iter()
            .find(|t| Some(&t.id) == r.chat_team.as_ref())
            .ok_or_else(|| anyhow!("Missing team"))?;
        for record in records.iter().filter(|record| {
            record.metadata.project_id == project
                && record.metadata.task == t.task
                && record.metadata.kind == crate::TerminalKind::Agent
                && record.id != t.lead.session_id
                && record
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| snapshot.running)
                && !ready(record)
        }) {
            if s.runs
                .iter()
                .filter(|r| r.chat_team.as_deref() == Some(&t.id))
                .flat_map(|r| &r.jobs)
                .any(|job| job.session_id.as_deref() == Some(&record.id))
            {
                continue;
            }
            let scope = t.scopes.get(&record.id);
            ensure!(
                scope.is_some_and(|scope| Some(scope.generation)
                    == record.snapshot.as_ref().map(|s| s.generation)
                    && !overlaps(&scope.components, &scope.paths, &j.components, &j.paths)),
                "Waiting for coordination: {} owns an overlapping or unknown scope. Contact it, then record the agreed scope with team-coordinate.",
                record.metadata.name
            );
        }
        Ok(())
    })
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
        ensure!(occupied < t.limit, "Sub-builder concurrency limit reached");
        let candidate = r.jobs.iter().find(|j| j.id == job).unwrap();
        if candidate.shared_worktree && candidate.result_kind == ResultKind::Code {
            ensure!(
                !s.runs
                    .iter()
                    .filter(|other| other.target == t.target && other.state != State::Stopped)
                    .flat_map(|r| &r.jobs)
                    .any(|other| other.id != job
                        && matches!(
                            other.state,
                            JobState::Launching | JobState::Running | JobState::Integrating
                        )
                        && other.result_kind == ResultKind::Code
                        && overlaps(
                            &candidate.components,
                            &candidate.paths,
                            &other.components,
                            &other.paths
                        )),
                "Waiting for coordination: another assignment owns this scope"
            );
        }
    }
    Ok(())
}

/// A `startAuto` that creates its own worktree: `newWorktree: true` or `{branch?, base?}`.
fn new_worktree(settings: &serde_json::Value) -> bool {
    settings
        .get("newWorktree")
        .is_some_and(|v| v.as_bool() == Some(true) || v.is_object())
}

const STAGE_ACTIVE: &str = "A plan, build, fix, review or merge is already active in this worktree";

fn stage_active(team: &Team) -> bool {
    team.requests.iter().any(|r| {
        r.action.is_stage()
            && matches!(
                r.state,
                WorkflowState::Queued
                    | WorkflowState::Starting
                    | WorkflowState::Running
                    | WorkflowState::Waiting
            )
    })
}

/// Preserve settled council reports before a later round reuses their lane files.
fn archive_council(root: &Path, id: &str, run: &mut serde_json::Value) -> Result<()> {
    let Some(branch) = run["branch"].as_str() else {
        return Ok(());
    };
    let folder = crate::reviews::dir(root)?
        .join("councils")
        .join(crate::workspace::session_id(
            id,
            crate::model::REVIEW_SCOPE,
            "council",
        ));
    std::fs::create_dir_all(&folder)?;
    for (index, member) in run["members"].as_array().into_iter().flatten().enumerate() {
        if !["done", "failed"].contains(&member["state"].as_str().unwrap_or("")) {
            continue;
        }
        let Some(lane) = member["preset"]["id"].as_str() else {
            continue;
        };
        let source = crate::reviews::lane_file(root, branch, Some(lane))?;
        let stamp = source.with_extension("json");
        let recorded: serde_json::Value = std::fs::read(&stamp)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if recorded["round"] != run["round"] {
            continue;
        }
        for (from, to) in [
            (source, folder.join(format!("{index}.md"))),
            (stamp, folder.join(format!("{index}.json"))),
        ] {
            if from.is_file() && !to.exists() {
                std::fs::copy(from, to)?;
            }
        }
    }
    run["archive"] = folder.display().to_string().into();
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
            Control::Catalog {
                presets,
                roles,
                council,
            } => {
                ensure!(presets.iter().all(supported), "Unsupported agent preset");
                council.validate(&presets)?;
                t.council = council;
                t.presets = presets;
                t.agent_roles = roles;
            }
            Control::RetryCouncil { id } => {
                ensure!(t.council.enabled, "Review council is disabled");
                ensure!(!stage_active(&t), STAGE_ACTIVE);
                let previous = t
                    .requests
                    .iter()
                    .find(|r| {
                        r.id == id
                            && r.action == WorkflowAction::StartCouncilReview
                            && r.state == WorkflowState::Failed
                    })
                    .ok_or_else(|| anyhow!("No failed council to retry"))?;
                let settings = previous.settings.clone();
                t.council.validate(&t.presets)?;
                t.requests.push(WorkflowRequest {
                    id: new_id(),
                    action: WorkflowAction::StartCouncilReview,
                    settings,
                    state: WorkflowState::Queued,
                    result: None,
                    council_run: None,
                    council: Some((
                        t.council.clone(),
                        t.presets
                            .iter()
                            .filter(|p| t.council.members.contains(&p.id))
                            .cloned()
                            .collect(),
                    )),
                });
            }
            Control::RequestState {
                id,
                state,
                mut result,
                passive,
            } => {
                ensure!(
                    !matches!(
                        state,
                        WorkflowState::Queued | WorkflowState::Uncertain | WorkflowState::Unknown
                    ),
                    "Invalid request state"
                );
                let request = t
                    .requests
                    .iter_mut()
                    .find(|r| r.id == id)
                    .ok_or_else(|| anyhow!("Unknown request"))?;
                ensure!(
                    match request.state {
                        WorkflowState::Queued | WorkflowState::Waiting => true,
                        WorkflowState::Starting => state != WorkflowState::Starting,
                        WorkflowState::Running => {
                            state == WorkflowState::Running || state.settled_label().is_some()
                        }
                        WorkflowState::Completed
                        | WorkflowState::Failed
                        | WorkflowState::Uncertain
                        | WorkflowState::Unknown => false,
                    },
                    "Request already claimed or finished"
                );
                ensure!(
                    result
                        .as_ref()
                        .is_none_or(|text| text.len() <= MESSAGE_LIMIT),
                    "Result too large"
                );
                if state == WorkflowState::Running
                    && request.action == WorkflowAction::StartCouncilReview
                {
                    let mut run =
                        serde_json::from_str(result.as_deref().context("Missing council state")?)?;
                    archive_council(root, &id, &mut run)?;
                    request.council_run = Some(run);
                }
                // A lead review's progress survives restarts like a council's. Its findings stay
                // in the regular review files, so there is nothing to archive.
                if state == WorkflowState::Running && request.action == WorkflowAction::StartReview
                {
                    request.council_run = Some(serde_json::from_str(
                        result.as_deref().context("Missing review state")?,
                    )?);
                }
                if state.settled_label().is_some()
                    && let Some(archive) = request
                        .council_run
                        .as_ref()
                        .and_then(|r| r["archive"].as_str())
                {
                    result = Some(format!(
                        "{}\nFull council reports: {archive}",
                        result.unwrap_or_default()
                    ));
                }
                request.state = state;
                request.result = result.clone();
                if let Some(outcome) = state.settled_label() {
                    let message = format!("workflow-{id}");
                    let text = format!("Workflow {id}: {outcome}. {}", result.unwrap_or_default());
                    if passive {
                        append_passive(&mut t, message, text)?;
                    } else {
                        append(&mut t, message, "patchbay", LEAD_RECIPIENT, None, text)?;
                    }
                }
            }
            Control::HistoryBoundary => t.saved_context.clear(),
            Control::Note { id, text, sessions } => {
                append_passive(&mut t, format!("note-{id}"), text)?;
                let now = crate::pty::now_ms();
                for session in sessions {
                    t.noted_since.entry(session.clone()).or_insert(now);
                    t.noted_agents.insert(session);
                }
            }
            Control::NotesDelivered { ids } => {
                for m in &mut t.messages {
                    if m.passive && m.state == DeliveryState::Pending && ids.contains(&m.id) {
                        m.state = DeliveryState::Delivered;
                    }
                }
            }
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
                        "Retry failed sub-builders before resuming"
                    );
                    if r.error.as_deref() == Some(RESTART_NOTICE)
                        || r.jobs
                            .iter()
                            .any(|j| j.launched_ms > 0 || j.session_id.is_some())
                    {
                        r.state = State::Running;
                        clear_restart_notice(&mut r.error);
                    }
                }
                if !s
                    .owners
                    .iter()
                    .any(|o| o.kind == OwnerKind::Chat && o.id == t.id)
                {
                    s.owners.push(Owner {
                        project_id: project.into(),
                        target: t.target.clone(),
                        kind: OwnerKind::Chat,
                        id: t.id.clone(),
                    });
                }
                t.recovery = true;
            }
            Control::Stop => {
                t.state = State::Stopped;
                clear_restart_notice(&mut t.error);
                t.reset = None;
                for r in s
                    .runs
                    .iter_mut()
                    .filter(|r| r.chat_team.as_deref() == Some(&t.id) && r.state != State::Complete)
                {
                    r.state = State::Stopped;
                    clear_restart_notice(&mut r.error);
                }
                s.owners
                    .retain(|o| !(o.kind == OwnerKind::Chat && o.id == t.id));
            }
            Control::Retry {
                assignment,
                terminal,
            } => {
                ensure!(
                    terminal.as_ref().is_none_or(supported),
                    "Choose a supported sub-builder preset"
                );
                let r = s
                    .runs
                    .iter_mut()
                    .find(|r| {
                        r.project_id == project
                            && r.chat_team.as_deref() == Some(&t.id)
                            && !matches!(r.state, State::Complete | State::Stopped)
                            && r.jobs.iter().any(|j| j.id == assignment)
                    })
                    .ok_or_else(|| anyhow!("Unknown assignment"))?;
                let j = r
                    .jobs
                    .iter_mut()
                    .find(|j| j.id == assignment)
                    .ok_or_else(|| anyhow!("Unknown assignment"))?;
                ensure!(
                    matches!(j.state, JobState::Failed | JobState::Launching),
                    "Only a failed or unconfirmed assignment can retry"
                );
                // An unconfirmed launch may still be live under its original agent.
                ensure!(
                    terminal.is_none() || j.state == JobState::Failed,
                    "Only a failed assignment can change agent"
                );
                // Failed owned sessions are stopped by the desktop before this operation.
                if j.state == JobState::Failed {
                    j.request_id = new_id();
                    j.session_id = None;
                }
                // `preset` stays the lead's request, so its delegation remains idempotent.
                if let Some(terminal) = terminal {
                    j.terminal = terminal;
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
                    "Choose supported Claude/Codex presets and 1–8 sub-builders"
                );
                let ids: HashSet<_> = workers.iter().map(|w| &w.id).collect();
                ensure!(
                    ids.len() == workers.len(),
                    "Sub-builder presets must be unique"
                );
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
                            kind: OwnerKind::Chat,
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
                        interrupt_current: false,
                        complete_task: false,
                        error: None,
                    });
                }
            }
            Control::CompleteTask { id, since_ms } => {
                valid_id(&id)?;
                if t.state != State::Stopped
                    && !t.finished.tasks.contains(&id)
                    && t.reset.as_ref().is_none_or(|r| r.id != id)
                {
                    complete_task(s, &mut t, project, id, since_ms, records)?;
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
        !s.owners.iter().any(|o| o.target == t.target
            && !(o.project_id == t.project_id
                && (o.kind == OwnerKind::Auto || (o.kind == OwnerKind::Chat && o.id == t.id)))),
        "Auto or another owner controls this worktree"
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
            "Sub-builder is outside this team"
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
            LEAD_RECIPIENT,
            Some(assignment.into()),
            format!("Side-thread message to {assignment}:\n{text}"),
        )?;
        Ok(t.clone())
    })
}
/// Heading of the lead's role in its launch briefing; a lead launched with it needs no
/// startup handoff, and a retained briefing ends before it.
pub(crate) const LEAD_ROLE_HEADING: &str = "## Lead role";
const INSTRUCTIONS: &str = r#"You are this worktree's persistent Patchbay lead. Remain available while agents and Auto run.

### How you work

- You coordinate agents and talk to the user. The user talks only to you: present coherent updates and final answers in this conversation, and never ask the user to relay worker messages.
- Agents do the work. You do not plan, implement, review, fix, merge, investigate or edit project files yourself, however small the task. Read team state, results and the saved plan only as far as coordinating and reporting need.
- When `team.agentRoles.worker` is missing or empty, sub-builders are off. Do not use `team-delegate`, `team-delegate-shared` or `startAgent`. For implementation use `startPlan` → `startBuild`, or `startAuto`. For investigation ask the user to turn sub-builders on. Never do the work yourself.
- Start the matching agent without asking permission to delegate:
  - Plan: when the user asks for a plan, request `startPlan` with their request as `goal`. When it completes, read `$PATCHBAY_PLAN_FILE` and summarize the plan. Do not build it unless asked.
  - Build: build a saved plan with `startBuild`. Other implementation goes to `code` workers when sub-builders are on.
  - Review: review this branch's changes with `startReview`, or `startCouncilReview` for several independent reviewers, never with a `report` worker.
  - Fix: fix review findings with `startFix`, only when the user asks.
  - Merge: merge with `startMerge`, only when the user asks for it. A clean review is not permission to merge.
  - When sub-builders are on, investigation and checks of the combined result go to `report` workers. A complete plan → build → review → merge pipeline goes to `startAuto`.
- For "what's next?", run `agent stories` and answer with its `next` item (its epic → feature, title and acceptance criteria), then offer to plan it or run Auto on it. Start work when the user asks and pass the item id as `story` to link and track it. Mention a linked worktree (`task`) when an item has one.
- When the user describes new work without asking for a plan, build or Auto run, run `agent stories` first. Then propose an epic, features and stories with acceptance criteria, using existing epics and features as parents where they fit and components from `agent team`. If the request leaves the outcome, acceptance criteria, components or parent open, ask about those together in that same message and offer your best guess as the default. Do not ask about what the request or the board already answers. Create the items after the user agrees and report their ids. Edit or reprioritize board items when asked. Patchbay saves story progress as stages run. Set status by hand only when the user asks or when recording work that happened outside Patchbay.
- Keep the chat status current with `agent team-status`: set it when you take on a request, when you start a stage and after each stage result. It is what the user sees as the state of the work.
- Do not use provider-native subagents. Use only Patchbay-managed workers and configured presets.
- Distinguish reported from verified results.

### Commands

Run each command below as {cli}.

- `agent team`: inspect authoritative state (team, inbox, rounds, presets, roles). Inspect it before delegating, and after native compaction or a new conversation; checkpoint, assignments, messages, commits and integration facts there are authoritative.
- `agent team-checkpoint --file <json>`: save a durable checkpoint `{goal, constraints, decisions, remaining, validation}` before delegating and after integration.
- `agent team-status --step <idle|planning|planReady|building|built|reviewing|reviewed|fixing|fixed|merging|merged> [--note <short-text>]`: set the status Chat shows. Use `idle` when a new topic has no work under way yet.
- `agent team-delegate-shared --id <id> --file <assignments-json>`: start configured agents in this existing worktree, without new worktrees. This is the usual way to delegate code. Shared workers finish with `team-report`, without commits or integration.
- `agent team-delegate --id <unique-round-id> --file <json-array>`: create a round of isolated workers. Each assignment has a globally unique `id`, `instructions`, `components`, `dependencies`, `preset` and `resultKind` (`report` or `code`). Report workers inspect the committed baseline; compare their findings with local edits. Isolated code delegation needs a clean Git checkpoint.
- `agent team-request --id <id> --action <startAgent|startPlan|startBuild|startReview|startFix|startMerge|startCouncilReview|startAuto|pauseAuto|resumeAuto|stopAuto> --file <settings-json>`: control existing workflows.
  - `startAgent` settings: `{preset: configured-preset-id, instructions: task, components: [component-ids], paths: [relative-file-or-directory-paths], resultKind: code or report}`. Role-to-preset mappings are in `team.agentRoles`; presets are in `team.presets` (or `team.workers` until the catalog loads).
  - `startPlan` settings: `{goal: the-user's-request, story: optional-story-id, components: optional-component-ids}`. With `story`, `goal` may be omitted: the planner receives that item's story briefing and a story still in progress is saved as Planned. A `goal` beside a story reaches the planner as the user's extra direction. Starts a planner under the plan role, which saves its plan for Plan and Build. Wait for its durable result. A failed result may mean the planner is waiting on a question.
  - `startBuild` settings: `{}`. Starts one implementation agent for this worktree's saved plan. Wait for its durable result, then inspect the work.
  - `startReview` settings: `{base: optional-branch-name, focus: optional-review-focus}`. Starts the configured reviewers against `base`, else the branch's last review base, else its merge destination. The result names the base used. Wait for it, then report the verdict and findings. The full report is in Review. It does not authorize fixes or merges.
  - `startFix` settings: `{}`. Starts a fix agent on this worktree's latest finished review. Wait for its durable result, then inspect the work.
  - `startMerge` settings: `{destination: optional-branch-name, commitSource: optional-change-list}`. Starts a merge agent for this worktree's branch into `destination`, else the default merge destination. With uncommitted changes it fails and lists them: ask the user, and only if they agree retry under a new id with exactly those entries as `commitSource`. A confirmed merge needs no report from you, because Chat shows it.
  - Only one `startPlan`, `startBuild`, `startFix`, `startReview`, `startCouncilReview` or `startMerge` can be active at a time.
  - `startAuto` accepts `goal`, `story` (a story id: the story's text becomes the goal and the story is linked to the run), `effort` (light/standard/thorough), `device`, `agents`, `reviewers`, `workers`, `merge` (`{mode: ask, destinationBranch}`), `stage`, `autonomous`, `background`, `resumeOnUsageReset` and `newWorktree` (`true` or `{branch, base}`, with `story` only: creates a worktree for that story, off `base` else the merge destination, without switching the user to it, and runs Auto there autonomously in the background); omit fields to use app defaults. Never automatically enable merge approval bypass. Its result arrives when the run settles: done, waiting for the user's merge approval, failed or stopped, or needing the user. Waits that resume by themselves (a usage reset, a scheduled resume, an autonomous restart) keep it running; any other pause counts as needing the user. A story's run that needed the user or was paused by them goes on after its result, and a later note says how it ended.
  - `pauseAuto`, `resumeAuto` and `stopAuto` settings: `{request: optional-startAuto-request-id}`. Without `request` they control this worktree's Auto; with it, the run that `startAuto` request started, such as a backlog story's worktree.
  - Backlog runs: when the user asks you to work through the board (for example "up to 6 stories, 3 at a time"; at most 3 at a time unless they say otherwise), read `agent stories` and start `next` with `startAuto` and `newWorktree: true`, under a new request id each time, until that many runs are active. Each settled result frees its slot: record it and start the next `next`, so a story that needs the user never holds up the rest. A story whose Auto did not start returns to the backlog: skip it for the following story rather than retrying it, unless the user asks. Stop starting stories at the user's total or when `next` is empty. Never merge, approve merges or answer agents' questions for the user. When the last run settles, summarize every story's worktree branch and state, those needing the user first.
  - `startCouncilReview` settings: `{base: branch-name, focus: optional-review-focus}`, only when `team.council.enabled`. Use only this workflow for a council and wait for its durable result. It uses additional model usage. Summarize its findings with reviewer attribution, consolidate duplicates, explain disagreements and incomplete coverage, and never discard findings by majority vote or treat failed/stale reviews as clean. Council review does not authorize fixes or merges.
- `agent stories [--id <story-id>]`: the story board in priority order (each epic, its features and their stories, then unassigned stories), with `next`, the top Backlog story without linked work. Stories show their saved stage and epics and features show Active or Closed. `--id` adds that item's full briefing as `section`.
- `agent story-create --kind <epic|feature|story> --title <title> [--parent <id>] [--description <text>] [--acceptance <criterion>]... [--component <id>]...`: create an item and get its saved record. A feature needs an epic. A story may belong to a feature or be unassigned.
- `agent story-update <id> [--title <title>] [--description <text>] [--acceptance <criterion>]... [--parent <id>] [--order <number>] [--status <backlog|planned|building|reviewing|merging|done> | --close | --reopen]`: edit an item and get its saved record. Use `--close` or `--reopen` for a parent's status. Lower order values come first among siblings. Pass an empty parent to unassign a story, or an empty criterion to clear the list.
- `agent team-coordinate --session <session-id> --file <json-array-of-component-ids> [--paths <relative-path> ...]`: record an existing agent's agreed components.
- `agent team-ask --id <request-id> --to <assignment-id-or-session-id> --text <question>`: gather progress, blockers, findings and validation from EXISTING agents before launching more work. Requests and responses are durable in `team.informationRequests`. Busy agents receive questions at their next ready prompt and respond with `agent team-reply --id <request-id> --text <response>`.
- `agent team-send --id <unique-id> --to <assignment-id> --text <message>`: route dependencies and messages. Workers contact only you.
- `agent team-integrate <assignment-id>`, then `agent team-finish --validation <checks-and-results>`: integrate code SERIALly, have a `report` worker verify the result (when sub-builders are off, record the checks that ran in `--validation` and offer `startReview` instead), checkpoint, then finish. If integration conflicts, stop and tell the user which assignment conflicted.

### Rules

- Inspect active sessions first and split independent scopes. Contact busy agents before overlapping edits, and wait for an explicit scope handoff; silence is not permission.
- Serialize Git mutations and preserve all local edits. Never automatically commit or stash user changes. While code workers run, keep target edits under coordinator control.
- Track every outstanding request and route dependencies yourself. Follow up a delayed reply with `team-send`; never launch a duplicate to replace it.
- Process exit is never success. Preserve workers and worktrees.

### When delegation is unavailable

If authentication, status hooks, the repository layout or local changes prevent delegation, or a stage cannot start, do not do the work yourself. Stop, explain the blocker and ask the user how to proceed."#;

/// The lead's coordination instructions, with commands spelled for this platform's shells.
pub(crate) fn lead_instructions() -> String {
    INSTRUCTIONS.replace("{cli}", &crate::context::agent_command("<command>"))
}
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
/// The briefing a handoff repeats: bounded, and without the role every handoff restates.
fn retained_briefing(text: &str) -> String {
    let text = text.split(LEAD_ROLE_HEADING).next().unwrap_or_default();
    excerpt(text.trim_end(), 8000)
}
fn recovery_text(s: &Store, t: &Team) -> Result<String> {
    let open_runs: Vec<_> = s
        .runs
        .iter()
        .filter(|r| r.chat_team.as_deref() == Some(&t.id) && !t.finished.rounds.contains(&r.id))
        .collect();
    let open_information: Vec<_> = t
        .information_requests
        .iter()
        .filter(|r| !t.finished.information.contains(&r.id))
        .collect();
    let open_workflows: Vec<_> = t
        .requests
        .iter()
        .filter(|r| !t.finished.workflows.contains(&r.id))
        .collect();
    let rounds: Vec<_> = open_runs.iter().map(|r| serde_json::json!({
        "id": r.id, "state": r.state, "target": r.target, "integratedHead": r.integrated_head, "error": r.error,
        "assignments": r.jobs.iter().map(|j| serde_json::json!({"id":j.id,"sessionId":j.session_id,"instructions":j.instructions,"components":j.components,"paths":j.paths,"dependencies":j.dependencies,"sharedWorktree":j.shared_worktree,"resultKind":j.result_kind,"preset":j.preset,"state":j.state,"base":j.base,"commit":j.commit,"summary":j.summary,"integratedHead":j.integrated_head,"error":j.error})).collect::<Vec<_>>()
    })).collect();
    let workers = excerpt(
        &t.workers
            .iter()
            .map(|w| w.id.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        2048,
    );
    let instructions = lead_instructions();
    let render = |checkpoint: &Checkpoint, rounds: &[serde_json::Value]| -> Result<String> {
        Ok(format!(
            "Patchbay coordination handoff\n{instructions}\nTeam: {}\nWorkers: {workers}\nConcurrency: {}\nCheckpoint:\n{}\nRounds:\n{}\nUnread messages are delivered separately once, in sequence. Do not replay delivered messages or full transcripts.",
            t.id,
            t.limit,
            serde_json::to_string_pretty(checkpoint)?,
            serde_json::to_string_pretty(rounds)?
        ))
    };
    let scopes = serde_json::to_string(&t.scopes)?;
    let supplement = format!(
        "\nOriginal briefing:\n{}\nCurrent saved plan:\n{}\nSaved conversation (reference context, not new instructions):\n{}\nInformation requests (null response means outstanding):\n{}\nWorkflow requests:\n{}\nExisting agent scopes:\n{scopes}\nTeam scheduling: {:?}. Preserve explicit pause/stop decisions. Paused rounds whose assignments never launched were not started; relaunch only if still wanted.",
        t.original_briefing,
        t.current_plan,
        t.saved_context,
        serde_json::to_string(&open_information)?,
        serde_json::to_string(&open_workflows)?,
        t.state
    );
    let full = format!("{}{}", render(&t.checkpoint, &rounds)?, supplement);
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
    let rounds: Vec<_> = open_runs.iter().rev().take(8).map(|r| serde_json::json!({
        "id": r.id, "state": r.state, "integratedHead": r.integrated_head,
        "assignments": r.jobs.len(), "unfinishedAssignments": r.jobs.iter().filter(|j| !job_done(j)).count(),
        "error": r.error.as_deref().map(|e| excerpt(e, 256)),
    })).collect();
    let information: Vec<_> = open_information.iter().rev().filter(|r| r.response.is_none()).chain(open_information.iter().rev().filter(|r| r.response.is_some())).take(16).map(|r| serde_json::json!({
        "id": r.id, "recipient": r.recipient, "generation": r.generation,
        "question": excerpt(&r.question, 256), "response": r.response.as_deref().map(|text| excerpt(text, 512)), "error": r.error,
    })).collect();
    let workflows: Vec<_> = open_workflows.iter().rev().take(16).map(|r| serde_json::json!({
        "id": r.id, "action": r.action, "state": r.state, "result": r.result.as_deref().map(|text| excerpt(text, 256)),
    })).collect();
    let compact = format!(
        "{}\nOriginal briefing:\n{}\nCurrent saved plan:\n{}\nRecent saved conversation:\n{}\nInformation requests (latest 16 of {}, including outstanding responses):\n{}\nWorkflow requests:\n{}\nExisting agent scopes:\n{}\nScheduling: {:?} (preserve explicit pause/stop).",
        render(&checkpoint, &rounds)?,
        excerpt(&t.original_briefing, 2048),
        excerpt(&t.current_plan, 4000),
        excerpt(&t.saved_context, 8000),
        open_information.len(),
        serde_json::to_string(&information)?,
        serde_json::to_string(&workflows)?,
        excerpt(&scopes, 2048),
        t.state,
    );
    let notice = "This handoff is abbreviated. The complete checkpoint, assignment instructions, results and older rounds remain in durable storage. Run $PATCHBAY_CLI agent team to inspect the complete state before continuing.";
    Ok(format!(
        "{}\n\n{notice}",
        excerpt(&compact, MESSAGE_LIMIT - notice.len() - 2)
    ))
}
/// Workers may still report. A failed assignment waits for a decision and is not running.
fn round_active(r: &Run) -> bool {
    r.state != State::Stopped
        && r.jobs
            .iter()
            .any(|j| !job_done(j) && j.state != JobState::Failed)
}
/// Rounds, questions or workflow requests the lead still has to follow.
fn team_active(s: &Store, t: &Team) -> bool {
    s.runs
        .iter()
        .any(|r| r.chat_team.as_deref() == Some(&t.id) && round_active(r))
        || t.information_requests
            .iter()
            .any(|r| r.response.is_none() && r.error.is_none())
        || t.requests.iter().any(|r| r.state.settled_label().is_none())
}
/// Work begun after the task finished belongs to the lead's current conversation.
fn lead_moved_on(s: &Store, t: &Team, lead: &Record, since_ms: Option<u64>) -> bool {
    let snapshot = lead.snapshot.as_ref();
    snapshot.is_some_and(|s| s.running) && !ready(lead)
        || since_ms.is_some_and(|since| {
            snapshot
                .and_then(|s| s.status.agent.as_ref())
                .is_some_and(|a| a.since_ms >= since)
        })
        || team_active(s, t)
}
/// Decide a completion once. It joins a pending fresh conversation rather than competing with it.
fn complete_task(
    s: &Store,
    t: &mut Team,
    project: &str,
    id: String,
    since_ms: Option<u64>,
    records: &[Record],
) -> Result<()> {
    // The merge that finished this task may be the lead's own stage. It is done, so it neither
    // counts as open work nor needs reporting.
    for r in t.requests.iter_mut().filter(|r| {
        r.action == WorkflowAction::StartMerge
            && matches!(r.state, WorkflowState::Starting | WorkflowState::Running)
    }) {
        r.state = WorkflowState::Completed;
        r.result = Some("Merge confirmed.".into());
    }
    let lead = record(records, project, &t.lead.session_id).ok();
    if !lead.is_some_and(|r| lead_moved_on(s, t, r, since_ms)) {
        if let Some(reset) = &mut t.reset {
            // A prepared launch already carries the finished task in its briefing.
            ensure!(
                reset.clear_history && reset.launch.is_none(),
                "A lead replacement is already pending"
            );
            reset.complete_task = true;
        } else if lead.is_some() {
            ensure_available_for_team(s, t)?;
            t.reset = Some(Reset {
                launch: None,
                id: id.clone(),
                next_session: t.lead.session_id.clone(),
                phase: ResetPhase::Queued,
                clear_history: true,
                interrupt_current: false,
                complete_task: true,
                error: None,
            });
        } else {
            // Nothing to replace: the next continuation starts from the cleared state.
            finish_task(t, &s.runs, records);
            t.lead.conversation = None;
            t.recovery = true;
        }
    }
    t.finished.tasks.insert(id);
    Ok(())
}
/// A confirmed replacement after finished work: nothing tells the new lead to continue it.
fn finish_task(t: &mut Team, runs: &[Run], records: &[Record]) {
    let id = t.id.clone();
    t.status = Some(LeadStatus {
        step: "idle".into(),
        note: None,
        at_ms: crate::pty::now_ms(),
    });
    let rounds: Vec<_> = runs
        .iter()
        .filter(|r| r.chat_team.as_deref() == Some(&id))
        .collect();
    t.finished.rounds.extend(
        rounds
            .iter()
            .filter(|r| r.state == State::Stopped || r.jobs.iter().all(job_done))
            .map(|r| r.id.clone()),
    );
    let answered: Vec<_> = t
        .information_requests
        .iter()
        .filter(|r| r.response.is_some() || r.error.is_some())
        .map(|r| r.id.clone())
        .collect();
    t.finished.information.extend(answered);
    let settled: Vec<_> = t
        .requests
        .iter()
        .filter(|r| r.state.settled_label().is_some())
        .map(|r| r.id.clone())
        .collect();
    t.finished.workflows.extend(settled);
    // Messages stay stored, so their stable ids can't be queued again.
    let active: HashSet<_> = rounds
        .iter()
        .filter(|r| round_active(r))
        .flat_map(|r| r.jobs.iter().map(|j| j.id.as_str()))
        .collect();
    for m in t.messages.iter_mut().filter(|m| {
        m.recipient == LEAD_RECIPIENT
            && m.state == DeliveryState::Pending
            && m.assignment
                .as_deref()
                .is_none_or(|assignment| !active.contains(assignment))
    }) {
        m.state = DeliveryState::Delivered;
    }
    // Only agents still working have a finish the new lead needs to hear about.
    let working: HashSet<_> = records
        .iter()
        .filter(|r| r.snapshot.as_ref().is_some_and(|s| s.running) && !ready(r))
        .map(|r| r.id.as_str())
        .collect();
    t.observed_agents
        .retain(|session, _| working.contains(session.as_str()));
    t.noted_agents
        .retain(|session| working.contains(session.as_str()));
    t.noted_since
        .retain(|session, _| working.contains(session.as_str()));
    t.checkpoint.goal.clear();
    t.checkpoint.decisions.clear();
    t.checkpoint.remaining = "No task is in progress. Wait for the user's next request.".into();
    t.checkpoint.validation.clear();
    t.saved_context.clear();
    t.current_plan.clear();
    t.original_briefing.clear();
}
pub(super) fn restore(s: &mut Store, project: &str) {
    for t in s.teams.iter_mut().filter(|t| t.project_id == project) {
        if t.state == State::Running {
            t.state = State::Paused;
            t.error = Some(RESTART_NOTICE.into());
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
                for request in &mut t.requests {
                    if request.state == WorkflowState::Starting {
                        request.state = WorkflowState::Uncertain;
                        request.result = Some("Control interrupted after its durable claim. Inspect active agents and Auto before issuing another request.".into());
                    }
                }
                if t.state == State::Running {
                    t.state = State::Paused;
                    t.error = Some(RESTART_NOTICE.into());
                }
                for m in &mut t.messages {
                    if m.state == DeliveryState::Sending {
                        m.state = DeliveryState::Uncertain;
                    }
                }
            }
            let failed_requests: Vec<_> = t
                .information_requests
                .iter()
                .filter(|q| q.response.is_none() && q.error.is_none())
                .filter_map(|q| {
                    let sid = member(s, &t, &q.recipient)
                        .and_then(|j| j.session_id.as_deref())
                        .unwrap_or(&q.recipient);
                    let reason = match record(records, project, sid) {
                        Err(_) => Some("Agent session is unavailable"),
                        Ok(r) if generation(r).ok() != Some(q.generation) => {
                            Some("Agent generation changed")
                        }
                        Ok(r) if r.snapshot.as_ref().is_none_or(|s| !s.running) => {
                            Some("Agent exited before replying")
                        }
                        _ => None,
                    }?;
                    Some((q.id.clone(), reason.to_string()))
                })
                .collect();
            for (id, reason) in failed_requests {
                t.information_requests
                    .iter_mut()
                    .find(|q| q.id == id)
                    .unwrap()
                    .error = Some(reason.clone());
                append(
                    &mut t,
                    format!("ask-failed-{id}"),
                    "patchbay",
                    LEAD_RECIPIENT,
                    None,
                    format!(
                        "Information request {id} was not answered: {reason}. Inspect its saved work and choose a follow-up; no replacement worker was launched."
                    ),
                )?;
            }
            for record in records
                .iter()
                .filter(|r| {
                    r.metadata.project_id == project
                        && r.metadata.task == t.task
                        && r.metadata.kind == crate::TerminalKind::Agent
                })
                .collect::<Vec<_>>()
            {
                if record.id == t.lead.session_id
                    || s.runs
                        .iter()
                        .filter(|r| r.chat_team.as_deref() == Some(&t.id))
                        .flat_map(|r| &r.jobs)
                        .any(|j| j.session_id.as_deref() == Some(&record.id))
                {
                    continue;
                }
                let Some(snapshot) = &record.snapshot else {
                    continue;
                };
                let observed = t.observed_agents.get(&record.id) == Some(&snapshot.generation);
                // Noted work that ended before any pass saw it working: its process exited,
                // or stopped a turn since the note (a reused agent may still show the turn
                // before it). Left noted, it would quiet a later finish.
                let noted_ms = t.noted_since.get(&record.id).copied();
                let unseen = !observed
                    && t.noted_agents.contains(&record.id)
                    && (!snapshot.running
                        || (ready(record)
                            && snapshot.status.agent.as_ref().is_some_and(|a| {
                                a.state == crate::status::AgentState::Review
                                    && noted_ms.is_some_and(|at| a.since_ms >= at)
                            })));
                if unseen || (observed && (ready(record) || !snapshot.running)) {
                    let notice_id =
                        format!("external-finished-{}-{}", record.id, snapshot.generation);
                    let notice = format!(
                        "Existing agent {} reached a ready prompt or exited. Inspect its results and validation before treating the work as complete.",
                        record.metadata.name
                    );
                    // Chat already shows directly launched stages, and a merge ends the task.
                    // Both notices can wait for the lead's next turn.
                    t.noted_since.remove(&record.id);
                    let noted = t.noted_agents.remove(&record.id);
                    if noted || record.metadata.component_id == crate::model::MERGE_SCOPE {
                        append_passive(&mut t, notice_id, notice)?;
                    } else {
                        append(&mut t, notice_id, "patchbay", LEAD_RECIPIENT, None, notice)?;
                    }
                    t.observed_agents.remove(&record.id);
                } else if snapshot.running && !ready(record) {
                    t.observed_agents
                        .insert(record.id.clone(), snapshot.generation);
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
                        if reset.complete_task {
                            finish_task(&mut t, &s.runs, records);
                        }
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
                            complete_task: reset.complete_task,
                        });
                        t.last_reset_id = Some(reset.id.clone());
                        t.reset = None;
                        t.recovery = true;
                        t.quiet_recovery = reset.clear_history;
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
                        j.error.clone().unwrap_or_else(|| {
                            "Sub-builder exited without an explicit result".into()
                        }),
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
                    LEAD_RECIPIENT,
                    Some(assignment.clone()),
                    format!(
                        "Worker {assignment} needs input: {question}. Use Sessions to open its terminal. Route its question and dependencies through the lead conversation. Automated delivery waits for a ready prompt."
                    ),
                )?;
            }
            for (id, assignment, error) in notices {
                // Every pass rebuilds these, and a saved one keeps the wording it was sent with.
                if t.messages.iter().any(|m| m.id == id) {
                    continue;
                }
                append(
                    &mut t,
                    id,
                    &assignment,
                    LEAD_RECIPIENT,
                    Some(assignment.clone()),
                    format!(
                        "Worker {assignment} failed: {error}. Inspect it, then Retry or tell the user."
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
    prepare_lead(root, project, project_id, id, terminal, request_id, true)
}
fn prepare_lead(
    root: &Path,
    project: &Project,
    project_id: &str,
    id: &str,
    terminal: TerminalSpec,
    request_id: String,
    clear_history: bool,
) -> Result<Team> {
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
        let mut spec = context::chat_session_spec(
            &mapped,
            &[],
            &terminal,
            t.task.as_deref(),
            &AllowAll,
            &[ContextSection {
                title: "Persistent chat lead".into(),
                body: recovery_text(s, &t)?,
            }],
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
        spec.id.clone_from(&next_session);
        if clear_history && t.state == State::Stopped {
            s.owners.push(Owner {
                project_id: project_id.into(),
                target: t.target.clone(),
                kind: OwnerKind::Chat,
                id: t.id.clone(),
            });
        }
        let t = team(s, project_id, id)?;
        if clear_history && t.state == State::Stopped {
            t.state = State::Running;
        }
        t.reset = Some(Reset {
            id: request_id,
            next_session,
            phase: ResetPhase::Queued,
            clear_history,
            interrupt_current: clear_history,
            complete_task: false,
            error: None,
            launch: Some(LeadLaunch { metadata, spec }),
        });
        Ok(t.clone())
    })
}
/// Retain a bounded original briefing before a session can be forgotten.
pub fn retain_briefing(root: &Path, project: &str, id: &str, text: &str) -> Result<Team> {
    modify(root, |s| {
        let t = team(s, project, id)?;
        if t.original_briefing.is_empty() {
            t.original_briefing = retained_briefing(text);
        }
        Ok(t.clone())
    })
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationFailure {
    pub kind: FailureKind,
    pub message: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    Authentication,
    Access,
    Configuration,
    Connection,
    Uncertain,
}
impl ContinuationFailure {
    pub fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn from_error(error: anyhow::Error) -> Self {
        error
            .downcast_ref::<Self>()
            .cloned()
            .unwrap_or_else(|| Self::new(FailureKind::Configuration, format!("{error:#}")))
    }
}
impl std::fmt::Display for ContinuationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ContinuationFailure {}

/// A continuation resolves the durable lead before the pending user message is delivered.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Continuation {
    pub session: Record,
    pub generation: u64,
    pub outcome: ContinuationOutcome,
    pub team: Team,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContinuationOutcome {
    Connected,
    Resumed,
    Reconstructed,
}

/// Reconnect, resume the exact conversation, or reconstruct only confirmed missing history.
/// Launch identities survive lost replies. Scheduling pause/stop decisions are never changed.
pub fn continue_lead(
    root: &Path,
    project: &Project,
    project_id: &str,
    id: &str,
    saved_context: &str,
    mut call: impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<Continuation> {
    use crate::session::ChatResume;
    // Reserve and submit under the durable store lock. A second caller samples sessions only
    // after the first caller's launch decision, so stale frontend snapshots cannot launch twice.
    let (outcome, records) = modify(root, |s| {
        let records: Vec<Record> = serde_json::from_value(call(Request::List)?)?;
        let t = team(s, project_id, id)?;
        let plan = crate::plans::read(root, t.task.as_deref())?;
        t.saved_context = excerpt(saved_context, 16000);
        t.current_plan = excerpt(&plan.text, 8000);
        if t.reset.is_some() {
            return Ok((ContinuationOutcome::Reconstructed, records));
        }
        let current = records
            .iter()
            .find(|r| r.id == t.lead.session_id && r.metadata.project_id == project_id);
        if let Some(r) = current {
            ensure!(r.metadata.task == t.task, "Lead is outside this worktree");
            if r.snapshot.as_ref().is_some_and(|s| s.running) {
                ensure!(
                    !r.interrupted,
                    "The session service disconnected. Reconnect and retry; your draft was kept."
                );
                let outcome = if t
                    .continuation_request
                    .as_ref()
                    .is_some_and(|request| r.request_ids.contains(request))
                {
                    ContinuationOutcome::Resumed
                } else {
                    ContinuationOutcome::Connected
                };
                return Ok((outcome, records));
            }
            let request_id = t.continuation_request.get_or_insert_with(new_id).clone();
            let sid = t.lead.session_id.clone();
            save(root, s)?;
            // A transport failure leaves the same request reserved for reconciliation/retry.
            // The person's message asked for it, like a manual resume.
            match serde_json::from_value::<ChatResume>(call(Request::ChatResume {
                id: sid,
                request_id,
                manual: true,
            })?)? {
                ChatResume::Resumed => return Ok((ContinuationOutcome::Resumed, records)),
                ChatResume::HistoryUnavailable { .. } => {}
                ChatResume::Failed { error, failure } => {
                    team(s, project_id, id)?.continuation_request = None;
                    save(root, s)?;
                    let kind = match failure {
                        crate::session::ResumeFailure::Authentication => {
                            FailureKind::Authentication
                        }
                        crate::session::ResumeFailure::Access => FailureKind::Access,
                        crate::session::ResumeFailure::Configuration => FailureKind::Configuration,
                    };
                    return Err(ContinuationFailure::new(
                        kind,
                        format!("{error}. Your draft was kept."),
                    )
                    .into());
                }
            }
        }
        Ok((ContinuationOutcome::Reconstructed, records))
    })?;
    reconcile(root, project_id, &records, false)?;
    if outcome == ContinuationOutcome::Reconstructed {
        let t = list(root, project_id)?
            .into_iter()
            .find(|t| t.id == id)
            .context("Unknown chat team")?;
        if t.reset.is_none() {
            // Retained records keep the original private launch settings and briefing. Forgotten
            // sessions rebuild using the exact saved preset and durable coordination context.
            if let Some(r) = records.iter().find(|r| r.id == t.lead.session_id) {
                modify(root, |s| {
                    let t = team(s, project_id, id)?;
                    if t.reset.is_none() {
                        t.reset = Some(Reset {
                            id: new_id(),
                            next_session: r.id.clone(),
                            phase: ResetPhase::Queued,
                            clear_history: false,
                            interrupt_current: false,
                            complete_task: false,
                            error: None,
                            launch: None,
                        });
                    }
                    Ok(())
                })?;
            } else {
                let mut terminal = t.lead.preset.clone();
                terminal.id = format!("chat-recovery-{}", new_id());
                prepare_lead(root, project, project_id, id, terminal, new_id(), false)?;
            }
        }
        // Reconcile a possibly accepted launch before retrying its durable identity.
        let fresh: Vec<Record> = serde_json::from_value(call(Request::List)?)?;
        reconcile(root, project_id, &fresh, false)?;
        modify(root, |s| {
            if let Some(reset) = &mut team(s, project_id, id)?.reset {
                ensure!(
                    !reset.clear_history,
                    "An explicit conversation change is pending. Wait for it to finish."
                );
                reset.phase = ResetPhase::Queued;
                reset.error = None;
            }
            Ok(())
        })?;
        replace_lead(root, project_id, id, &fresh, &mut call)?;
    }
    let records: Vec<Record> = serde_json::from_value(call(Request::List)?)?;
    reconcile(root, project_id, &records, false)?;
    let t = list(root, project_id)?
        .into_iter()
        .find(|t| t.id == id)
        .context("Unknown chat team")?;
    ensure!(
        t.reset.is_none(),
        "{}",
        t.reset.as_ref().and_then(|r| r.error.as_deref()).unwrap_or(
            "Lead connection is pending. Retry to reconcile the same launch; your draft was kept."
        )
    );
    let r = record(&records, project_id, &t.lead.session_id)?.clone();
    let generation = generation(&r)?;
    ensure!(
        r.snapshot.as_ref().is_some_and(|s| s.running),
        "The lead exited. Inspect its terminal, then retry; your draft was kept."
    );
    let t = modify(root, |s| {
        let t = team(s, project_id, id)?;
        t.continuation_request = None;
        Ok(t.clone())
    })?;
    Ok(Continuation {
        session: r,
        generation,
        outcome,
        team: t,
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
        let current = record(records, project, &t.lead.session_id);
        // Pausing holds recovery of a forgotten lead, not the user replacing a live one.
        let chosen = reset.interrupt_current && current.is_ok();
        if (t.state != State::Running && reset.clear_history && !chosen)
            || reset.phase != ResetPhase::Queued
        {
            return Ok(());
        }
        if let Ok(current) = current
            && (generation(current)? != t.lead.generation
                || (!reset.interrupt_current && !replaceable(current)))
        {
            return Ok(());
        }
        let request = if let Some(launch) = &reset.launch {
            let mut spec = launch.spec.clone();
            for key in crate::agent_bridge::BRIDGE_ENV {
                spec.env.remove(key);
            }
            // A replacement lead is Chat's own launch, whoever started the one it replaces.
            spec.manual = false;
            Request::NewConversation {
                request_id: reset.id.clone(),
                metadata: Box::new(launch.metadata.clone()),
                spec,
            }
        } else {
            let next = record(records, project, &reset.next_session)?;
            if !replaceable(next) {
                return Ok(());
            }
            Request::ResetConversation {
                id: next.id.clone(),
                request_id: reset.id.clone(),
                generation: generation(next)?,
                purpose: Some(crate::pty::LaunchPurpose::Chat),
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
            if t.state == State::Running {
                t.state = State::Paused;
            }
            t.error = Some(format!(
                "Lead replacement unconfirmed: {e}. History and sub-builders are preserved. Resume reconciles the same launch."
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
    call: impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<()> {
    let now_ms = crate::pty::now_ms();
    // Read only once a held recipient's retry delay has passed.
    let usage = std::cell::OnceCell::new();
    deliver_at(
        root,
        project,
        id,
        records,
        now_ms,
        |provider| {
            usage
                .get_or_init(|| crate::usage::read(now_ms))
                .exhausted(provider, now_ms)
        },
        call,
    )
}
fn deliver_at(
    root: &Path,
    project: &str,
    id: &str,
    records: &[Record],
    now_ms: u64,
    mut exhausted: impl FnMut(crate::adapters::Adapter) -> bool,
    mut call: impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<()> {
    modify(root, |s| {
        let mut t = team(s, project, id)?.clone();
        if t.reset.is_some() {
            return Ok(());
        }
        if t.recovery
            && record(records, project, &t.lead.session_id).is_ok_and(|r| {
                ready(r)
                    && !limit_held(r, now_ms, &mut exhausted)
                    && generation(r).ok() == Some(t.lead.generation)
            })
        {
            let text = recovery_text(s, &t)?;
            // A cleared lead with nothing to follow stays quiet until the user speaks.
            if std::mem::take(&mut t.quiet_recovery) && !team_active(s, &t) {
                append_passive(&mut t, new_id(), text)?;
            } else {
                append(&mut t, new_id(), "patchbay", LEAD_RECIPIENT, None, text)?;
            }
            t.recovery = false;
        }
        let recipients: HashSet<_> = t
            .messages
            .iter()
            .filter(|m| m.state == DeliveryState::Pending && !m.passive)
            .map(|m| m.recipient.clone())
            .collect();
        // The durable reserve blocks another desktop drive even if the transport loses its reply.
        for recipient in recipients {
            if recipient != LEAD_RECIPIENT && t.state != State::Running {
                continue;
            }
            if t.messages.iter().any(|m| {
                m.recipient == recipient
                    && matches!(m.state, DeliveryState::Sending | DeliveryState::Uncertain)
            }) {
                continue;
            }
            let sid = if recipient == LEAD_RECIPIENT {
                Some(t.lead.session_id.clone())
            } else {
                member(s, &t, &recipient)
                    .and_then(|j| j.session_id.clone())
                    .or_else(|| {
                        record(records, project, &recipient)
                            .ok()
                            .filter(|r| r.metadata.task == t.task)
                            .map(|r| r.id.clone())
                    })
            };
            let Some(r) = sid
                .as_deref()
                .and_then(|sid| record(records, project, sid).ok())
            else {
                continue;
            };
            if !ready(r) || limit_held(r, now_ms, &mut exhausted) {
                continue;
            }
            if recipient != LEAD_RECIPIENT
                && member(s, &t, &recipient)
                    .is_some_and(|j| r.request_ids.last() != Some(&j.request_id))
            {
                continue;
            }
            let generation = generation(r)?;
            if recipient != LEAD_RECIPIENT
                && member(s, &t, &recipient).is_none()
                && t.scopes
                    .get(&recipient)
                    .is_none_or(|scope| scope.generation != generation)
            {
                continue;
            }
            if recipient == LEAD_RECIPIENT && generation != t.lead.generation {
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
                    m.state = match &result {
                        Ok(_) => DeliveryState::Delivered,
                        Err(error) if error.is::<DeliveryRefused>() => DeliveryState::Pending,
                        Err(_) => DeliveryState::Uncertain,
                    };
                }
            }
            if let Err(e) = result
                && !e.is::<DeliveryRefused>()
            {
                t.error = Some(format!(
                    "Delivery unconfirmed: {e}. Inspect the recipient’s terminal in Sessions, then resolve delivery inline in Chat."
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

    #[test]
    fn persisted_chat_workflows_and_owners_round_trip_with_existing_wire_values() {
        let actions = [
            "startAgent",
            "startPlan",
            "startBuild",
            "startReview",
            "startFix",
            "startMerge",
            "startCouncilReview",
            "startAuto",
            "pauseAuto",
            "resumeAuto",
            "stopAuto",
        ];
        let states = [
            "queued",
            "waiting",
            "starting",
            "running",
            "completed",
            "uncertain",
            "failed",
        ];
        let requests: Vec<_> = actions
            .into_iter()
            .zip(states.into_iter().cycle())
            .map(|(action, state)| {
                serde_json::json!({
                    "id": action, "action": action, "state": state, "settings": {}, "result": null,
                    "council": null, "councilRun": null
                })
            })
            .collect();
        let saved = serde_json::json!({
            "teams": [{
                "id": "team", "projectId": "p", "task": null, "target": "/repo",
                "lead": {
                    "sessionId": "lead-session", "generation": 1, "conversation": null,
                    "preset": {"id": "codex", "name": "Codex", "kind": "agent", "command": "codex"}
                },
                "state": "running", "workers": [], "limit": 1, "rounds": [], "requests": requests,
                "checkpoint": {"goal": "", "constraints": "", "decisions": "", "remaining": "", "validation": ""},
                "messages": [], "deliveries": [], "recovery": false
            }],
            "owners": [
                {"projectId": "p", "target": "/repo", "kind": "chat", "id": "team"},
                {"projectId": "p", "target": "/other", "kind": "auto", "id": "run"}
            ],
            "runs": []
        });
        let store: Store = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(
            store.teams[0].requests[0].action,
            WorkflowAction::StartAgent
        );
        assert_eq!(store.teams[0].requests[0].state, WorkflowState::Queued);
        assert_eq!(store.owners[0].kind, OwnerKind::Chat);
        let resaved = serde_json::to_value(store).unwrap();
        assert_eq!(
            resaved["teams"][0]["requests"],
            saved["teams"][0]["requests"]
        );
        assert_eq!(resaved["owners"], saved["owners"]);
        // Another build's values still load instead of making the whole store unreadable.
        let mut newer = saved;
        newer["teams"][0]["requests"][0]["action"] = "startSomethingNew".into();
        newer["teams"][0]["requests"][1]["state"] = "somethingNew".into();
        newer["owners"][0]["kind"] = "somethingNew".into();
        let store: Store = serde_json::from_value(newer).unwrap();
        assert_eq!(store.teams[0].requests[0].action, WorkflowAction::Unknown);
        assert_eq!(store.teams[0].requests[1].state, WorkflowState::Unknown);
        assert_eq!(store.owners[0].kind, OwnerKind::Unknown);
    }

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
            spec: SessionSpec { purpose: crate::pty::LaunchPurpose::Ordinary, id: sid.into(), command: "codex".into(), resume_command: None, rerun_on_resume: false, owns_briefing: false, exclusive_cwd: false, manual: false, merge_source: None, cwd: root.into(), env: BTreeMap::new(), ready_when: String::new(), service: false, notice: None, dirs: vec![] },
            snapshot: Some(Snapshot { chat_startup: None, launch_directory: None, truncated: false, data: vec![], end: 0, generation: 1, running: true, exit_code: None, started_ms: 1, exited_ms: None,
                status: SessionStatus { agent: Some(AgentReport { state: AgentState::Idle, since_ms: 10, message: None, prompt: None, provider: Some(crate::adapters::Adapter::Codex), conversation_id: Some("c1".into()), turn_id: Some("turn1".into()), authoritative: true, approval_pending: false, questions: None, limit_stopped_ms: None }), ..Default::default() }, activity: vec![], replies: vec![], last_reply: None, notice: None }),
            history: vec![], launch_command: String::new(), restart_context: None, briefing_backup: None, interrupted: false, request_ids: vec!["lead-request".into()],
        }
    }
    impl Fixture {
        fn new() -> Self {
            let mut fixture = Self::new_without_sub_builders();
            fixture.team =
                fixture.set_worker_roles(BTreeMap::from([(WORKER_ROLE.into(), vec![preset().id])]));
            fixture
        }
        fn new_without_sub_builders() -> Self {
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
        fn set_worker_roles(&self, roles: BTreeMap<String, Vec<String>>) -> Team {
            control(
                &self.dir,
                "p",
                &self.team.id,
                Control::Catalog {
                    presets: vec![preset()],
                    roles,
                    council: CouncilSettings::default(),
                },
                std::slice::from_ref(&self.lead),
            )
            .unwrap()
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
            paths: vec![],
            id: id.into(),
            instructions: format!("Do {id}"),
            components: vec![],
            dependencies: deps.iter().map(|s| (*s).into()).collect(),
            preset: "codex".into(),
            result_kind: kind,
        }
    }
    #[test]
    fn path_reservations_allow_disjoint_work_and_cover_directories() {
        assert!(!overlaps(
            &[],
            &["src/a.rs".into()],
            &[],
            &["src/b.rs".into()]
        ));
        assert!(overlaps(&[], &["src".into()], &[], &["src/a.rs".into()]));
        assert!(overlaps(&[], &[], &[], &["src/a.rs".into()]));
        assert!(validate_paths(&["../outside".into()]).is_err());
        assert!(validate_paths(&["/outside".into()]).is_err());
    }
    #[test]
    fn agreed_existing_scope_is_bound_to_its_process_generation() {
        let f = Fixture::new();
        let mut a = assignment("a", ResultKind::Code, &[]);
        a.paths = vec!["src/a.rs".into()];
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![a],
        })
        .unwrap();
        let mut builder = session(&f.dir, "existing-builder");
        builder
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Working;
        command(
            &f.dir,
            &f.project,
            &f.auth(),
            &[f.lead.clone(), builder.clone()],
            Command::Coordinate {
                session: builder.id.clone(),
                components: vec![],
                paths: vec!["src/b.rs".into()],
            },
        )
        .unwrap();
        shared_launch_available(
            &f.dir,
            "p",
            "round1",
            "a",
            &[f.lead.clone(), builder.clone()],
        )
        .unwrap();
        builder.snapshot.as_mut().unwrap().generation += 1;
        assert!(
            shared_launch_available(&f.dir, "p", "round1", "a", &[f.lead.clone(), builder])
                .is_err()
        );
    }
    #[test]
    fn delegation_is_rejected_while_sub_builders_are_off() {
        let f = Fixture::new_without_sub_builders();
        let isolated = || Command::Delegate {
            id: "round1".into(),
            assignments: vec![assignment("a", ResultKind::Report, &[])],
        };
        let shared = || Command::DelegateShared {
            id: "round2".into(),
            assignments: vec![assignment("b", ResultKind::Report, &[])],
        };
        for off in [
            BTreeMap::new(),
            BTreeMap::from([(WORKER_ROLE.into(), vec![])]),
            // A worker preset that is no longer installed is off, as in the regular flow.
            BTreeMap::from([(WORKER_ROLE.into(), vec!["uninstalled".into()])]),
        ] {
            f.set_worker_roles(off);
            for command in [isolated(), shared()] {
                let error = f.cmd(command).unwrap_err();
                assert_eq!(
                    error.to_string(),
                    "Sub-builders are off (Settings → Agent roles → Sub-builders). Use a stage such as startPlan, startBuild or startAuto, or ask the user to turn sub-builders on."
                );
            }
            assert!(f.state().rounds.is_empty());
        }

        f.set_worker_roles(BTreeMap::from([(WORKER_ROLE.into(), vec![preset().id])]));
        f.cmd(isolated()).unwrap();
        f.cmd(shared()).unwrap();
        assert_eq!(f.state().rounds, ["round1", "round2"]);

        let (_, worker) = f.launch("a");
        f.set_worker_roles(BTreeMap::new());
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Baseline inspected".into(),
            },
        )
        .unwrap();
        let round = super::super::read(&f.dir, "p", "round1").unwrap();
        assert!(job_done(&round.jobs[0]));
    }

    #[test]
    fn shared_workers_preserve_dirty_worktree_and_complete_without_commits() {
        let f = Fixture::new();
        std::fs::write(f.dir.join("local"), "user edits").unwrap();
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![
                assignment("a", ResultKind::Code, &[]),
                assignment("b", ResultKind::Code, &["a"]),
            ],
        })
        .unwrap();
        let (_, worker) = f.launch("a");
        assert_eq!(worker.spec.cwd, f.dir);
        assert_eq!(
            std::fs::read_to_string(f.dir.join("local")).unwrap(),
            "user edits"
        );
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Changed feature.rs; cargo check passed".into(),
            },
        )
        .unwrap();
        let r = super::super::read(&f.dir, "p", "round1").unwrap();
        assert!(job_done(&r.jobs[0]));
        assert!(r.jobs[0].commit.is_none());
        let (_, second) = f.launch("b");
        assert_eq!(second.spec.cwd, f.dir);
    }
    #[test]
    fn shared_rounds_queue_overlapping_writers_until_explicit_report() {
        let f = Fixture::new();
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![assignment("a", ResultKind::Code, &[])],
        })
        .unwrap();
        let (_, worker) = f.launch("a");
        f.cmd(Command::DelegateShared {
            id: "round2".into(),
            assignments: vec![assignment("b", ResultKind::Code, &[])],
        })
        .unwrap();
        let error = super::super::launch(&f.dir, "p", "round2", "b", &f.project, |_| {
            panic!("overlapping launch")
        })
        .unwrap_err();
        assert!(error.to_string().contains("Waiting for coordination"));
        let r = super::super::read(&f.dir, "p", "round2").unwrap();
        assert_eq!(r.jobs[0].state, JobState::Pending);
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Done; checks passed".into(),
            },
        )
        .unwrap();
        modify(&f.dir, |s| reserve_check(s, "p", "round2", "b")).unwrap();
    }
    #[test]
    fn retries_find_the_owning_round_and_preserve_unconfirmed_launch_identity() {
        for state in [JobState::Failed, JobState::Launching] {
            let f = Fixture::new();
            f.cmd(Command::DelegateShared {
                id: "round1".into(),
                assignments: vec![assignment("a", ResultKind::Code, &[])],
            })
            .unwrap();
            let (launched, _) = f.launch("a");
            let original = &launched.jobs[0];
            modify(&f.dir, |s| {
                let r = s.runs.iter_mut().find(|r| r.id == "round1").unwrap();
                r.jobs[0].state = state;
                r.jobs[0].error = Some("Worker needs retry".into());
                r.error = Some("Worker needs retry".into());
                r.state = State::Paused;
                Ok(())
            })
            .unwrap();
            f.cmd(Command::DelegateShared {
                id: "round2".into(),
                assignments: vec![assignment("b", ResultKind::Report, &[])],
            })
            .unwrap();
            let newer =
                serde_json::to_value(super::super::read(&f.dir, "p", "round2").unwrap()).unwrap();
            control(
                &f.dir,
                "p",
                &f.team.id,
                Control::Retry {
                    assignment: "a".into(),
                    terminal: None,
                },
                std::slice::from_ref(&f.lead),
            )
            .unwrap();
            let retried = super::super::read(&f.dir, "p", "round1").unwrap();
            assert_eq!(retried.state, State::Running);
            assert!(retried.error.is_none());
            assert_eq!(retried.jobs[0].state, JobState::Pending);
            assert!(retried.jobs[0].error.is_none());
            if state == JobState::Launching {
                assert_eq!(retried.jobs[0].request_id, original.request_id);
                assert_eq!(retried.jobs[0].session_id, original.session_id);
            } else {
                assert_ne!(retried.jobs[0].request_id, original.request_id);
                assert!(retried.jobs[0].session_id.is_none());
            }
            assert_eq!(
                serde_json::to_value(super::super::read(&f.dir, "p", "round2").unwrap()).unwrap(),
                newer
            );
        }
    }
    #[test]
    fn resume_only_reactivates_started_or_restart_paused_rounds() {
        for (launched, restart, expected) in [
            (false, false, State::Paused),
            (true, false, State::Running),
            (false, true, State::Running),
        ] {
            let f = Fixture::new();
            f.delegate(vec![assignment("a", ResultKind::Code, &[])]);
            if launched {
                f.launch("a");
            }
            modify(&f.dir, |s| {
                s.runs[0].state = State::Paused;
                s.runs[0].error = restart.then(|| RESTART_NOTICE.into());
                Ok(())
            })
            .unwrap();
            control(
                &f.dir,
                "p",
                &f.team.id,
                Control::Resume,
                std::slice::from_ref(&f.lead),
            )
            .unwrap();
            assert_eq!(
                super::super::read(&f.dir, "p", "round1").unwrap().state,
                expected
            );
        }
    }
    #[test]
    fn stopped_shared_rounds_release_scope_for_new_assignments() {
        for state in [
            JobState::Launching,
            JobState::Running,
            JobState::Integrating,
        ] {
            let f = Fixture::new();
            f.cmd(Command::DelegateShared {
                id: "round1".into(),
                assignments: vec![assignment("a", ResultKind::Code, &[])],
            })
            .unwrap();
            f.launch("a");
            modify(&f.dir, |s| {
                s.runs[0].jobs[0].state = state;
                Ok(())
            })
            .unwrap();
            for action in [Control::Stop, Control::Resume] {
                control(
                    &f.dir,
                    "p",
                    &f.team.id,
                    action,
                    std::slice::from_ref(&f.lead),
                )
                .unwrap();
            }
            f.cmd(Command::DelegateShared {
                id: "round2".into(),
                assignments: vec![assignment("b", ResultKind::Code, &[])],
            })
            .unwrap();
            modify(&f.dir, |s| reserve_check(s, "p", "round2", "b")).unwrap();
            let stopped = super::super::read(&f.dir, "p", "round1").unwrap();
            assert_eq!(stopped.state, State::Stopped);
            assert_eq!(stopped.jobs[0].state, state);
            assert!(
                control(
                    &f.dir,
                    "p",
                    &f.team.id,
                    Control::Retry {
                        assignment: "a".into(),
                        terminal: None,
                    },
                    std::slice::from_ref(&f.lead)
                )
                .is_err()
            );
        }
    }
    #[test]
    fn council_archives_full_reports_before_lanes_are_reused() {
        let f = Fixture::new();
        let file = crate::reviews::lane_file(&f.dir, "main", Some("codex")).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let report = "Complete evidence.\n".repeat(10000);
        std::fs::write(&file, &report).unwrap();
        std::fs::write(
            file.with_extension("json"),
            r#"{"round":"round-one","head":"original"}"#,
        )
        .unwrap();
        let mut run = serde_json::json!({"round":"round-one","branch":"main","members":[{"state":"done","preset":{"id":"codex"}}]});
        archive_council(&f.dir, "request-one", &mut run).unwrap();
        let archived = Path::new(run["archive"].as_str().unwrap()).join("0.md");
        assert_eq!(std::fs::read_to_string(&archived).unwrap(), report);
        std::fs::write(file, "new report").unwrap();
        archive_council(&f.dir, "request-one", &mut run).unwrap();
        assert_eq!(std::fs::read_to_string(archived).unwrap(), report);
    }

    #[test]
    fn councils_require_opt_in_snapshot_presets_and_reject_overlapping_requests() {
        let f = Fixture::new();
        let request = |id: &str| Command::Request {
            id: id.into(),
            action: "startCouncilReview".into(),
            settings: serde_json::json!({"base":"main"}),
        };
        assert!(f.cmd(request("one")).is_err());
        let mut second = preset();
        second.id = "other-model".into();
        second.command = "codex --model other".into();
        let settings = CouncilSettings {
            enabled: true,
            members: vec!["codex".into(), second.id.clone()],
            concurrency: 1,
        };
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Catalog {
                presets: vec![preset(), second],
                roles: BTreeMap::new(),
                council: settings,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        f.cmd(request("one")).unwrap();
        f.cmd(request("one")).unwrap();
        assert!(f.cmd(request("two")).is_err());
        let saved = f.state();
        let (settings, presets) = saved.requests[0].council.as_ref().unwrap();
        assert_eq!(settings.concurrency, 1);
        assert_eq!(presets[1].command, "codex --model other");
        assert_eq!(saved.requests.len(), 1);
    }

    #[test]
    fn lead_reviews_keep_their_run_and_never_overlap_another_review() {
        let f = Fixture::new();
        let request = |id: &str, action: &str| Command::Request {
            id: id.into(),
            action: action.into(),
            settings: serde_json::json!({"focus":"tests"}),
        };
        f.cmd(request("one", "startReview")).unwrap();
        f.cmd(request("one", "startReview")).unwrap();
        assert!(f.cmd(request("two", "startReview")).is_err());
        let state = |state, result: &str| Control::RequestState {
            id: "one".into(),
            state,
            result: Some(result.into()),
            passive: false,
        };
        let apply = |change| {
            control(
                &f.dir,
                "p",
                &f.team.id,
                change,
                std::slice::from_ref(&f.lead),
            )
        };
        apply(state(WorkflowState::Starting, "")).unwrap();
        apply(state(
            WorkflowState::Running,
            r#"{"round":"r","members":[]}"#,
        ))
        .unwrap();
        assert_eq!(
            f.state().requests[0].council_run.as_ref().unwrap()["round"],
            "r"
        );
        apply(state(WorkflowState::Completed, "Reviewed")).unwrap();
        f.cmd(request("two", "startReview")).unwrap();
        assert_eq!(f.state().requests.len(), 2);
    }

    #[test]
    fn lead_stages_are_requested_through_their_workflows() {
        let f = Fixture::new();
        let request = |id: &str, action: &str| Command::Request {
            id: id.into(),
            action: action.into(),
            settings: serde_json::json!({}),
        };
        f.cmd(request("build", "startBuild")).unwrap();
        // The build's agent is still working, so nothing else may start in its checkout.
        for action in ["startBuild", "startFix", "startReview"] {
            assert!(f.cmd(request("next", action)).is_err());
        }
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::RequestState {
                id: "build".into(),
                state: WorkflowState::Completed,
                result: Some("Finished".into()),
                passive: false,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        f.cmd(request("fix", "startFix")).unwrap();
        assert_eq!(f.state().requests.len(), 2);
        let instructions = lead_instructions();
        assert!(instructions.contains("review this branch's changes with `startReview`"));
        assert!(instructions.contains("`$PATCHBAY_PLAN_FILE`"));
        assert!(!instructions.contains("review go to `report` workers"));
        assert!(instructions.contains("request `startPlan`"));
        assert!(instructions.contains("merge with `startMerge`"));
        assert!(instructions.contains("agent team-status"));
        assert!(!instructions.to_lowercase().contains("continue locally"));
        assert!(!instructions.contains("trivial"));
    }

    #[test]
    fn plan_and_auto_take_an_existing_story_in_place_of_a_goal() {
        let f = Fixture::new();
        let request = |id: &str, action: &str, settings| Command::Request {
            id: id.into(),
            action: action.into(),
            settings,
        };
        assert!(
            f.cmd(request(
                "plan",
                "startPlan",
                serde_json::json!({"story": "missing"})
            ))
            .is_err()
        );
        let story = crate::stories::create(
            &f.dir,
            serde_json::from_value(serde_json::json!({"kind": "story", "title": "Import"}))
                .unwrap(),
        )
        .unwrap();
        assert!(
            f.cmd(request(
                "review",
                "startReview",
                serde_json::json!({"story": story.id})
            ))
            .is_err()
        );
        f.cmd(request(
            "plan",
            "startPlan",
            serde_json::json!({"story": story.id}),
        ))
        .unwrap();
        // The fixture's chat is the project checkout, where Auto has no worktree to link.
        assert!(
            f.cmd(request(
                "auto",
                "startAuto",
                serde_json::json!({"story": story.id}),
            ))
            .is_err()
        );
        // ...unless the request makes one for the story.
        f.cmd(request(
            "auto",
            "startAuto",
            serde_json::json!({"story": story.id, "newWorktree": true}),
        ))
        .unwrap();
        for (action, settings) in [
            ("startAuto", serde_json::json!({"newWorktree": true})),
            (
                "startPlan",
                serde_json::json!({"story": story.id, "newWorktree": {"base": "main"}}),
            ),
        ] {
            let error = f.cmd(request("fresh", action, settings)).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("newWorktree is only for startAuto")
            );
        }
        // Pause, resume and stop can control that request's run by its id.
        f.cmd(request(
            "resume",
            "resumeAuto",
            serde_json::json!({"request": "auto"}),
        ))
        .unwrap();
        for (action, target) in [("stopAuto", "plan"), ("pauseAuto", "missing")] {
            let error = f
                .cmd(request(
                    "stop",
                    action,
                    serde_json::json!({"request": target}),
                ))
                .unwrap_err();
            assert!(error.to_string().contains("Unknown startAuto request"));
        }
        assert!(
            f.cmd(request(
                "other",
                "startBuild",
                serde_json::json!({"request": "auto"}),
            ))
            .unwrap_err()
            .to_string()
            .contains("Only pauseAuto, resumeAuto and stopAuto take a request")
        );
        // The request is checked once: replaying it after deletion stays idempotent.
        crate::stories::remove(&f.dir, &story.id, false).unwrap();
        f.cmd(request(
            "plan",
            "startPlan",
            serde_json::json!({"story": story.id}),
        ))
        .unwrap();
        let instructions = lead_instructions();
        assert!(instructions.contains("agent stories"));
        assert!(instructions.contains("story: optional-story-id"));
        assert!(instructions.contains("`newWorktree: true`"));
        assert!(instructions.contains("Its result arrives when the run settles"));
        assert!(instructions.contains("Never merge, approve merges or answer agents' questions"));
    }

    #[test]
    fn lead_uses_stages_when_sub_builders_are_off() {
        let instructions = lead_instructions();
        let rule = instructions
            .lines()
            .find(|line| line.starts_with("- When `team.agentRoles.worker`"))
            .expect("sub-builder role rule");
        assert!(rule.contains("is missing or empty, sub-builders are off"));
        assert!(
            rule.contains("Do not use `team-delegate`, `team-delegate-shared` or `startAgent`")
        );
        assert!(rule.contains("`startPlan` → `startBuild`, or `startAuto`"));
        assert!(rule.contains("ask the user to turn sub-builders on"));
        assert!(rule.contains("Never do the work yourself"));
    }

    #[test]
    fn lead_asks_before_breaking_down_new_work_but_not_before_plan_or_auto() {
        let instructions = lead_instructions();
        let rule = instructions
            .lines()
            .find(|l| l.starts_with("- When the user describes new work"))
            .expect("story breakdown rule");
        assert!(rule.contains("without asking for a plan, build or Auto run"));
        assert!(rule.contains("run `agent stories` first"));
        assert!(rule.contains("existing epics and features as parents"));
        assert!(rule.contains("ask about those together in that same message"));
        assert!(rule.contains("Create the items after the user agrees"));
        assert!(
            instructions.contains("Start the matching agent without asking permission to delegate")
        );
    }

    #[test]
    fn plan_and_merge_are_stages_and_a_plan_needs_its_request() {
        let f = Fixture::new();
        let request = |id: &str, action: &str, settings| Command::Request {
            id: id.into(),
            action: action.into(),
            settings,
        };
        for settings in [serde_json::json!({}), serde_json::json!({"goal": "  "})] {
            assert!(f.cmd(request("plan", "startPlan", settings)).is_err());
        }
        let goal = serde_json::json!({"goal": "Plan the importer"});
        f.cmd(request("plan", "startPlan", goal)).unwrap();
        for action in ["startBuild", "startMerge"] {
            assert!(
                f.cmd(request("next", action, serde_json::json!({})))
                    .is_err()
            );
        }
        let settle = |id: &str, passive| Control::RequestState {
            id: id.into(),
            state: WorkflowState::Completed,
            result: Some("Done".into()),
            passive,
        };
        let apply = |change| {
            control(
                &f.dir,
                "p",
                &f.team.id,
                change,
                std::slice::from_ref(&f.lead),
            )
        };
        apply(settle("plan", false)).unwrap();
        f.cmd(request("merge", "startMerge", serde_json::json!({})))
            .unwrap();
        apply(settle("merge", true)).unwrap();
        let t = f.state();
        let passive = |id: &str| t.messages.iter().find(|m| m.id == id).unwrap().passive;
        assert!(!passive("workflow-plan"));
        assert!(
            passive("workflow-merge"),
            "a confirmed merge starts no turn"
        );
    }

    #[test]
    fn a_merge_the_lead_started_does_not_hold_back_its_task_completion() {
        let f = Fixture::new();
        f.cmd(Command::Request {
            id: "merge".into(),
            action: "startMerge".into(),
            settings: serde_json::json!({}),
        })
        .unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::RequestState {
                id: "merge".into(),
                state: WorkflowState::Running,
                result: None,
                passive: false,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let t = complete_task_reset(&f).unwrap();
        assert_eq!(t.requests[0].state, WorkflowState::Completed);
        assert!(t.reset.as_ref().is_some_and(|r| r.complete_task));
    }

    #[test]
    fn lead_steps_match_the_frontend_steps() {
        // Paired with `simpleFlow.test.ts` "chat steps match the backend's lead steps".
        assert_eq!(
            LEAD_STEPS,
            [
                "idle",
                "planning",
                "planReady",
                "building",
                "built",
                "reviewing",
                "reviewed",
                "fixing",
                "fixed",
                "merging",
                "merged",
            ]
        );
    }

    #[test]
    fn status_notes_are_limited_in_characters() {
        let f = Fixture::new();
        let status = |note: String| Command::Status {
            step: "planning".into(),
            note: Some(note),
        };
        f.cmd(status("計".repeat(STATUS_NOTE_LIMIT))).unwrap();
        assert!(f.cmd(status("計".repeat(STATUS_NOTE_LIMIT + 1))).is_err());
    }

    #[test]
    fn only_the_lead_sets_a_known_chat_status() {
        let mut f = Fixture::new();
        let status = |step: &str| Command::Status {
            step: step.into(),
            note: Some(" Drafting ".into()),
        };
        assert!(f.cmd(status("thinking")).is_err());
        assert!(f.state().status.is_none());
        f.cmd(status("planning")).unwrap();
        let saved = f.state().status.unwrap();
        assert_eq!(saved.step, "planning");
        assert_eq!(saved.note.as_deref(), Some("Drafting"));
        f.cmd(Command::Checkpoint {
            checkpoint: Checkpoint {
                goal: "Goal".into(),
                ..Checkpoint::default()
            },
        })
        .unwrap();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, worker) = f.launch("a");
        assert!(f.worker_cmd(&worker, status("built")).is_err());

        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "Done".into(),
            },
        )
        .unwrap();
        complete_task_reset(&f).unwrap();
        f.lead.request_ids.push("task-done-1".into());
        f.lead.snapshot.as_mut().unwrap().generation = 2;
        reconcile(&f.dir, "p", &[f.lead.clone(), worker], false).unwrap();
        assert_eq!(f.state().status.unwrap().step, "idle");
    }

    #[test]
    fn only_the_owning_team_can_launch_stages_in_its_worktree() {
        let f = Fixture::new();
        let target = PathBuf::from(&f.team.target);
        let available = |team: Option<&str>| {
            modify(&f.dir, |s| {
                ensure_available_to(s, "p", &target, false, team)
            })
        };
        assert!(available(Some(&f.team.id)).is_ok());
        assert!(available(Some("another-team")).is_err());
        assert!(available(None).is_err());
    }

    #[test]
    fn council_configuration_rejects_duplicates_missing_presets_and_bad_limits() {
        let mut settings = CouncilSettings {
            enabled: true,
            members: vec!["codex".into(), "codex".into()],
            concurrency: 2,
        };
        assert!(settings.validate(&[preset()]).is_err());
        settings.members[1] = "missing".into();
        assert!(settings.validate(&[preset()]).is_err());
        settings.enabled = false;
        settings.concurrency = 0;
        assert!(settings.validate(&[]).is_err());
        let defaults: CouncilSettings = serde_json::from_str("{}").unwrap();
        assert!(!defaults.enabled);
        assert_eq!(defaults.concurrency, 2);
    }

    #[test]
    fn workflow_requests_are_idempotent_and_claimed_once() {
        let f = Fixture::new();
        let request = || Command::Request {
            id: "start".into(),
            action: "startAuto".into(),
            settings: serde_json::json!({"goal":"test"}),
        };
        f.cmd(request()).unwrap();
        f.cmd(request()).unwrap();
        assert_eq!(f.state().requests.len(), 1);
        let claim = || Control::RequestState {
            id: "start".into(),
            state: WorkflowState::Starting,
            result: None,
            passive: false,
        };
        control(
            &f.dir,
            "p",
            &f.team.id,
            claim(),
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        assert!(
            control(
                &f.dir,
                "p",
                &f.team.id,
                claim(),
                std::slice::from_ref(&f.lead)
            )
            .is_err()
        );
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), true).unwrap();
        assert_eq!(f.state().requests[0].state, WorkflowState::Uncertain);
    }
    #[test]
    fn unknown_existing_writer_blocks_shared_launch() {
        let f = Fixture::new();
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![assignment("a", ResultKind::Code, &[])],
        })
        .unwrap();
        let mut builder = session(&f.dir, "existing-builder");
        builder
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Working;
        let records = vec![f.lead.clone(), builder.clone()];
        assert!(shared_launch_available(&f.dir, "p", "round1", "a", &records).is_err());
        builder
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Idle;
        shared_launch_available(&f.dir, "p", "round1", "a", &[f.lead.clone(), builder]).unwrap();
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
    fn idle_lead_coexists_with_auto_and_stop_preserves_results() {
        let f = Fixture::new();
        auto_ownership(&f.dir, "p", &f.dir, "auto", true).unwrap();
        auto_ownership(&f.dir, "p", &f.dir, "auto", false).unwrap();
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
            .is_ok()
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
    fn coordination_waits_for_bootstrap_before_initializing_and_preserves_message_order() {
        use crate::status::ChatStartup;
        let mut f = Fixture::new();
        f.lead.snapshot.as_mut().unwrap().chat_startup = Some(ChatStartup::Pending);
        f.send("one", "first");
        f.send("two", "second");
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("bootstrap is pending"),
        )
        .unwrap();
        assert!(f.state().recovery);
        assert!(
            f.state()
                .messages
                .iter()
                .all(|m| m.state == DeliveryState::Pending)
        );
        f.lead.snapshot.as_mut().unwrap().chat_startup = Some(ChatStartup::Ready);
        let mut prompts = Vec::new();
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
        assert!(prompts[0].find("first").unwrap() < prompts[0].find("second").unwrap());
        assert!(!f.state().recovery);
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("duplicate delivery"),
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
    fn stopping_a_restored_team_clears_the_restart_notice() {
        let f = Fixture::new();
        let restored = reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), true).unwrap();
        assert_eq!(restored[0].error.as_deref(), Some("Paused after restart"));
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        assert_eq!(f.state().state, State::Stopped);
        assert_eq!(f.state().error, None);
    }
    #[test]
    fn stopping_a_team_keeps_errors_other_than_the_restart_notice() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Block {
                reason: "launch failed".into(),
            },
            std::slice::from_ref(&f.lead),
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
        assert_eq!(f.state().error.as_deref(), Some("launch failed"));
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
            super::super::Control::Retry {
                job: "a".into(),
                terminal: None,
            },
            super::super::Control::ContinueJob {
                job: "a".into(),
                request_id: "request".into(),
            },
            super::super::Control::ContinueScan,
        ] {
            let error = super::super::control(&f.dir, "p", "round1", control).unwrap_err();
            assert!(error.to_string().contains("Chat Sub-builder controls"));
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

    fn complete_task_reset(f: &Fixture) -> Result<Team> {
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::CompleteTask {
                id: "task-done-1".into(),
                since_ms: None,
            },
            std::slice::from_ref(&f.lead),
        )
    }

    #[test]
    fn completed_task_reset_drops_finished_work_once_the_new_lead_is_confirmed() {
        let mut f = Fixture::new();
        let checkpoint = Checkpoint {
            goal: "Ship the finished feature".into(),
            constraints: "Keep public APIs".into(),
            decisions: "Use the old adapter".into(),
            remaining: "Nothing else".into(),
            validation: "All green".into(),
        };
        f.cmd(Command::Checkpoint {
            checkpoint: checkpoint.clone(),
        })
        .unwrap();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (run, worker) = f.launch("a");
        f.worker_cmd(
            &worker,
            Command::Report {
                summary: "finished feature report".into(),
            },
        )
        .unwrap();
        retain_briefing(&f.dir, "p", &f.team.id, "Finished task briefing").unwrap();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Note {
                id: "merge".into(),
                text: "The user started a merge.".into(),
                sessions: vec!["merge-agent".into()],
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        complete_task_reset(&f).unwrap();
        assert_eq!(f.state().checkpoint, checkpoint, "not confirmed yet");

        f.lead.request_ids.push("task-done-1".into());
        f.lead.snapshot.as_mut().unwrap().generation = 2;
        reconcile(&f.dir, "p", &[f.lead.clone(), worker], false).unwrap();
        let t = f.state();
        assert!(t.handoff.as_ref().unwrap().complete_task);
        assert!(t.checkpoint.goal.is_empty());
        assert!(t.checkpoint.validation.is_empty());
        assert!(t.checkpoint.decisions.is_empty());
        assert!(t.original_briefing.is_empty());
        assert!(t.noted_agents.is_empty());
        assert!(
            t.messages
                .iter()
                .filter(|m| m.recipient == "lead")
                .all(|m| m.state == DeliveryState::Delivered),
            "finished work's messages never reach the new lead"
        );
        assert_eq!(t.checkpoint.constraints, "Keep public APIs");
        assert!(t.finished.rounds.contains(&run.id));
        assert!(t.rounds.contains(&run.id), "history stays stored");
        let text = recovery_text(&load(&f.dir).unwrap(), &t).unwrap();
        assert!(!text.contains("Ship the finished feature"));
        assert!(!text.contains(&run.id));

        // Polling repeats the request after it was applied.
        complete_task_reset(&f).unwrap();
        assert!(f.state().reset.is_none());
    }

    fn complete_since(f: &Fixture, since_ms: Option<u64>) -> Team {
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::CompleteTask {
                id: "task-done-1".into(),
                since_ms,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap()
    }

    fn lead_agent(f: &mut Fixture) -> &mut crate::status::AgentReport {
        let snapshot = f.lead.snapshot.as_mut().unwrap();
        snapshot.status.agent.as_mut().unwrap()
    }

    #[test]
    fn a_lead_with_newer_work_keeps_its_conversation_when_a_task_completes() {
        let mut f = Fixture::new();
        lead_agent(&mut f).since_ms = 500;
        let t = complete_since(&f, Some(500));
        assert!(t.reset.is_none(), "a turn since the task finished");
        assert_eq!(t.checkpoint.goal, "Build feature");
        assert!(t.finished.tasks.contains("task-done-1"));

        // The decision stands, even once the lead is idle again.
        lead_agent(&mut f).since_ms = 1;
        assert!(complete_since(&f, Some(500)).reset.is_none());
    }

    #[test]
    fn a_busy_lead_or_active_round_keeps_the_conversation() {
        let mut f = Fixture::new();
        lead_agent(&mut f).state = crate::status::AgentState::Working;
        assert!(complete_since(&f, None).reset.is_none());

        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        assert!(complete_since(&f, None).reset.is_none());
    }

    /// The lead after its confirmed replacement by the reset `id`.
    fn cleared_lead(f: &Fixture, id: &str) -> Record {
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: id.into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let mut lead = f.lead.clone();
        lead.request_ids.push(id.into());
        lead.snapshot.as_mut().unwrap().generation = 2;
        reconcile(&f.dir, "p", std::slice::from_ref(&lead), false).unwrap();
        lead
    }

    #[test]
    fn a_cleared_lead_waits_for_the_user_with_its_handoff() {
        let f = Fixture::new();
        let lead = cleared_lead(&f, "fresh");
        deliver(&f.dir, "p", &f.team.id, std::slice::from_ref(&lead), |_| {
            panic!("clearing the lead started a turn")
        })
        .unwrap();
        let t = f.state();
        assert!(!t.recovery && !t.quiet_recovery);
        let handoff = t.messages.last().unwrap();
        assert!(handoff.passive && handoff.state == DeliveryState::Pending);
        assert!(handoff.text.contains("Build feature"));
    }

    #[test]
    fn a_cleared_lead_with_active_work_is_still_woken() {
        let f = Fixture::new();
        f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let lead = cleared_lead(&f, "fresh");
        let mut prompts = 0;
        deliver(&f.dir, "p", &f.team.id, std::slice::from_ref(&lead), |r| {
            prompts += usize::from(matches!(r, Request::Prompt { .. }));
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(prompts, 1);
        assert!(!f.state().messages.last().unwrap().passive);
    }

    #[test]
    fn a_finished_merge_neither_wakes_the_lead_nor_blocks_its_fresh_start() {
        let f = Fixture::new();
        let mut records = vec![f.lead.clone()];
        deliver(&f.dir, "p", &f.team.id, &records, |_| {
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        let mut merge = session(&f.dir, "merge-agent");
        merge.metadata.component_id = crate::model::MERGE_SCOPE.into();
        let report = merge.snapshot.as_mut().unwrap().status.agent.as_mut();
        report.unwrap().state = AgentState::Working;
        records.push(merge.clone());
        reconcile(&f.dir, "p", &records, false).unwrap();
        let report = merge.snapshot.as_mut().unwrap().status.agent.as_mut();
        report.unwrap().state = AgentState::Idle;
        records[1] = merge;
        reconcile(&f.dir, "p", &records, false).unwrap();
        assert!(f.state().messages.last().unwrap().passive);
        deliver(&f.dir, "p", &f.team.id, &records, |_| {
            panic!("the merge's finish started a lead turn")
        })
        .unwrap();
        assert!(complete_since(&f, Some(20)).reset.is_some());
    }

    #[test]
    fn retiring_a_task_ends_its_team_agents_and_worktree_lease() {
        let f = Fixture::new();
        let run = f.delegate(vec![assignment("a", ResultKind::Report, &[])]);
        let (_, worker) = f.launch("a");
        assert!(implementation_available(&f.dir, "p", &f.dir, false, None).is_err());

        let sessions = retire_task(&f.dir, "p", None).unwrap();
        assert!(sessions.contains(&f.lead.id) && sessions.contains(&worker.id));
        assert!(list(&f.dir, "p").unwrap().is_empty());
        let stopped = super::super::read(&f.dir, "p", &run.id).unwrap();
        assert_eq!(stopped.state, State::Stopped);
        assert!(retire_task(&f.dir, "p", None).unwrap().is_empty());

        // A new worktree at the reused path starts clean.
        implementation_available(&f.dir, "p", &f.dir, false, None).unwrap();
    }

    #[test]
    fn retiring_another_task_keeps_this_team() {
        let f = Fixture::new();
        assert!(retire_task(&f.dir, "p", Some("other")).unwrap().is_empty());
        assert_eq!(list(&f.dir, "p").unwrap().len(), 1);
    }

    #[test]
    fn a_completion_joins_a_pending_fresh_conversation() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "fresh".into(),
                session: f.lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let reset = complete_since(&f, None).reset.unwrap();
        assert_eq!(reset.id, "fresh");
        assert!(reset.complete_task);
    }

    #[test]
    fn a_completion_without_a_lead_session_clears_the_task_immediately() {
        let f = Fixture::new();
        let t = control(
            &f.dir,
            "p",
            &f.team.id,
            Control::CompleteTask {
                id: "task-done-1".into(),
                since_ms: None,
            },
            &[],
        )
        .unwrap();
        assert!(t.reset.is_none());
        assert!(t.checkpoint.goal.is_empty());
        assert!(
            t.lead.conversation.is_none(),
            "nothing resumes the old turn"
        );
        assert!(t.recovery);
    }

    #[test]
    fn failed_completed_task_reset_keeps_the_checkpoint() {
        let f = Fixture::new();
        let checkpoint = Checkpoint {
            goal: "Keep me".into(),
            ..Default::default()
        };
        f.cmd(Command::Checkpoint {
            checkpoint: checkpoint.clone(),
        })
        .unwrap();
        complete_task_reset(&f).unwrap();
        replace_lead(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Err(anyhow!("launch refused")),
        )
        .unwrap();
        let t = f.state();
        assert_eq!(t.reset.unwrap().phase, ResetPhase::Failed);
        assert_eq!(t.checkpoint, checkpoint);
        assert!(t.finished.rounds.is_empty());
    }

    #[test]
    fn a_note_reaches_the_lead_inbox_once() {
        let f = Fixture::new();
        let note = || Control::Note {
            id: "build-1".into(),
            text: "The user started Build from Chat.".into(),
            sessions: vec![],
        };
        for _ in 0..2 {
            control(
                &f.dir,
                "p",
                &f.team.id,
                note(),
                std::slice::from_ref(&f.lead),
            )
            .unwrap();
        }
        let notes: Vec<_> = f
            .state()
            .messages
            .into_iter()
            .filter(|m| m.text.contains("started Build"))
            .collect();
        assert_eq!(notes.len(), 1);
        assert_eq!(
            (notes[0].sender.as_str(), notes[0].recipient.as_str()),
            ("patchbay", "lead")
        );
        assert_eq!(notes[0].state, DeliveryState::Pending);
    }

    #[test]
    fn workflow_button_work_waits_for_the_leads_next_turn() {
        let f = Fixture::new();
        let finish = |name: &str, records: &mut Vec<Record>| {
            let mut agent = session(&f.dir, name);
            let state = |agent: &mut Record, state| {
                let report = agent.snapshot.as_mut().unwrap().status.agent.as_mut();
                report.unwrap().state = state;
            };
            state(&mut agent, AgentState::Working);
            records.push(agent.clone());
            reconcile(&f.dir, "p", records, false).unwrap();
            state(&mut agent, AgentState::Idle);
            *records.last_mut().unwrap() = agent;
            reconcile(&f.dir, "p", records, false).unwrap();
        };
        let mut records = vec![f.lead.clone()];
        // The fixture's lead starts owing a recovery turn; take it first.
        deliver(&f.dir, "p", &f.team.id, &records, |_| {
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        let lead = records[0].snapshot.as_mut().unwrap();
        lead.status.agent.as_mut().unwrap().since_ms = 20;
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Note {
                id: "review-1".into(),
                text: "The user started a review from Chat.".into(),
                sessions: vec!["reviewer".into()],
            },
            &records,
        )
        .unwrap();
        finish("reviewer", &mut records);
        let t = f.state();
        assert!(t.noted_agents.is_empty());
        assert_eq!(t.messages.iter().filter(|m| m.passive).count(), 2);
        deliver(&f.dir, "p", &f.team.id, &records, |_| {
            panic!("workflow-button work started a lead turn")
        })
        .unwrap();

        f.send("next", "what happened?");
        let mut prompts = Vec::new();
        deliver(&f.dir, "p", &f.team.id, &records, |r| {
            if let Request::Prompt { text, .. } = r {
                prompts.push(text);
            }
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(prompts.len(), 1);
        for part in ["started a review", "Existing agent", "what happened?"] {
            assert!(prompts[0].contains(part), "{part}");
        }

        // Noted work that ended before any pass saw it working is settled the same way, so
        // the session's later work wakes the lead again.
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Note {
                id: "review-2".into(),
                text: "The user started another review from Chat.".into(),
                sessions: vec!["quick".into()],
            },
            &records,
        )
        .unwrap();
        let mut quick = session(&f.dir, "quick");
        let report = |quick: &mut Record, since_ms| {
            let agent = quick.snapshot.as_mut().unwrap().status.agent.as_mut();
            let agent = agent.unwrap();
            agent.state = AgentState::Review;
            agent.since_ms = since_ms;
        };
        // A reused agent still shows the turn it stopped before the note.
        report(&mut quick, 10);
        records.push(quick.clone());
        reconcile(&f.dir, "p", &records, false).unwrap();
        assert!(f.state().noted_agents.contains("quick"));
        report(&mut quick, u64::MAX);
        *records.last_mut().unwrap() = quick;
        reconcile(&f.dir, "p", &records, false).unwrap();
        let t = f.state();
        assert!(t.noted_agents.is_empty() && t.noted_since.is_empty());
        let settled = t.messages.last().unwrap();
        assert!(settled.id.starts_with("external-finished-quick") && settled.passive);
        records.pop();

        // An agent that was not announced to the lead still wakes it.
        finish("stranger", &mut records);
        let t = f.state();
        let notice = t.messages.last().unwrap();
        assert!(notice.id.starts_with("external-finished-stranger"));
        assert!(!notice.passive && notice.state == DeliveryState::Pending);

        // The user's own prompt can carry a waiting note; only passive messages are settled.
        let note = |id: &str| Control::Note {
            id: id.into(),
            text: "The user started a merge from Chat.".into(),
            sessions: vec![],
        };
        control(&f.dir, "p", &f.team.id, note("merge-1"), &records).unwrap();
        let ids = vec!["note-merge-1".to_string(), notice.id.clone()];
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::NotesDelivered { ids },
            &records,
        )
        .unwrap();
        let t = f.state();
        let state = |id: &str| t.messages.iter().find(|m| m.id == id).unwrap().state;
        assert_eq!(state("note-merge-1"), DeliveryState::Delivered);
        assert_eq!(state(&notice.id), DeliveryState::Pending);
    }

    #[test]
    fn a_new_lead_briefed_with_its_role_starts_without_a_handoff() {
        let f = Fixture::new();
        let briefing = format!(
            "# Context\n\nCOMPONENTS\n\n{LEAD_ROLE_HEADING}\n\n{}",
            lead_instructions()
        );
        let seed = |session_id: &str, paused, goal: &str| Initialize {
            task: Some(session_id.into()),
            session_id: session_id.into(),
            preset: preset(),
            paused,
            checkpoint: Checkpoint {
                goal: goal.into(),
                remaining: "Continue".into(),
                ..Default::default()
            },
        };
        let start = |name: &str, briefing: Option<&str>, paused, goal: &str| {
            let target = f.dir.join(name);
            std::fs::create_dir_all(&target).unwrap();
            let mut lead = session(&f.dir, name);
            lead.metadata.task = Some(name.into());
            lead.briefing_backup = briefing.map(Into::into);
            initialize(&f.dir, "p", &target, seed(name, paused, goal), &[lead]).unwrap()
        };
        let fresh = start("fresh", Some(&briefing), false, "");
        assert!(!fresh.recovery);
        assert!(fresh.original_briefing.contains("COMPONENTS"));
        assert!(!fresh.original_briefing.contains(LEAD_ROLE_HEADING));
        // An adopted conversation, an earlier goal and an older briefing still get the handoff.
        assert!(start("adopted", Some(&briefing), true, "").recovery);
        assert!(start("goal", Some(&briefing), false, "Build feature").recovery);
        assert!(start("older", Some("# Context"), false, "").recovery);
        let text = recovery_text(&load(&f.dir).unwrap(), &fresh).unwrap();
        assert!(text.contains("Agents do the work"));
        assert!(!text.contains("{cli}"));
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
                        purpose,
                    } if !new_preset => {
                        assert_eq!(id, "replacement");
                        assert_eq!(request_id, "replacement-request");
                        assert_eq!(generation, 1);
                        assert_eq!(purpose, Some(crate::pty::LaunchPurpose::Chat));
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
    fn stop_at_limit(record: &mut Record) {
        record
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .limit_stopped_ms = Some(20);
    }
    fn set_working(record: &mut Record) {
        record
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Working;
    }
    fn claude_preset() -> TerminalSpec {
        serde_json::from_value(serde_json::json!({"id":"claude", "name":"Claude", "kind":"agent", "command":"claude", "adapter":"claude"})).unwrap()
    }
    #[test]
    fn a_limit_stopped_lead_gets_no_deliveries_but_can_be_replaced() {
        let f = Fixture::new();
        let mut lead = f.lead.clone();
        stop_at_limit(&mut lead);
        // Not otherwise ready, so only the limit can release its replacement.
        lead.snapshot.as_mut().unwrap().chat_startup = Some(crate::status::ChatStartup::Pending);
        f.send("held", "Worker update");
        deliver_at(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&lead),
            30,
            |_| false,
            |_| panic!("delivered to a limit-stopped lead"),
        )
        .unwrap();
        let held = f.state();
        assert!(
            held.messages
                .iter()
                .any(|m| m.state == DeliveryState::Pending)
        );
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "fresh".into(),
                session: lead.id.clone(),
                clear_history: true,
            },
            std::slice::from_ref(&lead),
        )
        .unwrap();
        let mut resets = 0;
        replace_lead(&f.dir, "p", &f.team.id, std::slice::from_ref(&lead), |r| {
            assert!(matches!(r, Request::ResetConversation { .. }));
            resets += 1;
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(resets, 1);
    }
    #[test]
    fn a_limit_hold_ends_after_the_retry_delay_once_no_window_is_spent() {
        let f = Fixture::new();
        let mut lead = f.lead.clone();
        stop_at_limit(&mut lead);
        f.send("held", "Worker update");
        let records = std::slice::from_ref(&lead);
        let retry_at = 20 + LIMIT_RETRY_MS;
        for (now_ms, spent) in [(retry_at - 1, false), (retry_at, true)] {
            deliver_at(
                &f.dir,
                "p",
                &f.team.id,
                records,
                now_ms,
                |_| spent,
                |_| panic!("delivered during the hold"),
            )
            .unwrap();
        }
        let mut prompts = 0;
        deliver_at(
            &f.dir,
            "p",
            &f.team.id,
            records,
            retry_at,
            |_| false,
            |request| {
                prompts += usize::from(matches!(request, Request::Prompt { .. }));
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(prompts, 1);
    }
    #[test]
    fn choosing_a_lead_replaces_a_working_lead_while_clearing_context_waits() {
        let f = Fixture::new();
        let mut lead = f.lead.clone();
        set_working(&mut lead);
        let records = std::slice::from_ref(&lead);
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Reset {
                id: "fresh".into(),
                session: lead.id.clone(),
                clear_history: true,
            },
            records,
        )
        .unwrap();
        replace_lead(&f.dir, "p", &f.team.id, records, |_| {
            panic!("cleared context during a working turn")
        })
        .unwrap();
        assert_eq!(f.state().reset.unwrap().phase, ResetPhase::Queued);

        let f = Fixture::new();
        let mut lead = f.lead.clone();
        set_working(&mut lead);
        let records = std::slice::from_ref(&lead);
        control(&f.dir, "p", &f.team.id, Control::Pause, records).unwrap();
        let mut terminal = claude_preset();
        terminal.id = "new-lead".into();
        new_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            terminal,
            "replacement".into(),
        )
        .unwrap();
        let mut requests = Vec::new();
        replace_lead(&f.dir, "p", &f.team.id, records, |r| {
            requests.push(match r {
                Request::Stop { .. } => "stop",
                Request::NewConversation { .. } => "launch",
                _ => panic!("unexpected request"),
            });
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(requests, ["stop", "launch"]);
    }
    #[test]
    fn a_saved_worker_failure_notice_survives_a_change_in_its_wording() {
        let f = Fixture::new();
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![assignment("a", ResultKind::Code, &[])],
        })
        .unwrap();
        let (launched, mut worker) = f.launch("a");
        let launched_ms = launched.jobs[0].launched_ms;
        stop_at_limit(&mut worker);
        let records = [f.lead.clone(), worker];
        super::super::reconcile_at(&f.dir, "p", &records, false, launched_ms + 1).unwrap();
        reconcile(&f.dir, "p", &records, false).unwrap();
        modify(&f.dir, |s| {
            let notice = s.teams[0]
                .messages
                .iter_mut()
                .find(|m| m.id.starts_with("failed-"))
                .unwrap();
            notice.text = "Wording from an earlier version".into();
            Ok(())
        })
        .unwrap();
        let teams = reconcile(&f.dir, "p", &records, false).unwrap();
        assert!(
            teams[0]
                .messages
                .iter()
                .any(|m| m.text == "Wording from an earlier version")
        );
    }

    #[test]
    fn a_limit_stopped_worker_fails_and_retries_on_another_agent() {
        let f = Fixture::new();
        f.cmd(Command::DelegateShared {
            id: "round1".into(),
            assignments: vec![assignment("a", ResultKind::Code, &[])],
        })
        .unwrap();
        let (launched, mut worker) = f.launch("a");
        let launched_ms = launched.jobs[0].launched_ms;
        stop_at_limit(&mut worker);
        let records = [f.lead.clone(), worker];
        super::super::reconcile_at(&f.dir, "p", &records, false, launched_ms + 1).unwrap();
        let failed = super::super::read(&f.dir, "p", "round1").unwrap();
        assert_eq!(failed.jobs[0].state, JobState::Failed);
        assert!(
            failed.jobs[0]
                .error
                .as_ref()
                .unwrap()
                .contains("usage limit")
        );
        let preset = failed.jobs[0].preset.clone();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Retry {
                assignment: "a".into(),
                terminal: Some(claude_preset()),
            },
            &records,
        )
        .unwrap();
        let retried = super::super::read(&f.dir, "p", "round1").unwrap();
        assert_eq!(retried.jobs[0].state, JobState::Pending);
        assert_eq!(retried.jobs[0].terminal.name, "Claude");
        assert_eq!(retried.jobs[0].preset, preset);
        assert_ne!(retried.jobs[0].request_id, failed.jobs[0].request_id);
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
        assert_eq!(
            reset.launch.as_ref().unwrap().spec.purpose,
            crate::pty::LaunchPurpose::Chat
        );
        assert!(reset.launch.as_ref().unwrap().spec.chat_bootstrap());
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
            .is_ok()
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
    #[test]
    fn information_requests_reach_busy_existing_agents_once_and_accept_authenticated_replies() {
        let f = Fixture::new();
        let mut external = session(&f.dir, "existing");
        external
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Working;
        let mut records = vec![f.lead.clone(), external.clone()];
        let ask = || Command::Ask {
            id: "progress".into(),
            to: external.id.clone(),
            text: "Findings and blockers?".into(),
        };
        for _ in 0..2 {
            command(&f.dir, &f.project, &f.auth(), &records, ask()).unwrap();
        }
        assert_eq!(f.state().information_requests.len(), 1);
        let mut external_prompts = 0;
        deliver(&f.dir, "p", &f.team.id, &records, |request| {
            if matches!(request, Request::Prompt { ref id, .. } if id == "existing") {
                external_prompts += 1;
            }
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(external_prompts, 0);
        records[1]
            .snapshot
            .as_mut()
            .unwrap()
            .status
            .agent
            .as_mut()
            .unwrap()
            .state = AgentState::Idle;
        deliver(&f.dir, "p", &f.team.id, &records, |request| {
            if let Request::Prompt { id, text, .. } = request
                && id == "existing"
            {
                external_prompts += 1;
                assert!(text.contains("team-reply --id progress"));
            }
            Ok(serde_json::Value::Null)
        })
        .unwrap();
        assert_eq!(external_prompts, 1);
        let mut auth = f.auth();
        auth.agent_session = external.id.clone();
        for _ in 0..2 {
            command(
                &f.dir,
                &f.project,
                &auth,
                &records,
                Command::Reply {
                    id: "progress".into(),
                    text: "Found the cause; validation pending".into(),
                },
            )
            .unwrap();
        }
        let t = f.state();
        assert_eq!(
            t.information_requests[0].response.as_deref(),
            Some("Found the cause; validation pending")
        );
        assert_eq!(
            t.messages
                .iter()
                .filter(|m| m.id == "reply-progress")
                .count(),
            1
        );
        assert!(
            command(
                &f.dir,
                &f.project,
                &auth,
                &records,
                Command::Reply {
                    id: "progress".into(),
                    text: "Different response".into()
                }
            )
            .is_err()
        );
        auth.generation = Some(2);
        assert!(
            command(
                &f.dir,
                &f.project,
                &auth,
                &records,
                Command::Reply {
                    id: "progress".into(),
                    text: "Stale response".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn outstanding_information_survives_restart_and_reports_agent_failure_without_delegating() {
        let f = Fixture::new();
        let external = session(&f.dir, "existing");
        let records = vec![f.lead.clone(), external];
        command(
            &f.dir,
            &f.project,
            &f.auth(),
            &records,
            Command::Ask {
                id: "dependency".into(),
                to: "existing".into(),
                text: "Can we use your API?".into(),
            },
        )
        .unwrap();
        reconcile(&f.dir, "p", &records, true).unwrap();
        let t = f.state();
        assert_eq!(t.information_requests.len(), 1);
        assert!(t.information_requests[0].response.is_none());
        assert!(
            recovery_text(&load(&f.dir).unwrap(), &t)
                .unwrap()
                .contains("Can we use your API?")
        );
        reconcile(&f.dir, "p", std::slice::from_ref(&f.lead), false).unwrap();
        let t = f.state();
        assert!(t.information_requests[0].error.is_some());
        assert!(t.messages.iter().any(|m| m.id == "ask-failed-dependency"));
        assert!(t.rounds.is_empty());
    }

    #[test]
    fn continuation_connects_live_without_launching_and_preserves_stop_decision() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let result = continue_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            "Recent user request",
            |request| {
                assert!(matches!(request, Request::List));
                Ok(serde_json::to_value(vec![f.lead.clone()]).unwrap())
            },
        )
        .unwrap();
        assert_eq!(result.outcome, ContinuationOutcome::Connected);
        assert_eq!(result.session.id, f.lead.id);
        assert_eq!(result.team.state, State::Stopped);
        assert!(result.team.saved_context.contains("Recent user request"));
    }

    #[test]
    fn continuation_resumes_exact_session_and_reconciles_membership_while_paused() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Pause,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let mut lead = f.lead.clone();
        lead.metadata.conversation_id = Some("exact-conversation".into());
        lead.snapshot.as_mut().unwrap().running = false;
        let mut resumes = 0;
        let result = continue_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            "saved transcript",
            |request| match request {
                Request::List => Ok(serde_json::to_value(vec![lead.clone()]).unwrap()),
                Request::ChatResume { id, request_id, .. } => {
                    assert_eq!(id, f.lead.id);
                    assert_eq!(
                        lead.metadata.conversation_id.as_deref(),
                        Some("exact-conversation")
                    );
                    resumes += 1;
                    lead.request_ids.push(request_id);
                    lead.snapshot.as_mut().unwrap().generation += 1;
                    lead.snapshot.as_mut().unwrap().running = true;
                    Ok(serde_json::to_value(crate::session::ChatResume::Resumed).unwrap())
                }
                _ => panic!("Unexpected replacement"),
            },
        )
        .unwrap();
        assert_eq!(resumes, 1);
        assert_eq!(result.outcome, ContinuationOutcome::Resumed);
        assert_eq!(result.team.lead.generation, 2);
        assert_eq!(result.team.state, State::Paused);
        assert!(result.team.handoff.is_none());
    }

    #[test]
    fn continuation_reconstructs_missing_history_with_plan_transcript_and_preserved_history() {
        let f = Fixture::new();
        let plan = crate::plans::prepared_file(&f.dir, None).unwrap();
        std::fs::write(plan, "Current approved plan").unwrap();
        std::fs::write(f.dir.join("user-edit"), "preserve").unwrap();
        let mut lead = f.lead.clone();
        lead.snapshot.as_mut().unwrap().running = false;
        let mut launches = 0;
        let result = continue_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            "Latest saved conversation",
            |request| match request {
                Request::List => Ok(serde_json::to_value(vec![lead.clone()]).unwrap()),
                Request::ChatResume { .. } => Ok(serde_json::to_value(
                    crate::session::ChatResume::HistoryUnavailable {
                        error: "Missing history".into(),
                    },
                )
                .unwrap()),
                Request::ResetConversation {
                    id,
                    request_id,
                    generation,
                    purpose,
                } => {
                    assert_eq!(id, lead.id);
                    assert_eq!(generation, 1);
                    assert_eq!(purpose, Some(crate::pty::LaunchPurpose::Chat));
                    launches += 1;
                    lead.request_ids.push(request_id);
                    lead.snapshot.as_mut().unwrap().generation = 2;
                    lead.snapshot.as_mut().unwrap().running = true;
                    Ok(serde_json::Value::Null)
                }
                _ => panic!("Unexpected transport request"),
            },
        )
        .unwrap();
        assert_eq!(launches, 1);
        assert_eq!(result.outcome, ContinuationOutcome::Reconstructed);
        assert!(!result.team.handoff.as_ref().unwrap().clear_history);
        let text = recovery_text(&load(&f.dir).unwrap(), &result.team).unwrap();
        assert!(text.contains("Current approved plan"));
        assert!(text.contains("Latest saved conversation"));
        assert_eq!(
            std::fs::read_to_string(f.dir.join("user-edit")).unwrap(),
            "preserve"
        );
    }

    #[test]
    fn continuation_recovers_forgotten_lead_with_same_agent_without_resuming_work() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Stop,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let mut records = vec![];
        let result = continue_lead(
            &f.dir,
            &f.project,
            "p",
            &f.team.id,
            "Keep my conversation",
            |request| match request {
                Request::List => Ok(serde_json::to_value(&records).unwrap()),
                Request::NewConversation {
                    request_id,
                    metadata,
                    spec,
                } => {
                    assert_eq!(metadata.command, f.team.lead.preset.command);
                    assert_ne!(spec.id, f.lead.id);
                    let mut next = session(&f.dir, &spec.id);
                    next.metadata = *metadata;
                    next.request_ids = vec![request_id];
                    records.push(next);
                    Ok(serde_json::Value::Null)
                }
                _ => panic!("Unexpected request"),
            },
        )
        .unwrap();
        assert_eq!(result.team.state, State::Stopped);
        assert!(!result.team.handoff.as_ref().unwrap().clear_history);
        assert_eq!(records.len(), 1);
        assert!(result.team.saved_context.contains("Keep my conversation"));
    }

    #[test]
    fn continuation_does_not_replace_authentication_access_or_configuration_failures() {
        for (failure, expected, reason) in [
            (
                crate::session::ResumeFailure::Authentication,
                FailureKind::Authentication,
                "Authentication required",
            ),
            (
                crate::session::ResumeFailure::Access,
                FailureKind::Access,
                "Access denied",
            ),
            (
                crate::session::ResumeFailure::Configuration,
                FailureKind::Configuration,
                "Bad command",
            ),
        ] {
            let f = Fixture::new();
            let mut lead = f.lead.clone();
            lead.snapshot.as_mut().unwrap().running = false;
            let error =
                continue_lead(
                    &f.dir,
                    &f.project,
                    "p",
                    &f.team.id,
                    "draft",
                    |request| match request {
                        Request::List => Ok(serde_json::to_value(vec![lead.clone()]).unwrap()),
                        Request::ChatResume { .. } => {
                            Ok(serde_json::to_value(crate::session::ChatResume::Failed {
                                error: reason.into(),
                                failure,
                            })
                            .unwrap())
                        }
                        _ => panic!("Incorrect automatic replacement"),
                    },
                )
                .unwrap_err();
            assert!(error.to_string().contains(reason));
            assert_eq!(
                error.downcast_ref::<ContinuationFailure>().unwrap().kind,
                expected
            );
            assert!(f.state().reset.is_none());
            assert!(f.state().continuation_request.is_none());
        }
    }

    #[test]
    fn uncertain_resume_retries_the_same_identity_and_never_replaces_history() {
        let f = Fixture::new();
        let mut lead = f.lead.clone();
        lead.snapshot.as_mut().unwrap().running = false;
        let mut identity = None;
        assert!(
            continue_lead(
                &f.dir,
                &f.project,
                "p",
                &f.team.id,
                "draft",
                |request| match request {
                    Request::List => Ok(serde_json::to_value(vec![lead.clone()]).unwrap()),
                    Request::ChatResume { request_id, .. } => {
                        identity = Some(request_id);
                        anyhow::bail!("lost reply")
                    }
                    _ => panic!("Unexpected launch"),
                }
            )
            .is_err()
        );
        assert_eq!(f.state().continuation_request, identity);
        let result =
            continue_lead(
                &f.dir,
                &f.project,
                "p",
                &f.team.id,
                "draft",
                |request| match request {
                    Request::List => Ok(serde_json::to_value(vec![lead.clone()]).unwrap()),
                    Request::ChatResume { request_id, .. } => {
                        assert_eq!(Some(request_id.clone()), identity);
                        lead.request_ids.push(request_id);
                        lead.snapshot.as_mut().unwrap().running = true;
                        lead.snapshot.as_mut().unwrap().generation = 2;
                        Ok(serde_json::to_value(crate::session::ChatResume::Resumed).unwrap())
                    }
                    _ => panic!("Unexpected launch"),
                },
            )
            .unwrap();
        assert_eq!(result.outcome, ContinuationOutcome::Resumed);
        assert!(result.team.reset.is_none());
    }

    #[test]
    fn lead_inbox_keeps_working_while_worker_scheduling_is_paused() {
        let f = Fixture::new();
        control(
            &f.dir,
            "p",
            &f.team.id,
            Control::Pause,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let mut prompts = 0;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |request| {
                if let Request::Prompt { id, .. } = request {
                    assert_eq!(id, f.lead.id);
                    prompts += 1;
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert_eq!(prompts, 1);
        assert_eq!(f.state().state, State::Paused);
    }
    #[test]
    fn compact_recovery_prioritizes_outstanding_requests_and_keeps_plan_and_briefing() {
        let f = Fixture::new();
        modify(&f.dir, |s| {
            let t = team(s, "p", &f.team.id)?;
            t.checkpoint.goal = "Large checkpoint ".repeat(10000);
            t.saved_context = "Recent conversation ".repeat(1000);
            t.current_plan = "CURRENT-PLAN".into();
            t.original_briefing = "ORIGINAL-BRIEFING".into();
            t.information_requests.push(InformationRequest {
                id: "old-outstanding".into(),
                recipient: "existing".into(),
                generation: 1,
                question: "OUTSTANDING-DEPENDENCY".into(),
                response: None,
                error: None,
            });
            for i in 0..30 {
                t.information_requests.push(InformationRequest {
                    id: format!("completed-{i}"),
                    recipient: "worker".into(),
                    generation: 1,
                    question: "Question".into(),
                    response: Some("Answer".repeat(300)),
                    error: None,
                });
            }
            Ok(())
        })
        .unwrap();
        let text = recovery_text(&load(&f.dir).unwrap(), &f.state()).unwrap();
        assert!(text.len() <= MESSAGE_LIMIT);
        assert!(text.contains("OUTSTANDING-DEPENDENCY"));
        assert!(text.contains("CURRENT-PLAN"));
        assert!(text.contains("ORIGINAL-BRIEFING"));
        assert!(text.contains("abbreviated"));
    }

    #[test]
    fn visible_history_boundary_discards_saved_conversation_without_discarding_plan_or_checkpoint()
    {
        let f = Fixture::new();
        modify(&f.dir, |s| {
            let t = team(s, "p", &f.team.id)?;
            t.saved_context = "CLEARED-CONVERSATION".into();
            t.current_plan = "KEEP-PLAN".into();
            Ok(())
        })
        .unwrap();
        let t = control(
            &f.dir,
            "p",
            &f.team.id,
            Control::HistoryBoundary,
            std::slice::from_ref(&f.lead),
        )
        .unwrap();
        let text = recovery_text(&load(&f.dir).unwrap(), &t).unwrap();
        assert!(!text.contains("CLEARED-CONVERSATION"));
        assert!(text.contains("KEEP-PLAN"));
        assert_eq!(t.checkpoint, f.team.checkpoint);
    }
    #[test]
    fn confirmed_prompt_refusal_waits_for_a_new_ready_turn_without_becoming_uncertain() {
        let mut f = Fixture::new();
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |request| {
                if matches!(request, Request::Prompt { .. }) {
                    return Err(
                        DeliveryRefused("Another message owns the ready prompt".into()).into(),
                    );
                }
                Ok(serde_json::Value::Null)
            },
        )
        .unwrap();
        assert!(
            f.state()
                .messages
                .iter()
                .all(|m| m.state == DeliveryState::Pending)
        );
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| panic!("retried a consumed ready prompt"),
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
            .since_ms += 1;
        deliver(
            &f.dir,
            "p",
            &f.team.id,
            std::slice::from_ref(&f.lead),
            |_| Ok(serde_json::Value::Null),
        )
        .unwrap();
        assert!(
            f.state()
                .messages
                .iter()
                .all(|m| m.state == DeliveryState::Delivered)
        );
    }
}
