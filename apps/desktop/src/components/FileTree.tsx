import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { listDir, onFileAccessChanged, revealPath } from '../lib/ipc'
import { rolesOf, useMapActivity } from '../lib/mapActivity'
import { navigationError, openInEditor, revealLabel } from '../lib/navigation'
import { activeWorktree } from '../lib/tasks'
import { useStore } from '../store'
import type { ChangedFile, DirEntry } from '../types'
import DiffView from './changes/DiffView'
import { useComponentChanges } from './changes/useComponentChanges'

/** What the tree marks: a component's uncommitted files and those its agents touched. */
interface Marks {
  changed: Map<string, ChangedFile>
  touched: Set<string>
  showDiff: (file: ChangedFile) => void
}
const NO_MARKS: Marks = { changed: new Map(), touched: new Set(), showDiff: () => {} }
const MarksContext = createContext<Marks>(NO_MARKS)

/** A file's own marks, or whether a folder holds marked files. */
function marksFor(marks: Marks, entry: DirEntry) {
  if (!entry.isDir) {
    const file = marks.changed.get(entry.path)
    return { file, changed: !!file, touched: marks.touched.has(entry.path) }
  }
  const inside = (path: string) => path.startsWith(`${entry.path}/`)
  return {
    file: undefined,
    changed: [...marks.changed.keys()].some(inside),
    touched: [...marks.touched].some(inside),
  }
}

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
  const marks = useContext(MarksContext)
  const { file, changed, touched } = marksFor(marks, entry)
  return (
    <>
      <div className="file-tree-row">
        <button
          className={`file-tree-entry ${entry.name.startsWith('.') ? 'dotfile' : ''} ${
            changed ? `changed ${file?.kind ?? ''}` : ''
          }`}
          style={{ paddingLeft: 10 + depth * 16 }}
          title={entry.path}
          aria-expanded={entry.isDir ? expanded : undefined}
          onClick={() => {
            if (entry.isDir) setExpanded(!expanded)
          }}
          // Folders toggle on click; only files open on a double-click.
          onDoubleClick={() => {
            if (!entry.isDir) void openInEditor({ path: entry.path })
          }}
        >
          <span className="file-tree-chevron">{entry.isDir ? (expanded ? '▾' : '▸') : '·'}</span>
          <span className="file-tree-name">{entry.name}</span>
          {touched && (
            <span
              className="file-tree-touched"
              title={entry.isDir ? 'Agents worked on files here' : 'An agent worked on this file'}
            />
          )}
        </button>
        {file && (
          <button
            className="file-tree-action"
            title="Show diff"
            aria-label={`Show diff of ${entry.name}`}
            onClick={() => marks.showDiff(file)}
          >
            ±
          </button>
        )}
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

/**
 * The files under `path`. With `componentId`, changed files and those its agents touched are
 * marked, and a changed file's diff opens below the tree.
 */
export default function FileTree({
  root,
  path,
  componentId,
}: {
  root: string
  path: string
  componentId?: string
}) {
  const [refresh, setRefresh] = useState(0)
  const [diff, setDiff] = useState<string>()
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
      {componentId && (
        <ComponentMarks componentId={componentId} refresh={refresh} diff={diff} setDiff={setDiff}>
          <Tree root={root} path={path} refresh={refresh} setRefresh={setRefresh} />
        </ComponentMarks>
      )}
      {!componentId && <Tree root={root} path={path} refresh={refresh} setRefresh={setRefresh} />}
    </div>
  )
}

function Tree({
  root,
  path,
  refresh,
  setRefresh,
}: {
  root: string
  path: string
  refresh: number
  setRefresh: (update: (n: number) => number) => void
}) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  return (
    <>
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
    </>
  )
}

const NO_PATHS: string[] = []

function ComponentMarks({
  componentId,
  refresh,
  diff,
  setDiff,
  children,
}: {
  componentId: string
  refresh: number
  diff: string | undefined
  setDiff: (path: string | undefined) => void
  children: ReactNode
}) {
  const { files, revision } = useComponentChanges(componentId, refresh)
  const roles = useMapActivity(rolesOf(componentId))
  const worktree = useStore(activeWorktree)
  const touchedPaths = useMemo(
    () => (roles.length ? roles.flatMap((r) => r.paths) : NO_PATHS),
    [roles],
  )
  const marks = useMemo<Marks>(
    () => ({
      changed: new Map((files ?? []).map((f) => [f.path, f])),
      touched: new Set(touchedPaths),
      showDiff: (file) => setDiff(file.path),
    }),
    [files, touchedPaths, setDiff],
  )
  const file = diff ? marks.changed.get(diff) : undefined
  return (
    <MarksContext.Provider value={marks}>
      {children}
      {file && (
        <div className="file-tree-diff">
          <div className="file-tree-header">
            <span className="panel-title" title={file.path}>
              {file.path.split('/').pop()}
            </span>
            <button title="Close diff" aria-label="Close diff" onClick={() => setDiff(undefined)}>
              ×
            </button>
          </div>
          <DiffView componentId={componentId} file={file} revision={revision} worktree={worktree} />
        </div>
      )}
    </MarksContext.Provider>
  )
}
