import { useEffect, useState } from 'react'
import { listDir, onFileAccessChanged, revealPath } from '../lib/ipc'
import { navigationError, openInEditor, revealLabel } from '../lib/navigation'
import { useStore } from '../store'
import type { DirEntry } from '../types'

function Directory({
  root,
  path,
  depth,
  refresh,
}: {
  root: string
  path: string
  depth: number
  refresh: number
}) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    void listDir(path, projectId, task)
      .then((items) => {
        if (!disposed) {
          setEntries(items)
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [path, refresh, projectId, task])
  if (error) return <div className="hint file-tree-error">{error}</div>
  if (!entries) return <div className="hint">Loading…</div>
  if (!entries.length)
    return (
      <div className="hint" style={{ paddingLeft: 12 + depth * 16 }}>
        Empty folder
      </div>
    )
  return entries.map((entry) => (
    <TreeEntry key={entry.path} entry={entry} root={root} depth={depth} refresh={refresh} />
  ))
}

function TreeEntry({
  entry,
  root,
  depth,
  refresh,
}: {
  entry: DirEntry
  root: string
  depth: number
  refresh: number
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div className="file-tree-row">
        <button
          className={`file-tree-entry ${entry.name.startsWith('.') ? 'dotfile' : ''}`}
          style={{ paddingLeft: 10 + depth * 16 }}
          title={entry.path}
          aria-expanded={entry.isDir ? expanded : undefined}
          onClick={() => {
            if (entry.isDir) setExpanded(!expanded)
          }}
          onDoubleClick={() => void openInEditor({ path: entry.path })}
        >
          <span className="file-tree-chevron">{entry.isDir ? (expanded ? '▾' : '▸') : '·'}</span>
          <span className="file-tree-name">{entry.name}</span>
        </button>
        <button
          className="file-tree-action"
          title="Open in editor"
          aria-label={`Open ${entry.name} in editor`}
          onClick={() => void openInEditor({ path: entry.path })}
        >
          ↗
        </button>
        <button
          className="file-tree-action"
          title={revealLabel}
          aria-label={`${revealLabel}: ${entry.name}`}
          onClick={() => void revealPath(entry.path).catch(navigationError)}
        >
          ⌖
        </button>
      </div>
      {entry.isDir && expanded && (
        <Directory root={root} path={entry.path} depth={depth + 1} refresh={refresh} />
      )}
    </>
  )
}

/** Refreshing re-lists every expanded folder, so focus only triggers it this often. */
const FOCUS_REFRESH_MS = 5000

export default function FileTree({ root, path }: { root: string; path: string }) {
  const [refresh, setRefresh] = useState(0)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  useEffect(() => {
    let last = Date.now()
    let disposed = false
    let unlisten: (() => void) | undefined
    void onFileAccessChanged(() => setRefresh((n) => n + 1)).then((cleanup) => {
      if (disposed) cleanup()
      else unlisten = cleanup
    })
    const reload = () => {
      if (Date.now() - last < FOCUS_REFRESH_MS) return
      last = Date.now()
      setRefresh((n) => n + 1)
    }
    window.addEventListener('focus', reload)
    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('focus', reload)
    }
  }, [])
  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="panel-title">Files</span>
        <button title="Refresh files" onClick={() => setRefresh((n) => n + 1)}>
          ↻ Refresh
        </button>
      </div>
      <div className="file-tree-content">
        <Directory
          key={JSON.stringify([projectId, task, path])}
          root={root}
          path={path}
          depth={0}
          refresh={refresh}
        />
      </div>
    </div>
  )
}
