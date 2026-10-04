import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'
import { gitStatus } from './ipc'

let running: Promise<void> | undefined
const pending = new Set<string>()
/** Component ids and folders, which is all the Git commands need from the map. */
export const componentPaths = () =>
  useStore.getState().nodes.map((n) => ({ id: n.id, path: n.data.path }))
export function invalidateGitRefresh() {
  pending.clear()
}
/** Each watcher refreshes its originating project's status, even when its tab is inactive. */
export function requestGitRefresh(projectId = useStore.getState().project?.id): Promise<void> {
  if (getCurrentWebviewWindow().label !== 'main' || !projectId) return Promise.resolve()
  pending.add(projectId)
  running ??= refresh().finally(() => {
    running = undefined
    if (pending.size) return requestGitRefresh([...pending][0])
  })
  return running
}
async function refresh() {
  while (pending.size) {
    const id = [...pending][0]
    pending.delete(id)
    const state = useStore.getState().captureProjects()[id]?.state
    if (!state?.project) continue
    const components = state.nodes.map((n) => ({ id: n.id, path: n.data.path }))
    try {
      const status = await gitStatus(components, id)
      const current = useStore.getState()
      const target = current.captureProjects()[id]?.state
      if (
        !target ||
        target.nodes.length !== components.length ||
        !target.nodes.every(
          (n, i) => n.id === components[i].id && n.data.path === components[i].path,
        )
      )
        continue
      if (current.project?.id === id) current.setGitStatus(status)
      else
        useStore.setState((s) => ({
          projects: {
            ...s.projects,
            [id]: {
              ...s.projects[id],
              state: { ...target, gitChanges: status.changes, repos: status.repos },
            },
          },
        }))
    } catch {
      /* Missing Git or unavailable roots retain the last known status. */
    }
  }
}
