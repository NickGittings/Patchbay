import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import { gitStatus } from './ipc'

let running: Promise<void> | undefined
let pending = false
let revision = 0

/** Component ids and folders, which is all the Git commands need from the map. */
export const componentPaths = () =>
  useStore.getState().nodes.map((n) => ({ id: n.id, path: n.data.path }))

/** Drop outstanding results when the main window changes projects or unmounts. */
export function invalidateGitRefresh() {
  revision++
  pending = false
}

/** Coalesce signals into one Git request at a time, owned by the main window. */
export function requestGitRefresh(): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'main' || !useStore.getState().project)
    return Promise.resolve()
  pending = true
  running ??= refresh().finally(() => {
    running = undefined
    // A signal can arrive in a microtask between the loop finishing and this
    // cleanup. Carry it forward even when no later filesystem event follows.
    if (pending) return requestGitRefresh()
  })
  return running
}

async function refresh() {
  while (pending) {
    pending = false
    const requested = revision
    const { project } = useStore.getState()
    if (!project) continue
    const components = componentPaths()
    try {
      const status = await gitStatus(components)
      const current = useStore.getState()
      // Object identity also catches reopening the same root; compare paths so
      // edits during a slow status call cannot restore removed component badges.
      if (
        requested === revision &&
        current.project === project &&
        current.nodes.length === components.length &&
        current.nodes.every(
          (n, i) => n.id === components[i].id && n.data.path === components[i].path,
        )
      )
        current.setGitStatus(status)
    } catch {
      // Git missing or an unavailable repo: retain the last status.
    }
  }
}
