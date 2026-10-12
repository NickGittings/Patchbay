import { useEffect, useState } from 'react'
import { componentPaths } from '../../lib/git'
import { gitChanges } from '../../lib/ipc'
import { useStore } from '../../store'
import type { ChangedFile } from '../../types'

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
  const scope = JSON.stringify([projectId, componentId, base, task])
  const [loaded, setLoaded] = useState<{ scope: string; files: ChangedFile[] }>()
  const [error, setError] = useState<{ scope: string; message: string }>()
  useEffect(() => {
    let disposed = false
    void gitChanges(componentPaths(), componentId, task ?? undefined)
      .then((files) => {
        if (!disposed) {
          setLoaded({ scope, files })
          setError(undefined)
        }
      })
      .catch((e) => {
        if (!disposed) setError({ scope, message: String(e) })
      })
    return () => {
      disposed = true
    }
  }, [componentId, revision, refresh, task, scope])
  return {
    files: loaded?.scope === scope ? loaded.files : null,
    error: error?.scope === scope ? error.message : '',
    base,
    task,
    revision,
  }
}
