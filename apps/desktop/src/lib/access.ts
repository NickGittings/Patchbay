import { projectOf, useStore } from '../store'
import { syncRoots } from './ipc'
import { requestGitRefresh } from './git'

// Keep updates ordered: a slow filesystem check must not overwrite a newer map.
let pending = Promise.resolve()
let refreshedProject: string | undefined
let refreshedComponents = ''

export function syncCurrentRoots(forceRefresh = true): Promise<void> {
  const projectId = useStore.getState().project?.id
  return projectId ? syncProjectRoots(projectId, forceRefresh) : Promise.resolve()
}

/** Keep the originating workspace's access current even while its tab is inactive. */
export function syncProjectRoots(projectId: string, forceRefresh = true): Promise<void> {
  const next = pending
    .catch(() => {})
    .then(async () => {
      const project = projectOf(projectId)
      if (!project) return
      const paths = project.components.map((c) => c.path)
      const components = JSON.stringify(project.components.map((c) => [c.id, c.path]))
      await syncRoots(paths, projectId)
      if (
        useStore.getState().project?.id === projectId &&
        (forceRefresh || refreshedProject !== projectId || refreshedComponents !== components)
      ) {
        refreshedProject = projectId
        refreshedComponents = components
        void requestGitRefresh()
      }
    })
  pending = next
  return next
}
