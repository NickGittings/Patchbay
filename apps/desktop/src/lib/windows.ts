import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import type { Project } from '../types'

export const absolutePath = (root: string, path: string) =>
  path === '.' ? root : `${root.replace(/[\\/]$/, '')}/${path}`

export const PROJECT_EVENT = 'patchbay://project'
export const READY_EVENT = 'patchbay://popout-ready'
export const GIT_EVENT = 'patchbay://git'

// Encoding code points avoids collisions between ids with different punctuation.
const componentLabel = (id: string) =>
  `component-${Array.from(id, (c) => c.codePointAt(0)!.toString(16)).join('-')}`
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
  // Last payloads broadcast, so selection, drags and unchanged git polls don't re-send.
  let sentProject = ''
  let sentGit = ''
  const report = (e: unknown) => useStore.getState().setMessage(String(e))
  const broadcast = async () => {
    const windows = await getAllWebviewWindows()
    if (disposed || !windows.some((w) => w.label.startsWith('component-'))) return
    const s = useStore.getState()
    if (!s.project) return
    const project = s.toProject()
    const projectJson = JSON.stringify(project)
    const gitJson = JSON.stringify(s.gitChanges)
    if (projectJson !== sentProject) {
      sentProject = projectJson
      await emit<Project>(PROJECT_EVENT, project)
    }
    if (gitJson !== sentGit) {
      sentGit = gitJson
      await emit(GIT_EVENT, s.gitChanges)
    }
  }
  void listen<{ label: string }>(READY_EVENT, (e) => {
    const s = useStore.getState()
    if (!s.project || !e.payload.label.startsWith('component-')) return
    void emitTo(e.payload.label, PROJECT_EVENT, s.toProject()).catch(report)
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
