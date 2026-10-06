/** Patchbay's sandboxed extension API. Author an ES module exporting activate and optional deactivate. */
export interface Disposable {
  dispose(): void
  readonly ready: Promise<unknown>
}
export interface DetectionProvenance {
  detector: string
  packageIdentity?: string
}
export interface Component {
  detection?: DetectionProvenance
  id: string
  name: string
  kind: string
  path: string
  notes: string
  terminals: Terminal[]
  position: { x: number; y: number }
}
export interface Terminal {
  id: string
  name: string
  command: string
  kind: 'shell' | 'task' | 'agent'
  /** Output text that means a service is ready. */
  readyWhen?: string
}
export interface Project {
  schemaVersion: number
  name: string
  root: string
  components: Component[]
  links: {
    detection?: DetectionProvenance
    id: string
    source: string
    target: string
    label?: string | null
  }[]
}
export interface WebviewView {
  render(html: string): Promise<void>
  postMessage(message: unknown): Promise<void>
}
export interface Patchbay {
  commands: {
    registerCommand(id: string, fn: (...args: unknown[]) => unknown | Promise<unknown>): Disposable
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>
  }
  /** Requires project:read. */
  project: {
    get(): Promise<Project | null>
    onDidChange(fn: (project: Project | null) => void): Disposable
  }
  selection: {
    readonly component: Component | null
    onDidChangeSelection(fn: (component: Component | null) => void): Disposable
  }
  /**
   * Requires terminals. All launches go through the application's policy and allowed roots.
   * `run` reuses one session per command and component (at most eight per extension) and
   * rejects while that command is still running there.
   */
  terminals: {
    start(componentId: string, terminalId: string): Promise<string>
    run(
      componentId: string,
      command: string,
    ): Promise<{
      sessionId: string
      output: string
      exitCode: number | null
      running: boolean
    }>
  }
  /** Providers require project:read; responses are limited to 32 KiB and two seconds. */
  context: {
    registerProvider(fn: (component: Component) => string | Promise<string>): Disposable
  }
  badges: {
    registerProvider(
      fn: (component: Component) =>
        | {
            text: string
            tone?: 'info' | 'success' | 'warning' | 'error'
            tooltip?: string
          }
        | null
        | Promise<{
            text: string
            tone?: 'info' | 'success' | 'warning' | 'error'
            tooltip?: string
          } | null>,
    ): Disposable
  }
  views: {
    registerWebviewView(
      viewId: string,
      handler: {
        resolve?: (view: WebviewView) => void
        onMessage?: (message: unknown) => void
        render?: (html: string) => unknown
        postMessage?: (message: unknown) => unknown
      },
    ): Disposable
  }
  window: { showMessage(text: string): Promise<void> }
  storage: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  /** Requires project:read; reads the application's most recently polled status. */
  git: {
    status(): Promise<{
      changes: Record<string, number>
      repos: Record<string, string>
    }>
  }
  /** Requires files:read; project-relative paths, canonical allowed-root checks, 32 KiB limit. */
  files: { read(relPath: string): Promise<string> }
}
export declare const patchbay: Patchbay
declare global {
  const patchbay: Patchbay
  const patchbayView: {
    postMessage(message: unknown): void
    onMessage(fn: (message: unknown) => void): void
  }
}
