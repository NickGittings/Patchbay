import { useCallback, useEffect, useState } from 'react'
import type { Project } from '../types'
import { mergeSourceChanges } from './ipc'

type Loaded = { key: string; changes?: string[]; error?: string }

/** The selected merge source's uncommitted changes, current on focus and on `reload`. */
export function useMergeSourceChanges(
  project: Project,
  source: string | undefined,
  branch: string | undefined,
) {
  const key = JSON.stringify([project.projectId, source, branch])
  const [loaded, setLoaded] = useState<Loaded>()
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    if (!source || !branch) return
    let disposed = false
    const read = () =>
      void mergeSourceChanges(project, source, branch).then(
        (changes) => {
          if (!disposed) setLoaded({ key, changes })
        },
        (e) => {
          if (!disposed) setLoaded({ key, error: String(e) })
        },
      )
    read()
    window.addEventListener('focus', read)
    return () => {
      disposed = true
      window.removeEventListener('focus', read)
    }
  }, [project, source, branch, key, version])
  const current = loaded?.key === key ? loaded : undefined
  return { changes: current?.changes, error: current?.error, reload }
}
