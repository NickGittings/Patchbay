import { useStore } from '../store'
import { syncRoots } from './ipc'

// Keep updates ordered: a slow filesystem check must not overwrite a newer map.
let pending = Promise.resolve()

export function syncCurrentRoots(): Promise<void> {
  const { project, nodes } = useStore.getState()
  if (!project) return Promise.resolve()
  const paths = nodes.map((n) => n.data.path)
  const next = pending
    .catch(() => {})
    .then(async () => {
      if (useStore.getState().project?.root === project.root) await syncRoots(paths)
    })
  pending = next
  return next
}
