// Mirrors patchbay-core's serde types.

export const PLAN_SCOPE = '@plan'
export type View = 'navigation' | 'plan' | 'implementation'

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
  | { type: 'started'; sessionId: string; generation: number }
  | { type: 'output'; sessionId: string; generation: number; seq: number; data: number[] }
  | { type: 'exited'; sessionId: string; generation: number; exitCode: number }

export interface TerminalSnapshot {
  /** Base64. */
  data: string
  end: number
  generation: number
  running: boolean
  exitCode: number | null
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export interface SessionState {
  running: boolean
  exitCode?: number
}

/** Data carried on each React Flow node. */
export type ComponentData = Omit<Component, 'id' | 'position'> & Record<string, unknown>

export const sessionId = (componentId: string, terminalId: string) => `${componentId}/${terminalId}`
