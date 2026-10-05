// Mirrors patchbay-core's serde types.

export const PLAN_SCOPE = '@plan'
/** Reserved id for changed files under the project root that no component contains. */
export const PROJECT_SCOPE = '@project'
export type View = 'navigation' | 'plan' | 'implementation' | 'review' | 'tasks'

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
  readyWhen?: string
  action?: TerminalAction
}

export interface Component {
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
  { kind: 'startGroup'; groupId: string } | { kind: 'validateAffected'; componentId: string }

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
  readyWhen?: string
  source: string
}

export type TerminalEvent =
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

/** `status::AgentState`. */
export type AgentState = 'working' | 'needsInput' | 'review' | 'idle'

/** `status::AgentReport`: what an agent last reported through `PATCHBAY_STATUS_FILE`. */
export interface AgentReport {
  state: AgentState
  /** Unix milliseconds. */
  sinceMs: number
  message: string | null
  prompt: string | null
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

export interface TerminalSnapshot {
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

/** `model::TASK_SEPARATOR`; task ids are ASCII letters and digits, so the last one marks it. */
const TASK_SEPARATOR = '@task-'

/**
 * Mirrors `model::task_session_id`: a task's terminals end in `@task-<task>`, so the same terminal
 * can run in several worktrees at once. The component id stays before the last `/`.
 */
export const sessionId = (componentId: string, terminalId: string, task?: string | null) =>
  task ? `${componentId}/${terminalId}${TASK_SEPARATOR}${task}` : `${componentId}/${terminalId}`

/** A session id's component, terminal and task (`null` for the open worktree). */
export function parseSessionId(sid: string) {
  const slash = sid.lastIndexOf('/')
  const last = sid.slice(slash + 1)
  const at = last.lastIndexOf(TASK_SEPARATOR)
  const task = at >= 0 ? last.slice(at + TASK_SEPARATOR.length) : ''
  const scoped = /^[0-9a-z]+$/i.test(task)
  return {
    componentId: sid.slice(0, slash),
    terminalId: scoped ? last.slice(0, at) : last,
    task: scoped ? task : null,
  }
}

/** The task a session id belongs to (`null` for the open worktree). */
export const sessionTask = (sid: string) => parseSessionId(sid).task

/** `sid` moved to `task`'s scope (or the open worktree's). */
export function retask(sid: string, task: string | null): string {
  const { componentId, terminalId } = parseSessionId(sid)
  return sessionId(componentId, terminalId, task)
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
  componentId: string
  terminal: TerminalSpec
  commandId?: string
  extensionId?: string
  /** Names a `terminals.run` session, so repeating the command reuses it. */
  key?: string
}
