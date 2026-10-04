// Mirrors patchbay-core's serde types.

export const PLAN_SCOPE = '@plan'
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

export interface TerminalSpec {
  id: string
  name: string
  /** Empty for an interactive shell. */
  command: string
  kind: TerminalKind
  /** Output text that means a service is ready (`model::TerminalSpec::ready_when`). */
  adapter?: 'claude' | 'codex'
  readyWhen?: string
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
  projectId?: string
  schemaVersion: number
  name: string
  root: string
  components: Component[]
  links: Link[]
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
export const sessionMetadata = new Map<
  string,
  { projectId: string; componentId: string; terminalId: string }
>()
export function sessionId(componentId: string, terminalId: string, projectId = activeProjectId) {
  let a = 0xcbf29ce484222325n
  let b = 0x84222325cbf29ce4n
  for (const value of [projectId, componentId, terminalId]) {
    const bytes = new TextEncoder().encode(value)
    const length = new Uint8Array(8)
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true)
    for (const byte of [...length, ...bytes]) {
      a = BigInt.asUintN(64, (a ^ BigInt(byte)) * 0x100000001b3n)
      b = BigInt.asUintN(64, (b ^ BigInt(byte)) * 0x100000001b3n)
    }
  }
  const id = `s-${a.toString(16).padStart(16, '0')}${b.toString(16).padStart(16, '0')}`
  sessionMetadata.set(id, { projectId, componentId, terminalId })
  return id
}

export interface SessionRecord {
  id: string
  metadata: {
    projectId: string
    projectRoot: string
    projectName: string
    componentId: string
    terminalId: string
    name: string
    kind: TerminalKind
    adapter: 'claude' | 'codex' | null
    commandId?: string | null
    extensionId?: string | null
    key?: string | null
    conversationId: string | null
  }
  snapshot: TerminalSnapshot | null
  history: TerminalSnapshot[]
  interrupted: boolean
  spec: { cwd: string; command: string }
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
  projectId?: string
  componentId: string
  terminal: TerminalSpec
  commandId?: string
  extensionId?: string
  /** Names a `terminals.run` session, so repeating the command reuses it. */
  key?: string
}
