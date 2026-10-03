import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { listDir } from '../lib/ipc'
import { absolutePath } from '../lib/windows'
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
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    void listDir(root, path)
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
  }, [root, path, refresh])
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
      <button
        className={`file-tree-entry ${entry.name.startsWith('.') ? 'dotfile' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        title={absolutePath(root, entry.path)}
        aria-expanded={entry.isDir ? expanded : undefined}
        onClick={() => {
          if (entry.isDir) setExpanded(!expanded)
        }}
        // Reveal rather than open: opening with the default handler would run executables
        // (`.command`, `.app`, …) from an untrusted repo on a double-click.
        onDoubleClick={() => {
          if (!entry.isDir) {
            void revealItemInDir(absolutePath(root, entry.path)).catch((e) =>
              useStore.getState().setMessage(String(e)),
            )
          }
        }}
      >
        <span className="file-tree-chevron">{entry.isDir ? (expanded ? '▾' : '▸') : '·'}</span>
        <span className="file-tree-name">{entry.name}</span>
      </button>
      {entry.isDir && expanded && (
        <Directory root={root} path={entry.path} depth={depth + 1} refresh={refresh} />
      )}
    </>
  )
}

export default function FileTree({ root, path }: { root: string; path: string }) {
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const reload = () => setRefresh((n) => n + 1)
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
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
        <Directory root={root} path={path} depth={0} refresh={refresh} />
      </div>
    </div>
  )
}
