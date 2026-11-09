import { useEffect, useState } from 'react'
import { historyRequest, type HistorySelection } from '../../lib/history'
import type { ChangedFile } from '../../types'
import DiffView from './DiffView'

export default function CommitDetails({
  selection,
  worktree,
  onSelect,
}: {
  selection: HistorySelection
  onSelect: (value: HistorySelection) => void
  worktree?: string
}) {
  const [loaded, setLoaded] = useState<{ key: string; files: ChangedFile[] }>()
  const [failure, setFailure] = useState<{ key: string; text: string }>()
  const [path, setPath] = useState('')
  const [retry, setRetry] = useState(0)
  const key = JSON.stringify([selection.repo, selection.commit.hash, worktree])
  useEffect(() => {
    let alive = true
    void historyRequest<ChangedFile[]>(worktree, selection.repo, undefined, selection.commit.hash)
      .then((files) => {
        if (alive) {
          setLoaded({ key, files })
          setFailure(undefined)
          setPath(files[0]?.path ?? '')
        }
      })
      .catch((e) => {
        if (alive) setFailure({ key, text: String(e) })
      })
    return () => {
      alive = false
    }
  }, [key, worktree, selection.repo, selection.commit.hash, retry])
  const files = loaded?.key === key ? loaded.files : undefined
  const shownPath = selection.path ?? path
  const index = files?.findIndex((f) => f.path === shownPath) ?? -1
  return (
    <div className="commit-details">
      <header>
        <strong>{selection.commit.message.split('\n')[0]}</strong>
        <div className="hint">
          {selection.commit.author} · {new Date(selection.commit.timestamp * 1000).toLocaleString()}{' '}
          · {selection.commit.hash}
        </div>
        {selection.commit.message.includes('\n') && (
          <pre>{selection.commit.message.split('\n').slice(1).join('\n').trim()}</pre>
        )}
        {selection.commit.parents.length > 1 && (
          <div className="hint">Merge commit · compared with first parent</div>
        )}
        {failure?.key === key ? (
          <div role="alert">
            {failure.text} <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
          </div>
        ) : !files ? (
          <div className="hint">Loading files…</div>
        ) : !files.length ? (
          <div className="hint">No changed files.</div>
        ) : (
          <select
            aria-label="Commit changed file"
            value={shownPath}
            onChange={(e) => onSelect({ ...selection, path: e.target.value })}
          >
            {files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.kind}: {f.oldPath ? f.oldPath + ' → ' : ''}
                {f.path}
              </option>
            ))}
          </select>
        )}
      </header>
      {files && index >= 0 && (
        <DiffView
          componentId=""
          file={files[index]}
          revision={key}
          history={selection}
          worktree={worktree}
          nav={{
            position: index,
            total: files.length,
            step: (delta) =>
              onSelect({
                ...selection,
                path: files[Math.max(0, Math.min(files.length - 1, index + delta))].path,
              }),
          }}
        />
      )}
    </div>
  )
}
