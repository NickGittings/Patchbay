import { useStore } from '../store'
import { syncRoots } from './ipc'
import { requestGitRefresh } from './git'

// Keep updates ordered: a slow filesystem check must not overwrite a newer map.
let pending = Promise.resolve()
let refreshedProject: ReturnType<typeof useStore.getState>['project']
let refreshedComponents = ''

export function syncCurrentRoots(forceRefresh = true): Promise<void> {
  const { project, nodes } = useStore.getState()
  if (!project) return Promise.resolve()
  const paths = nodes.map((n) => n.data.path)
  const components = JSON.stringify(nodes.map((n) => [n.id, n.data.path]))
  const next = pending
    .catch(() => {})
    .then(async () => {
      if (useStore.getState().project === project) {
        await syncRoots(paths)
        if (
          useStore.getState().project === project &&
          (forceRefresh || refreshedProject !== project || refreshedComponents !== components)
        ) {
          refreshedProject = project
          refreshedComponents = components
          void requestGitRefresh()
        }
      }
    })
  pending = next
  return next
}
