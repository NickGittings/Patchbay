import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import { gitStatus } from './ipc'

let running: Promise<void> | undefined
const pending = new Set<string>()
/** Bumped to drop outstanding results, e.g. when a project switches task. */
let revision = 0

/** Component ids and folders, which is all the Git commands need from the map. */
export const componentPaths = () =>
  useStore.getState().nodes.map((n) => ({ id: n.id, path: n.data.path }))

/** Drop outstanding results when a project switches task or the main window unmounts. */
export function invalidateGitRefresh() {
  revision++
  pending.clear()
}

/**
 * Coalesce signals into one Git request at a time, owned by the main window. Each watcher
 * refreshes its originating project's status, even when its tab is inactive.
 */
export function requestGitRefresh(projectId = useStore.getState().project?.id): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'main' || !projectId) return Promise.resolve()
  pending.add(projectId)
  running ??= refresh().finally(() => {
    running = undefined
    // A signal can arrive in a microtask between the loop finishing and this
    // cleanup. Carry it forward even when no later filesystem event follows.
    if (pending.size) return requestGitRefresh([...pending][0])
  })
  return running
}

async function refresh() {
  while (pending.size) {
    const id = [...pending][0]
    pending.delete(id)
    const requested = revision
    const state = useStore.getState().captureProjects()[id]?.state
    if (!state?.project) continue
    const { activeTask } = state
    const components = state.nodes.map((n) => ({ id: n.id, path: n.data.path }))
    try {
      const status = await gitStatus(components, activeTask ?? undefined, id)
      const current = useStore.getState()
      const target = current.captureProjects()[id]?.state
      // Compare paths so edits during a slow status call cannot restore removed badges.
      if (
        requested !== revision ||
        !target ||
        target.activeTask !== activeTask ||
        target.nodes.length !== components.length ||
        !target.nodes.every(
          (n, i) => n.id === components[i].id && n.data.path === components[i].path,
        )
      )
        continue
      current.patchProject(id, { gitChanges: status.changes, repos: status.repos })
    } catch {
      // Git missing, an unavailable repo or a vanished task worktree: retain the last status.
    }
  }
}
