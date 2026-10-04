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
  source: string
}

export type TerminalEvent =
  | { type: 'started'; sessionId: string; generation: number; startedMs: number }
  | { type: 'output'; sessionId: string; generation: number; seq: number; data: number[] }
  | { type: 'exited'; sessionId: string; generation: number; exitCode: number; exitedMs: number }

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
}

/** Data carried on each React Flow node. */
export type ComponentData = Omit<Component, 'id' | 'position'> & Record<string, unknown>

export const sessionId = (componentId: string, terminalId: string) => `${componentId}/${terminalId}`

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
