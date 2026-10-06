import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import { projectFrom, useStore } from '../store'
import type { Task } from '../types'

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
export const componentLabel = (id: string, projectId: string) =>
  `component-${Array.from(JSON.stringify([projectId, id]), (c) => c.codePointAt(0)!.toString(16)).join('-')}`

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
 * Panes claim terminal authority when their window becomes active (`ACTIVE_CHANGED`).
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
 * Whether this window shows a session: main shows all of them, a pop-out only its
 * component's. The backend routes terminal events the same way (`Bridge::route`).
 */
export function showsSession(metadata: { projectId: string; componentId: string }) {
  return (
    ownLabel === 'main' || componentLabel(metadata.componentId, metadata.projectId) === ownLabel
  )
}
const opening = new Map<string, Promise<void>>()

export function openComponentWindow(
  componentId: string,
  name: string,
  projectId = useStore.getState().project?.id ?? '',
): Promise<void> {
  const label = componentLabel(componentId, projectId)
  const existing = opening.get(label)
  if (existing) return existing
  const request = (async () => {
    const window = await WebviewWindow.getByLabel(label)
    if (window) {
      await window.setFocus()
      return
    }
    const project = useStore.getState().captureProjects()[projectId]
    if (!project) return
    const geometry = await invoke<Record<string, number | boolean | string>>('window_register', {
      label,
      projectId,
      componentId,
    })
    const popout = new WebviewWindow(label, {
      url: `index.html?component=${encodeURIComponent(componentId)}&project=${encodeURIComponent(projectId)}`,
      title: `${project.name} · ${name}`,
      width: 1100,
      height: 700,
      minWidth: 600,
      minHeight: 400,
      ...geometry,
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

/** Close a detached project's pop-outs, or all component windows on main-window closure. */
export async function closeComponentWindows(projectId?: string) {
  const windows = await getAllWebviewWindows()
  await Promise.all(
    windows
      .filter(
        (w) =>
          w.label.startsWith('component-') &&
          (!projectId ||
            Object.values(
              useStore.getState().captureProjects()[projectId]?.state?.nodes ?? [],
            ).some((n) => componentLabel(n.id, projectId) === w.label)),
      )
      .map((w) => w.close()),
  )
}

/** Main window owns project edits; pop-outs receive models without losing session state. */
export function syncComponentWindows(): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // What each pop-out was last sent, so selection and drags don't re-send the project. Git
  // status is re-sent on every refresh (a new object), even with equal counts: pop-out change
  // lists and diffs reload on it, since editing an already-changed file leaves the counts as
  // they were. A ready pop-out starts over.
  const sent = new Map<string, { model: string; git: unknown; tasks: string }>()
  const report = (e: unknown) => useStore.getState().setMessage(String(e))
  const payload = (projectId: string) => {
    const entry = useStore.getState().captureProjects()[projectId]
    const state = entry?.state
    if (!state?.project) return null
    return {
      project: projectFrom(state),
      git: state.gitChanges,
      tasks: { tasks: state.tasks, activeTask: state.activeTask } as TasksPayload,
    }
  }
  const broadcast = async () => {
    const windows = await getAllWebviewWindows()
    if (disposed) return
    for (const [projectId, entry] of Object.entries(useStore.getState().captureProjects())) {
      const data = payload(projectId)
      if (!data) continue
      // Positions don't matter to pop-outs, so drags don't resend anything.
      const model = JSON.stringify({
        ...data.project,
        components: data.project.components.map((c) => ({ ...c, position: undefined })),
      })
      const tasks = JSON.stringify(data.tasks)
      for (const node of entry.state?.nodes ?? []) {
        const label = componentLabel(node.id, projectId)
        if (!windows.some((w) => w.label === label)) continue
        const last = sent.get(label)
        if (last?.model !== model) await emitTo(label, PROJECT_EVENT, data.project)
        if (last?.tasks !== tasks) await emitTo<TasksPayload>(label, TASKS_EVENT, data.tasks)
        if (last?.git !== data.git) await emitTo(label, GIT_EVENT, data.git)
        sent.set(label, { model, git: data.git, tasks })
      }
    }
  }
  void listen<{ label: string; projectId: string }>(READY_EVENT, (e) => {
    const data = payload(e.payload.projectId)
    if (!data || !e.payload.label.startsWith('component-')) return
    sent.delete(e.payload.label)
    void emitTo(e.payload.label, PROJECT_EVENT, data.project).catch(report)
    void emitTo<TasksPayload>(e.payload.label, TASKS_EVENT, data.tasks).catch(report)
    void emitTo(e.payload.label, GIT_EVENT, data.git).catch(report)
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
      s.projects === prev.projects &&
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
