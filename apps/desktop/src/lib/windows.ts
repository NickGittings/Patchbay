import { invoke } from '@tauri-apps/api/core'
import { sessionMetadata } from '../types'
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
  WebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import type { Project } from '../types'

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
  const metadata = sessionMetadata.get(sid)
  return metadata ? [componentLabel(metadata.componentId, metadata.projectId)] : []
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
    const geometry = await invoke<Record<string, number | boolean>>('window_register', {
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
  const report = (e: unknown) => useStore.getState().setMessage(String(e))
  const payload = (projectId: string) => {
    const entry = useStore.getState().captureProjects()[projectId]
    const state = entry?.state
    if (!state?.project) return null
    return {
      project: {
        schemaVersion: 2,
        projectId,
        name: entry.name,
        root: entry.root,
        components: state.nodes.map(({ id, position, data }) => ({ id, position, ...data })),
        links: state.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.data?.label,
        })),
      } as Project,
      git: state.gitChanges,
    }
  }
  const broadcast = async () => {
    const windows = await getAllWebviewWindows()
    if (disposed) return
    for (const [projectId, entry] of Object.entries(useStore.getState().captureProjects())) {
      const data = payload(projectId)
      if (!data) continue
      for (const node of entry.state?.nodes ?? []) {
        const label = componentLabel(node.id, projectId)
        if (!windows.some((w) => w.label === label)) continue
        await emitTo(label, PROJECT_EVENT, data.project)
        await emitTo(label, GIT_EVENT, data.git)
      }
    }
  }
  void listen<{ label: string; projectId: string }>(READY_EVENT, (e) => {
    const data = payload(e.payload.projectId)
    if (!data || !e.payload.label.startsWith('component-')) return
    void emitTo(e.payload.label, PROJECT_EVENT, data.project).catch(report)
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
      s.gitChanges === prev.gitChanges
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
