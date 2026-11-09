import type { ChangedFile } from '../../types'
import { ago } from '../../lib/review'
import { Fragment, useEffect, useEffectEvent, useState } from 'react'
import {
  graphRows,
  historyRequest,
  type HistoryPage,
  type HistorySelection,
} from '../../lib/history'
import { useStore } from '../../store'
import './history.css'

const colors = ['#8b9eff', '#d598ed', '#65c9b0', '#eab66b', '#76bce7']

function HistoryBrowser({
  worktree,
  selected,
  onSelect,
}: {
  worktree?: string
  selected: HistorySelection | null
  onSelect: (value: HistorySelection | null) => void
}) {
  const project = useStore((s) => s.project?.id)
  const revision = useStore((s) => s.gitChanges)
  const paths = useStore((s) => s.nodes.map((n) => n.data.path).join('\0'))
  const [repos, setRepos] = useState<string[] | null>(null)
  const [repo, setRepo] = useState('')
  const [limit, setLimit] = useState(50)
  const [page, setPage] = useState<HistoryPage>()
  const [error, setError] = useState('')
  const [repoRetry, setRepoRetry] = useState(0)
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState(() => localStorage.getItem('commit-history-open') !== 'false')
  // Keep polling scoped to a mounted, expanded history browser.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(timer)
  }, [open])
  const resetSelection = useEffectEvent(() => onSelect(null))
  useEffect(() => {
    let alive = true
    resetSelection()
    void historyRequest<string[]>(worktree)
      .then((result) => {
        if (alive) {
          setRepos(result)
          setRepo(result[0] ?? '')
        }
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
    // Selection callback is intentionally excluded: only scope changes reset selection.
  }, [project, worktree, paths, repoRetry])
  useEffect(() => {
    if (!repo || !open) return
    let alive = true
    void historyRequest<HistoryPage>(worktree, repo, limit)
      .then((result) => {
        if (alive) {
          setPage(result)
          setError('')
        }
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [project, worktree, repo, limit, revision, tick, open])
  const retry = () => {
    if (!repo) setRepoRetry((n) => n + 1)
    else setTick((n) => n + 1)
  }
  const rows = graphRows(page?.commits ?? [])
  return (
    <section className="commit-history" aria-label="Recent commits">
      <header>
        <button
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
            localStorage.setItem('commit-history-open', String(!open))
          }}
        >
          {open ? '▾' : '▸'} Recent commits
        </button>
        <button aria-label="Refresh history" onClick={retry}>
          ↻
        </button>
      </header>
      {open && (
        <>
          {(repos?.length ?? 0) > 1 && (
            <select
              aria-label="History repository"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value)
                setLimit(50)
                setPage(undefined)
                onSelect(null)
              }}
            >
              {repos?.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          {error ? (
            <div className="hint" role="alert">
              {error} <button onClick={retry}>Retry</button>
            </div>
          ) : !repos ? (
            <div className="hint">Loading repositories…</div>
          ) : !repos.length ? (
            <div className="hint">No Git repository.</div>
          ) : !page ? (
            <div className="hint">Loading commits…</div>
          ) : !page.commits.length ? (
            <div className="hint">No commits yet.</div>
          ) : (
            page.commits.map((commit, i) => {
              const row = rows[i]
              const width = Math.max(row.before.length, row.after.length, 1) * 12 + 12
              const x = (lane: number) => lane * 12 + 10
              return (
                <Fragment key={commit.hash}>
                  <button
                    className={`commit-row ${selected?.repo === repo && selected.commit.hash === commit.hash ? 'active' : ''}`}
                    key={commit.hash}
                    aria-pressed={selected?.repo === repo && selected.commit.hash === commit.hash}
                    title={`${commit.message}\n${commit.author} · ${new Date(commit.timestamp * 1000).toLocaleString()}\n${commit.hash}`}
                    onClick={() => onSelect({ repo, commit })}
                  >
                    <svg width={width} height="48" aria-hidden="true">
                      {row.before.map((hash, lane) => (
                        <path
                          key={hash}
                          stroke={colors[lane % colors.length]}
                          fill="none"
                          d={
                            hash === commit.hash
                              ? `M ${x(lane)} 0 V 18`
                              : `M ${x(lane)} 0 L ${x(row.after.indexOf(hash))} 48`
                          }
                        />
                      ))}
                      {row.parents.map((hash) => (
                        <path
                          key={hash}
                          fill="none"
                          stroke={colors[row.lane % colors.length]}
                          d={`M ${x(row.lane)} 18 L ${x(row.after.indexOf(hash))} 48`}
                        />
                      ))}
                      <circle
                        cx={x(row.lane)}
                        cy="18"
                        r={commit.hash === page.head ? 5 : 3.5}
                        fill={colors[row.lane % colors.length]}
                      />
                    </svg>
                    <span className="commit-text">
                      <span className="commit-subject">{commit.message.split('\n')[0]}</span>
                      <span className="commit-meta">
                        {commit.hash === page.head && <b>HEAD </b>}
                        {commit.refs && <b>{commit.refs} </b>}
                        {commit.hash.slice(0, 7)} · {commit.author} · {ago(commit.timestamp * 1000)}
                      </span>
                    </span>
                  </button>
                  {selected?.repo === repo && selected.commit.hash === commit.hash && (
                    <CommitFiles selection={selected} worktree={worktree} onSelect={onSelect} />
                  )}
                </Fragment>
              )
            })
          )}
          {page?.more && (
            <button disabled={limit >= 5000} onClick={() => setLimit((n) => n + 50)}>
              Load more
            </button>
          )}
        </>
      )}
    </section>
  )
}

function CommitFiles({
  selection,
  worktree,
  onSelect,
}: {
  selection: HistorySelection
  worktree?: string
  onSelect: (value: HistorySelection) => void
}) {
  const [files, setFiles] = useState<ChangedFile[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void historyRequest<ChangedFile[]>(worktree, selection.repo, undefined, selection.commit.hash)
      .then((result) => {
        if (alive) setFiles(result)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [worktree, selection.repo, selection.commit.hash])
  return (
    <div className="commit-files">
      {error ? (
        <div className="hint">{error}</div>
      ) : !files ? (
        <div className="hint">Loading files…</div>
      ) : !files.length ? (
        <div className="hint">No changed files.</div>
      ) : (
        files.map((file, index) => (
          <button
            key={file.path}
            className={
              selection.path === file.path || (!selection.path && index === 0) ? 'active' : ''
            }
            title={file.oldPath ? file.oldPath + ' → ' + file.path : file.path}
            onClick={() => onSelect({ ...selection, path: file.path })}
          >
            <span>{file.kind}</span> {file.path}
          </button>
        ))
      )}
    </div>
  )
}

export default function CommitHistory(props: Parameters<typeof HistoryBrowser>[0]) {
  const project = useStore((s) => s.project?.id)
  const paths = useStore((s) => s.nodes.map((n) => n.data.path).join('\0'))
  return <HistoryBrowser key={JSON.stringify([project, paths, props.worktree])} {...props} />
}
