import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import type { Project, Task } from '../types'

/**
 * Join a component path (which may start with `../`) onto the root, resolving `.` and `..`.
 * An absolute path (another Windows drive, where no relative path exists) is kept as is.
 */
export function absolutePath(root: string, path: string) {
  if (path === '.') return root
  const absolute = /^([a-zA-Z]:)?[\\/]/.test(path)
  const segments = path.split(/[\\/]/)
  // The first segment of an absolute path is '' (Unix) or the drive (Windows).
  const parts = absolute ? [segments.shift()!] : root.replace(/[\\/]$/, '').split(/[\\/]/)
  for (const part of segments) {
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

export const PROJECT_EVENT = 'patchbay://project'
export const READY_EVENT = 'patchbay://popout-ready'
export const GIT_EVENT = 'patchbay://git'
/** The task list and active task, so pop-outs run terminals in the same worktree. */
export const TASKS_EVENT = 'patchbay://tasks'
export interface TasksPayload {
  tasks: Task[]
  activeTask: string | null
}
const ACTIVE_EVENT = 'patchbay://active-window'
/** Emitted by the backend with the label of a window that has closed. */
const CLOSED_EVENT = 'patchbay://window-closed'
/** DOM event on `window` whenever the active window changes, so panes can refit. */
export const ACTIVE_CHANGED = 'patchbay:active-changed'

// Encoding code points avoids collisions between ids with different punctuation.
// Must match `component_window_label` in src-tauri/src/lib.rs.
const componentLabel = (id: string) =>
  `component-${Array.from(id, (c) => c.codePointAt(0)!.toString(16)).join('-')}`

const ownLabel = getCurrentWebviewWindow().label
/** The window that most recently had focus, as last heard by this webview. */
let activeLabel = 'main'

const setActive = (label: string) => {
  if (label === activeLabel) return
  activeLabel = label
  window.dispatchEvent(new Event(ACTIVE_CHANGED))
}

/**
 * Track which window was focused last, across webviews. Call once per webview at startup.
 * The focused window always answers its own input; `ownsSession` decides who answers when
 * nothing is focused.
 */
export function trackActiveWindow() {
  const activate = () => {
    if (activeLabel === ownLabel) return
    setActive(ownLabel)
    void emit(ACTIVE_EVENT, ownLabel).catch(() => {})
  }
  window.addEventListener('focus', activate)
  if (document.hasFocus()) activate()
  void listen<string>(ACTIVE_EVENT, (e) => setActive(e.payload)).catch(() => {})
  void listen<string>(CLOSED_EVENT, (e) => {
    if (e.payload === activeLabel) setActive('main')
  }).catch(() => {})
}

/**
 * Exactly one window owns each session: it answers the terminal's automatic queries
 * (cursor position, device attributes…) and sizes its PTY. That's the active window when
 * it shows the session (main shows them all, a pop-out only its component's), otherwise main.
 */
export function ownsSession(sid: string) {
  const activeShows =
    activeLabel === 'main' || labelsShowing(sid).some((label) => label === activeLabel)
  return activeShows ? activeLabel === ownLabel : ownLabel === 'main'
}

/** Labels of the pop-outs that could show `sid`; component ids may themselves contain `/`. */
function labelsShowing(sid: string) {
  const labels: string[] = []
  for (let i = sid.indexOf('/'); i >= 0; i = sid.indexOf('/', i + 1))
    labels.push(componentLabel(sid.slice(0, i)))
  return labels
}
const opening = new Map<string, Promise<void>>()

export function openComponentWindow(componentId: string, name: string): Promise<void> {
  const label = componentLabel(componentId)
  const existing = opening.get(label)
  if (existing) return existing
  const request = (async () => {
    const window = await WebviewWindow.getByLabel(label)
    if (window) {
      await window.setFocus()
      return
    }
    const project = useStore.getState().project
    if (!project) return
    const popout = new WebviewWindow(label, {
      url: `index.html?component=${encodeURIComponent(componentId)}`,
      title: `${project.name} · ${name}`,
      width: 1100,
      height: 700,
      minWidth: 600,
      minHeight: 400,
    })
    await new Promise<void>((resolve, reject) => {
      void popout.once('tauri://created', () => resolve())
      void popout.once('tauri://error', (e) => reject(e.payload))
    })
  })()
    .catch((e) => useStore.getState().setMessage(String(e)))
    .finally(() => opening.delete(label))
  opening.set(label, request)
  return request
}

/** Close every pop-out, e.g. before switching projects so none shows stale sessions. */
export async function closeComponentWindows() {
  const windows = await getAllWebviewWindows()
  await Promise.all(windows.filter((w) => w.label.startsWith('component-')).map((w) => w.close()))
}

/** Main window owns project edits; pop-outs receive models without losing session state. */
export function syncComponentWindows(): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // Last payloads broadcast, so selection and drags don't re-send the project. Git status is
  // re-sent on every refresh (a new object), even with equal counts: pop-out change lists and
  // diffs reload on it, since editing an already-changed file leaves the counts as they were.
  let sentProject = ''
  let sentGit: unknown = null
  let sentTasks = ''
  const tasksPayload = (): TasksPayload => {
    const { tasks, activeTask } = useStore.getState()
    return { tasks, activeTask }
  }
  const report = (e: unknown) => useStore.getState().setMessage(String(e))
  const broadcast = async () => {
    const windows = await getAllWebviewWindows()
    if (disposed) return
    if (!windows.some((w) => w.label.startsWith('component-'))) {
      // Nobody received the changes, so the next pop-out's READY reply is its baseline.
      sentProject = ''
      sentGit = null
      sentTasks = ''
      return
    }
    const s = useStore.getState()
    if (!s.project) return
    const project = s.toProject()
    const projectJson = JSON.stringify(project)
    if (projectJson !== sentProject) {
      sentProject = projectJson
      await emit<Project>(PROJECT_EVENT, project)
    }
    const tasks = tasksPayload()
    const tasksJson = JSON.stringify(tasks)
    if (tasksJson !== sentTasks) {
      sentTasks = tasksJson
      await emit<TasksPayload>(TASKS_EVENT, tasks)
    }
    if (s.gitChanges !== sentGit) {
      sentGit = s.gitChanges
      await emit(GIT_EVENT, s.gitChanges)
    }
  }
  void listen<{ label: string }>(READY_EVENT, (e) => {
    const s = useStore.getState()
    if (!s.project || !e.payload.label.startsWith('component-')) return
    void emitTo(e.payload.label, PROJECT_EVENT, s.toProject()).catch(report)
    void emitTo(e.payload.label, TASKS_EVENT, tasksPayload()).catch(report)
    void emitTo(e.payload.label, GIT_EVENT, s.gitChanges).catch(report)
  })
    .then((f) => {
      if (disposed) f()
      else unlisten = f
    })
    .catch(report)
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (
      s.nodes === prev.nodes &&
      s.edges === prev.edges &&
      s.project === prev.project &&
      s.gitChanges === prev.gitChanges &&
      s.tasks === prev.tasks &&
      s.activeTask === prev.activeTask
    )
      return
    clearTimeout(timer)
    timer = setTimeout(() => void broadcast().catch(report), 300)
  })
  return () => {
    disposed = true
    unlisten?.()
    unsubscribe()
    clearTimeout(timer)
  }
}
