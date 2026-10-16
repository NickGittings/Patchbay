// Mirrors patchbay-core's serde types.

export const PLAN_SCOPE = '@plan'
export const TASK_ROOT_SCOPE = '@task'
export const MERGE_SCOPE = '@merge'
export const REVIEW_SCOPE = '@review'

/**
 * A fresh agent's first task, `context::Kickoff`. A fix names the review session; the backend
 * reads its recorded worktree and branch, and refuses once that branch isn't checked out there.
 * Without one, it starts a former fix terminal again from the branch its own record keeps. `plan`
 * prompts an Auto planner.
 */
export type Kickoff =
  { kind: 'implementPlan' } | { kind: 'fixFindings'; reviewSession?: string } | { kind: 'plan' }

export const isReviewAgentScope = (scope: string) => scope === MERGE_SCOPE || scope === REVIEW_SCOPE

export const isReservedScope = (scope: string) =>
  scope === PLAN_SCOPE || scope === TASK_ROOT_SCOPE || isReviewAgentScope(scope)

/** Scopes rendered in their own panels instead of Navigation's dock. */
export const showsInDock = (scope: string) => scope !== PLAN_SCOPE && !isReviewAgentScope(scope)

export const sessionView = (scope: string): View | null =>
  isReviewAgentScope(scope) ? 'review' : scope === PLAN_SCOPE ? 'plan' : null

/** A whole-branch merge between existing worktrees of the project repository. */
export interface MergeRequest {
  source: string
  sourceBranch: string
  destination: string
  destinationBranch: string
}
export interface ReviewRequest {
  worktree: string
  branch: string
  base: string
  /** The reviewer's preset id when several review at once; each gets its own session and file. */
  lane?: string
  /** Shared by reviewers launched together, whose findings combine. */
  round?: string
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export interface Verdict {
  clean: boolean
  counts: Record<Severity, number>
}
export type MergeOutcome = 'merged' | 'alreadyIntegrated' | 'inProgress' | 'dirty' | 'notMerged'
export interface AutoBrief {
  goal: string
  fixFloor: Severity | null
  effortNote: string
  commit: boolean
}
/** The jobs an agent preset can be assigned to (per project, workspace layout only). */
export type AgentRole = 'plan' | 'implement' | 'review' | 'fix' | 'merge'
export const AGENT_ROLES: AgentRole[] = ['plan', 'implement', 'review', 'fix', 'merge']
/** Preset ids per role; only `review` uses more than its first entry. */
export type AgentRoles = Partial<Record<AgentRole, string[]>>
export interface EffortSettings {
  maxRounds: number
  severityFloor: Severity
  validate: boolean
}
export type AutoStage =
  'plan' | 'implement' | 'validate' | 'review' | 'fix' | 'mergeGate' | 'merge' | 'done'
/** The service's refusal of a launch into a session slot whose terminal still runs (`session.rs`). */
export const TERMINAL_RUNNING = 'Terminal is already running; reconnect instead'
/**
 * A session Auto tracks. Auto owns one it launched while its process generation is the one it
 * launched: its start time, else (when that couldn't be read) its launch request is still its
 * record's latest.
 */
export interface AutoLaunch {
  sessionId: string
  startedMs?: number
  requestId?: string
  /** The reviewer's lane in Auto's review round (its preset id); `null` for a single reviewer. */
  lane?: string | null
  turnSince?: number
  observedWorking?: boolean
}
export interface AutoRun {
  runId: string
  status: 'running' | 'paused' | 'waitingOnYou' | 'stopped' | 'done' | 'failed'
  stage: AutoStage
  goal: string
  effort: 'light' | 'standard' | 'thorough'
  overrides?: Partial<EffortSettings>
  merge: { mode: 'ask' | 'auto'; destinationBranch: string }
  /** The preset for any stage `agents` leaves unset (and every stage of older runs). */
  device: string
  /** The preset each agent stage launches. */
  agents?: Partial<Record<AgentRole, string>>
  /** Presets that review together when there are several; `agents.review` reviews alone. */
  reviewers?: string[]
  /** Reviewers launched beside the tracked session (see `AutoLaunch`). */
  laneSessions?: AutoLaunch[]
  /** The branch the run works on; Auto never judges another branch checked out in its worktree. */
  branch?: string
  round: number
  sessionId?: string
  /** Auto may stop only a session it launched, in the recorded process generation. */
  sessionOwned?: boolean
  /** The tracked session's launch request and review lane, as in `AutoLaunch`. */
  sessionRequestId?: string
  sessionLane?: string | null
  /** The review round Auto launched; a later round in the findings was started by someone else. */
  reviewRound?: string
  /** The reviewer whose prompt the current input wait opens. */
  inputSessionId?: string
  turnSince?: number
  launchAtMs?: number
  observedWorking?: boolean
  sessionStartedMs?: number
  /**
   * What Auto launched its tracked session with, sent again on every later start of that session
   * so its briefing, and with it Restart's fingerprint, stays the same.
   */
  sessionBrief?: { sessionId: string; auto: AutoBrief; kickoff?: Kickoff }
  /** Fingerprint of the project plan and proposal when the planner launched. */
  planMark?: string
  log: { atMs: number; text: string }[]
  reason?: string
  /** Why the approval wait couldn't check the merge status; it keeps retrying meanwhile. */
  gateError?: string
  waitingFor?: 'agentInput' | 'fixBudget'
  validation?: ActionReport[]
  reviewedHead?: string
  findingsSummary?: string
  validationFindings?: string
}

export interface ReviewFindings {
  verdict: Verdict | null
  text: string
  modifiedMs: number
  reviewedHead: string | null
  /** The base branch of the findings `text` shows. */
  base: string
  /**
   * The latest round: `reviewers`, `verdict` and `reviewedHead` describe it, while `text` may show
   * an earlier round's findings until one of its reviewers writes. Empty before rounds.
   */
  round: string
  /** When the review attempt started; later changes weren't reviewed. */
  startedMs: number
  /** Files in the branch's worktree changed after the attempt started, or couldn't be checked. */
  editedSinceStart: boolean
  truncated: boolean
  /** Each reviewer of the round; one entry for a single reviewer. */
  reviewers: ReviewerStatus[]
}
export interface ReviewerStatus {
  lane: string | null
  /** It wrote findings since its attempt started. */
  finished: boolean
  verdict: Verdict | null
  /** Launch could not be confirmed; cleared by fresh findings. */
  error?: string | null
}

/** Reserved id for changed files under the project root that no component contains. */
export const PROJECT_SCOPE = '@project'
export type View = 'navigation' | 'plan' | 'implementation' | 'review'

export type ComponentKind =
  'frontend' | 'backend' | 'service' | 'library' | 'database' | 'app' | 'other'

export const COMPONENT_KINDS: ComponentKind[] = [
  'frontend',
  'backend',
  'service',
  'library',
  'database',
  'app',
  'other',
]

export type TerminalKind = 'shell' | 'task' | 'agent'
export type TerminalAction = 'development' | 'validation'

export interface TerminalSpec {
  id: string
  name: string
  /** Empty for an interactive shell. */
  command: string
  kind: TerminalKind
  /** Output text that means a service is ready (`model::TerminalSpec::ready_when`). */
  adapter?: 'claude' | 'codex'
  readyWhen?: string
  action?: TerminalAction
}

export interface DetectionProvenance {
  detector: string
  packageIdentity?: string
}
export type MapIssueKind = 'missing' | 'locked' | 'unreadable'
export interface MapIssue {
  componentId: string
  kind: MapIssueKind
  message: string
}
export type ReconciliationChange =
  | { kind: 'addComponent'; component: Component }
  | { kind: 'addLink'; link: Link }
  | { kind: 'removeLink'; linkId: string }
  | { kind: 'removeComponent'; componentId: string }
  | { kind: 'moveComponent'; componentId: string; path: string }
export interface ReconciliationProposal {
  id: string
  selected: boolean
  description: string
  change: ReconciliationChange
}
export interface ReconciliationPreview {
  id: string
  accessRevision: number
  issues: MapIssue[]
  proposals: ReconciliationProposal[]
}
export interface MapEdit {
  project: Project
  lease: string | null
}

export interface Component {
  detection?: DetectionProvenance
  id: string
  name: string
  kind: ComponentKind
  /** Folder relative to the project root; "." is the root. */
  path: string
  notes: string
  terminals: TerminalSpec[]
  position: { x: number; y: number }
}

/** `source` depends on `target`. */
export interface Link {
  detection?: DetectionProvenance
  id: string
  source: string
  target: string
  label?: string | null
}

/** What a rescan or Add repo… put on the map: new components and their links, with final ids. */
export interface Added {
  components: Component[]
  links: Link[]
}

export interface Project {
  projectId?: string
  schemaVersion: number
  name: string
  root: string
  components: Component[]
  links: Link[]
  groups?: ComponentGroup[]
}

export interface ComponentGroup {
  id: string
  name: string
  componentIds: string[]
  orderedStartup: boolean
  readinessTimeoutSeconds: number
}

export type ActionRequest =
  | { kind: 'startGroup'; groupId: string }
  | { kind: 'validateAffected'; componentId: string }
  | { kind: 'validateChanged'; componentIds: string[] }

export interface ActionPlan {
  request: ActionRequest
  stages: string[][]
  skipped: string[]
  sessions: string[]
  /** The task whose worktree the terminals run in (`ActionPlan::task`). */
  task: string | null
}

export interface ActionReport {
  plan: ActionPlan
  results: {
    sessionId: string
    outcome: 'started' | 'reused' | 'passed' | 'failed' | 'stopped' | 'cancelled'
    exitCode: number | null
  }[]
}

/** Uncommitted changes per component, and the repo of components not in the project root's repo. */
export interface GitStatus {
  changes: Record<string, number>
  repos: Record<string, string>
}

/** How a file differs from `HEAD` (`git::ChangeKind`). */
export type ChangeKind =
  'modified' | 'added' | 'deleted' | 'renamed' | 'typeChanged' | 'conflicted' | 'untracked'

/** One uncommitted change (`git::ChangedFile`). Paths are relative to the project root. */
export interface ChangedFile {
  path: string
  kind: ChangeKind
  oldPath?: string
  /** Unix milliseconds; absent for deleted files. */
  modifiedMs?: number
  /** Lines added and removed; absent for binary files. */
  added?: number
  removed?: number
}

/** A worktree of the project root's repo (`git::Worktree`). */
export interface Worktree {
  /** Absolute; passed back to select it. */
  path: string
  /** Absent for a detached `HEAD`. */
  branch?: string
  head: string
  main: boolean
  current: boolean
}

/** A file's diff against `HEAD` (`git::FileDiff`). */
export interface FileDiff {
  patch: string
  binary: boolean
  truncated: boolean
}

/** A component that depends on changed components (`git::Affected`). */
export interface Affected {
  id: string
  via: string[]
}

/** Changes per component plus their dependents (`git::Review`). */
export interface Review {
  ahead?: boolean
  changes: Record<string, ChangedFile[]>
  affected: Affected[]
}

export interface DeviceManifest {
  id: string
  name: string
  category: string
  description?: string | null
  command: string
  kind: TerminalKind
  adapter?: 'claude' | 'codex'
  readyWhen?: string
  source: string
}

export type TerminalEvent = (
  | {
      type: 'started'
      sessionId: string
      generation: number
      startedMs: number
      notice: string | null
    }
  | { type: 'output'; sessionId: string; generation: number; seq: number; data: number[] }
  | { type: 'exited'; sessionId: string; generation: number; exitCode: number; exitedMs: number }
  | { type: 'status'; sessionId: string; generation: number; status: SessionStatus }
) & { instanceId?: string }

/** `status::AgentState`. */
export type AgentState = 'working' | 'needsInput' | 'review' | 'idle' | 'ended'

/** `status::AgentReport`: what an agent last reported through `PATCHBAY_STATUS_FILE`. */
export interface AgentReport {
  state: AgentState
  /** Unix milliseconds. */
  sinceMs: number
  message: string | null
  prompt: string | null
  provider?: 'claude' | 'codex' | null
  conversationId?: string | null
  turnId?: string | null
  authoritative?: boolean
}

/** `status::SessionStatus`: what a running session is doing. */
export interface SessionStatus {
  lastOutputMs: number | null
  active: boolean
  agent: AgentReport | null
  url: string | null
  ready: boolean
  healthy: boolean | null
  /** The user asked it to stop, so a non-zero exit isn't a failure. */
  stopped: boolean
  /** When a window last showed it to the user (`terminal_seen`), in Unix ms. */
  seenMs: number | null
}

/** `plans::Plan`: a saved plan for the editor, `cut` when the file is longer than it holds. */
export interface PlanText {
  text: string
  cut: boolean
}

export interface TerminalSnapshot {
  /** Original launch folder for this incarnation; absent in legacy history. */
  launchDirectory?: string | null
  truncated: boolean
  /** Base64. */
  data: string
  end: number
  generation: number
  running: boolean
  exitCode: number | null
  /** Unix milliseconds. */
  startedMs: number
  exitedMs: number | null
  status: SessionStatus
  /** Why an agent's briefing wasn't injected normally, if it wasn't. */
  notice: string | null
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface SessionState {
  disconnected?: boolean
  interrupted?: boolean
  truncated?: boolean
  running: boolean
  exitCode?: number
  /** When the current or last run started and ended, in Unix milliseconds. */
  startedMs?: number
  exitedMs?: number
  status?: SessionStatus
  /** Shown above the terminal, since full-screen agents hide the dim output line. */
  notice?: string
}

/** Data carried on each React Flow node. */
export type ComponentData = Omit<Component, 'id' | 'position'> & Record<string, unknown>

let activeProjectId = ''
export const setProjectIdentity = (id: string) => {
  activeProjectId = id
}
/** `model::TASK_SEPARATOR`; task ids are ASCII letters and digits. */
const TASK_SEPARATOR = '@task-'

export interface SessionIdentity {
  projectId: string
  componentId: string
  terminalId: string
  /** The task whose worktree the terminal runs in; `null` for the project's own. */
  task: string | null
}
/** What each opaque session id stands for; ids are never parsed. */
export const sessionMetadata = new Map<string, SessionIdentity>()

/**
 * Mirrors `model::task_session_id`: the opaque id of a terminal of a project's component, run
 * for `task` when given, so the same terminal can run in several worktrees and projects at once.
 */
export function sessionId(
  componentId: string,
  terminalId: string,
  task?: string | null,
  projectId = activeProjectId,
) {
  const terminal = task ? `${terminalId}${TASK_SEPARATOR}${task}` : terminalId
  const key = JSON.stringify([projectId, componentId, terminal])
  const known = hashed.get(key)
  if (known) return known
  let a = 0xcbf29ce484222325n
  let b = 0x84222325cbf29ce4n
  for (const value of [projectId, componentId, terminal]) {
    const bytes = new TextEncoder().encode(value)
    const length = new Uint8Array(8)
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true)
    for (const byte of [...length, ...bytes]) {
      a = BigInt.asUintN(64, (a ^ BigInt(byte)) * 0x100000001b3n)
      b = BigInt.asUintN(64, (b ^ BigInt(byte)) * 0x100000001b3n)
    }
  }
  const id = `s-${a.toString(16).padStart(16, '0')}${b.toString(16).padStart(16, '0')}`
  sessionMetadata.set(id, { projectId, componentId, terminalId, task: task ?? null })
  hashed.set(key, id)
  return id
}

/** The planner belongs to the project, not a worktree, so its sessions never carry a task. */
export const plannerSessionId = (terminalId: string, projectId?: string) =>
  sessionId(PLAN_SCOPE, terminalId, null, projectId)
/** Ids already hashed: selectors compute them for every terminal on every store change. */
const hashed = new Map<string, string>()

/** A session's project, component, terminal and task, from its recorded metadata. */
export function parseSessionId(sid: string): SessionIdentity {
  return (
    sessionMetadata.get(sid) ?? {
      projectId: activeProjectId,
      componentId: '',
      terminalId: '',
      task: null,
    }
  )
}

/** The task a session belongs to (`null` for the project's own worktree). */
export const sessionTask = (sid: string) => parseSessionId(sid).task

/** `sid` moved to `task`'s scope (or the project's own worktree). */
export function retask(sid: string, task: string | null): string {
  const { projectId, componentId, terminalId } = parseSessionId(sid)
  return sessionId(componentId, terminalId, task, projectId)
}

export interface SessionRecord {
  id: string
  /** Launch request identities retained by the session service. */
  requestIds?: string[]
  metadata: {
    projectId: string
    projectRoot: string
    projectName: string
    componentId: string
    terminalId: string
    task?: string | null
    /** Display name captured at launch; absent in older retained records. */
    taskTitle?: string | null
    name: string
    kind: TerminalKind
    adapter: 'claude' | 'codex' | null
    commandId?: string | null
    extensionId?: string | null
    key?: string | null
    /** The branch a review job covers, or a fix agent's reviewed branch; absent otherwise. */
    branch?: string | null
    /** A review job's reviewer lane when several reviewed at once. */
    lane?: string | null
    conversationId: string | null
    /** Set by the user, so captured resume hints don't replace it. */
    conversationPinned?: boolean
  }
  snapshot: TerminalSnapshot | null
  history: TerminalSnapshot[]
  interrupted: boolean
  /** `dirs`: folders the agent was given besides `cwd`, checked again before resuming. */
  spec: { cwd: string; command: string; dirs?: string[]; merge_source?: string | null }
}
export interface WorkspaceProject {
  id: string
  root: string
  name: string
  savedFingerprint: string
  draft: Project | null
  layout: Record<string, unknown>
}
export interface WorkspaceDocument {
  version: number
  projects: WorkspaceProject[]
  activeProject: string | null
  windows: Record<
    string,
    {
      projectId?: string
      componentId?: string
      x?: number
      y?: number
      width?: number
      height?: number
      maximized?: boolean
    }
  >
}
export interface OpenedProject {
  id: string
  fingerprint: string
  project: Project
  detected: boolean
  locked: string[]
}

/** A named piece of work on its own branch and worktree (`tasks::Task`). */
export interface Task {
  id: string
  title: string
  /** Absolute, canonical worktree folder. */
  worktree: string
  /** Absent for a detached `HEAD`. */
  branch?: string
  base?: string
  /** Components the task is about, as the user picked them. */
  components: string[]
  notes: string
  createdMs: number
  /** The worktree no longer exists. */
  missing: boolean
  /** The project is open in this worktree. */
  current: boolean
}

/** `tasks::TaskDraft` */
export interface TaskDraft {
  title: string
  branch: string
  base?: string
  components: string[]
}

/** `tasks::TaskPatch` */
export interface TaskPatch {
  title?: string
  notes?: string
  components?: string[]
}

export interface ContextSection {
  title: string
  body: string
}
export interface DetectorContribution {
  id: string
  files: string[]
  kind: ComponentKind
  terminals: TerminalSpec[]
}
export interface CommandContribution {
  id: string
  title: string
  run: { command: string; kind: TerminalKind } | null
  when?: string | null
}
export interface MenuContribution {
  command: string
  when?: string | null
}
export interface ViewContribution {
  id: string
  title: string
  location: 'inspector' | 'dock'
}
export interface ExtensionManifest {
  name: string
  publisher: string
  version: string
  displayName?: string | null
  engines: { patchbay: string }
  main?: string | null
  activationEvents: string[]
  permissions: string[]
  contributes: {
    devices: DeviceManifest[]
    detectors: DetectorContribution[]
    commands: CommandContribution[]
    menus: Record<string, MenuContribution[]>
    context: { title: string; file: string }[]
    views: ViewContribution[]
  }
}
export interface Extension {
  id: string
  dir: string
  manifest: ExtensionManifest
  enabled: boolean
  errors: string[]
}
export interface ExtensionRegistry {
  extensions: Extension[]
  errors: string[]
}
export interface ExtensionBadge {
  text: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  tooltip?: string
}
export interface RuntimeTerminal {
  taskId?: string | null
  projectId?: string
  componentId: string
  terminal: TerminalSpec
  commandId?: string
  extensionId?: string
  /** Names a `terminals.run` session, so repeating the command reuses it. */
  key?: string
}

/** Machine-local status-hook setup; installed does not mean provider trust or live reporting. */
export interface AgentIntegration {
  provider: 'claude' | 'codex'
  source: string
  reporter: string
  installed: boolean
  disabled: boolean
  reporterAvailable: boolean
  reportingSessions: number
  guidance: string[]
}

/** Machine-local editor preference; never serialized into patchbay.json. */
export type EditorKind = 'vsCode' | 'cursor' | 'zed' | 'custom'
export interface EditorPreferences {
  editor: EditorKind
  executable: string
  arguments: string[]
}
export interface EditorTarget {
  path: string
  line?: number
  column?: number
}
export interface EditorLauncher {
  editor: EditorKind
  executable: string | null
}
export interface FileSearchResult {
  path: string
  name: string
}

export interface ComponentSessionSummary {
  sessionId: string
  terminalId: string
  name: string
  running: boolean
  generation: number
  urls: string[]
}

export interface PlannerProposal {
  version: number
  plan: string
  assignments: { componentId: string; assignment: string }[]
}
export interface TaskActivity {
  id: string
  projectId: string
  task: string | null
  initiator: string
  action: { kind: string; groupId?: string; componentId?: string; componentIds?: string[] }
  state: 'running' | 'finished' | 'failed'
  report: ActionReport | null
  error: string | null
  previewUrls: string[]
}
