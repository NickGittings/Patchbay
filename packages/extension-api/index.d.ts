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
export type StoryKind = "epic" | "feature" | "story";
export type StoryStatus =
  "backlog" | "planned" | "building" | "reviewing" | "merging" | "done";
/** A board item. `source` is set on items an extension imported. */
export interface Story {
  id: string;
  kind: StoryKind;
  parent: string | null;
  title: string;
  description: string;
  acceptance: string[];
  components: string[];
  task: string | null;
  status: StoryStatus;
  createdMs: number;
  order: number;
  source?: {
    extension: string;
    externalId: string;
    url?: string | null;
  } | null;
}
/**
 * One tracker item to import. Items are matched on `externalId` within the importing extension,
 * so importing again updates them. `parent` names another item's `externalId`. Epics have no
 * parent, features need an epic, and stories may belong to a feature (an unknown parent leaves
 * a story unassigned).
 */
export interface ExternalStoryItem {
  externalId: string;
  kind: StoryKind;
  title: string;
  parent?: string | null;
  description?: string;
  acceptance?: string[];
  /** An http(s) link back to the tracker item. */
  url?: string | null;
}
export interface StoryImportReport {
  created: number;
  updated: number;
  unchanged: number;
}
export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "HEAD";
  /** No Authorization, Cookie, Host, Proxy-* or framing headers. */
  headers?: [string, string][];
  /** POST only; at most 1 MiB. */
  body?: string;
  /**
   * The broker adds `Authorization` from a keychain secret (see `secrets`), and only for the
   * request's own origin: `bearer` sends `Bearer <secret>`, `basic` sends
   * `Basic base64(<username>:<secret>)`, and `raw` sends the secret as is.
   */
  auth?: {
    secret: string;
    scheme: "bearer" | "basic" | "raw";
    username?: string;
  };
}
export interface HttpResponse {
  status: number;
  /** The final URL after allowed redirects. */
  url: string;
  /** Lower-cased names; `set-cookie` is dropped. */
  headers: [string, string][];
  /** At most 4 MiB of text. */
  body: string;
}
export interface WebviewView {
  render(html: string): Promise<void>
  postMessage(message: unknown): Promise<void>
}
export interface ComponentSessionSummary {
  sessionId: string
  terminalId: string
  name: string
  running: boolean
  generation: number
  urls: string[]
}
export interface Patchbay {
  /** Requires project:read. Stable originating scope for this extension host. */
  workspace: {
    get(): Promise<{ projectId: string; taskId: string | null } | null>
  }
  /** Requires sessions:read. Task terminals in this component and originating task only;
   * at most 32 summaries and 32 HTTP(S) URLs per summary, without raw output/history. */
  sessions: { list(componentId: string): Promise<ComponentSessionSummary[]> }
  /** Requires urls:open. Native HTTP(S) validation; no credentials, whitespace, or controls. */
  urls: { open(url: string): Promise<void> }

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
  /** read requires files:read: project-relative paths, canonical allowed-root checks, 32 KiB.
   * pick requires files:pick: the person chooses a file (at most 1 MiB) in a native dialog;
   * null when they cancel. */
  files: {
    read(relPath: string): Promise<string>;
    pick(options?: {
      title?: string;
      /** Extensions without dots, such as ['csv', 'json']. */
      extensions?: string[];
    }): Promise<{ name: string; text: string } | null>;
  };
  /** list and onDidChange require stories:read; upsert requires stories:write. */
  stories: {
    /** The project's board (per-user, shared by its worktrees). */
    list(): Promise<Story[]>;
    /** Create or update this extension's imported items. Text fields follow the tracker;
     * status, components, order and worktree links stay Patchbay's. Large imports are sent
     * parent-first in batches, each applied whole. */
    upsert(items: ExternalStoryItem[]): Promise<StoryImportReport>;
    onDidChange(fn: (stories: Story[]) => void): Disposable;
  };
  /** Requires network. Only origins in the manifest's `network` list or approved by the person
   * in Settings → Extensions, checked again on every redirect. HTTP errors resolve with their
   * status; disallowed or failed requests reject. 25-second deadline. */
  http: { fetch(request: HttpRequest): Promise<HttpResponse> };
  /** Requires secrets. Values live in the OS keychain and are never returned to extensions. */
  secrets: {
    /** Ask the person for a value in Patchbay's own dialog; true once it is saved. */
    prompt(
      name: string,
      options?: { label?: string; description?: string },
    ): Promise<boolean>;
    has(name: string): Promise<boolean>;
    delete(name: string): Promise<void>;
  };
}
export declare const patchbay: Patchbay
declare global {
  const patchbay: Patchbay
  const patchbayView: {
    postMessage(message: unknown): void
    onMessage(fn: (message: unknown) => void): void
  }
}
