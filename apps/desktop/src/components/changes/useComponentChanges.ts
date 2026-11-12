import { useEffect, useRef, useState } from 'react'
import { SharedRequests } from '../../lib/sharedRequests'
import { gitChanges } from '../../lib/ipc'
import { useStore } from '../../store'
import type { ChangedFile } from '../../types'

const requests = new SharedRequests<ChangedFile[]>()
useStore.subscribe((state, previous) => {
  if (state.projects !== previous.projects)
    requests.retain((key) => {
      const [id] = JSON.parse(key) as [string]
      return !!state.projects[id] || state.project?.id === id
    })
})

/**
 * One component's uncommitted files in the active task's worktree, reloaded on every Git refresh
 * (the store's `gitChanges` object is replaced each time) and whenever `refresh` changes. `files`
 * is null while loading; results and errors for another project, component or task are dropped.
 */
export function useComponentChanges(componentId: string, refresh = 0) {
  const revision = useStore((s) => s.gitChanges)
  const base = useStore((s) => s.nodes.find((n) => n.id === componentId)?.data.path ?? '.')
  const task = useStore((s) => s.activeTask)
  const projectId = useStore((s) => s.project?.id)
  const paths = useStore((s) =>
    JSON.stringify(s.nodes.map((n) => ({ id: n.id, path: n.data.path }))),
  )
  const scope = JSON.stringify([projectId, componentId, task, paths])
  const previousRefresh = useRef({ scope, refresh })
  useEffect(() => {
    if (previousRefresh.current.scope === scope && previousRefresh.current.refresh !== refresh)
      requests.invalidate(scope)
    previousRefresh.current = { scope, refresh }
  }, [scope, refresh])
  const [loaded, setLoaded] = useState<{ scope: string; files: ChangedFile[] }>()
  const [error, setError] = useState<{ scope: string; message: string }>()
  useEffect(() => {
    let disposed = false
    let generation = 0
    const load = () => {
      const current = ++generation
      if (!projectId) return
      void requests
        .get(scope, revision, () =>
          gitChanges(JSON.parse(paths), componentId, task ?? undefined, projectId),
        )
        .then((files) => {
          if (!disposed && current === generation) {
            setLoaded({ scope, files })
            setError(undefined)
          }
        })
        .catch((e) => {
          if (!disposed && current === generation) setError({ scope, message: String(e) })
        })
    }
    const unsubscribe = requests.subscribe(scope, load)
    load()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [componentId, revision, task, scope, paths, projectId])
  return {
    files: loaded?.scope === scope ? loaded.files : null,
    error: error?.scope === scope ? error.message : '',
    base,
    task,
    revision: loaded?.scope === scope ? loaded.files : revision,
  }
}
