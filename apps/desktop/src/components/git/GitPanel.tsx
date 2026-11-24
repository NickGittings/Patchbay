import { useEffect, useEffectEvent, useRef } from 'react'
import { useStore } from '../../store'
import type { SyncAction } from '../../types'
import { ago } from '../../lib/review'
import {
  AUTO_FETCH_MS,
  chooseRepo,
  runSync,
  setChosenCommit,
  showCommit,
  syncKey,
  useChosenCommit,
  useSyncEntry,
  useSyncScope,
} from '../../lib/gitSync'
import { activeWorktree } from '../../lib/tasks'
import CommitHistory from '../changes/CommitHistory'
import PanelStatus from '../PanelStatus'
import RailIcon from '../RailIcon'
import './git.css'

const BUSY: Record<SyncAction, string> = {
  fetch: 'Fetching…',
  pull: 'Pulling…',
  push: 'Pushing…',
}

/**
 * The active worktree's branch compared with its upstream, with fetch, fast-forward pull, and
 * push, above the repository's recent commits. A chosen commit opens in Review or Chat's Changes.
 */
export default function GitPanel() {
  const { scope, entry } = useSyncEntry()
  const repos = useSyncScope((s) => s.repos)
  const worktree = useStore(activeWorktree)
  const task = useStore((s) => s.activeTask)
  const selected = useChosenCommit()
  const { status, busy, error } = entry
  // Opening the panel fetches once when the last fetch is stale, so the counts mean something.
  const fetched = useRef<string | null>(null)
  const key = scope ? syncKey(scope) : null
  const loaded = !!status
  // Only a new scope or its first status decides this; later status updates do not refetch.
  const fetchIfStale = useEffectEvent(() => {
    if (!scope || !key || !status || fetched.current === key) return
    fetched.current = key
    const last = status.lastFetchMs
    if (status.remote && (!last || Date.now() - last > AUTO_FETCH_MS))
      void runSync(scope, 'fetch', { quiet: true, task })
  })
  useEffect(() => {
    if (loaded) fetchIfStale()
  }, [key, loaded])

  if (!scope) {
    if (repos && !repos.length) return <p className="panel-empty">No Git repository.</p>
    return <PanelStatus compact kind="loading" message="Loading repository…" />
  }
  const run = (action: SyncAction) => void runSync(scope, action, { task })
  const upstream = status?.upstream
  const branch = status?.branch
  const diverged = !!status && status.ahead > 0 && status.behind > 0
  return (
    <div className="git-panel">
      <section className="git-sync" aria-label="Sync with remote">
        <div className="git-sync-branch">
          <RailIcon name="branch" size={16} />
          <strong title={branch ?? 'Detached HEAD'}>{branch ?? 'Detached HEAD'}</strong>
          {status && (
            <span className="git-sync-upstream" title={upstream ?? undefined}>
              {upstream ? `→ ${upstream}` : status.remote ? 'Not published' : 'No remote'}
            </span>
          )}
        </div>
        {status ? (
          <div className="git-sync-counts" data-diverged={diverged || undefined}>
            <span aria-label={`${status.ahead} to push`} title="Commits to push">
              ↑ {status.ahead}
            </span>
            <span aria-label={`${status.behind} to pull`} title="Commits to pull">
              ↓ {status.behind}
            </span>
            <small>
              {busy === 'fetch'
                ? 'Fetching…'
                : status.lastFetchMs
                  ? `Fetched ${ago(status.lastFetchMs)}`
                  : 'Never fetched'}
            </small>
          </div>
        ) : (
          <PanelStatus compact kind="loading" message="Reading branch…" />
        )}
        {diverged && (
          <p className="hint">
            Diverged from {upstream}. Pull only fast-forwards; merge or rebase in a terminal.
          </p>
        )}
        <div className="git-sync-actions">
          <button
            disabled={!!busy || !status?.remote}
            title={status?.remote ? `Fetch from ${status.remote}` : 'No remote is configured'}
            onClick={() => run('fetch')}
          >
            {busy === 'fetch' ? BUSY.fetch : 'Fetch'}
          </button>
          <button
            disabled={!!busy || !upstream || !status?.behind || diverged}
            title={
              !upstream
                ? 'The branch has no upstream to pull from'
                : diverged
                  ? 'The branch has diverged; pull only fast-forwards'
                  : `Fast-forward to ${upstream}`
            }
            onClick={() => run('pull')}
          >
            {busy === 'pull' ? BUSY.pull : 'Pull'}
          </button>
          <button
            className="primary"
            disabled={
              !!busy || !branch || !status?.remote || (!!upstream && !status?.ahead) || diverged
            }
            title={
              !branch
                ? 'Check out a branch to push'
                : !status?.remote
                  ? 'No remote is configured'
                  : upstream
                    ? `Push to ${upstream}`
                    : `Publish ${branch} to ${status.remote}`
            }
            onClick={() => run('push')}
          >
            {busy === 'push' ? BUSY.push : upstream || !status?.remote ? 'Push' : 'Publish branch'}
          </button>
        </div>
        {error && !busy && (
          <div className="hint git-sync-error" role="alert">
            {error}
          </div>
        )}
      </section>
      <CommitHistory
        worktree={worktree}
        selected={selected}
        initialRepo={scope.repo}
        onRepo={(repo) => {
          chooseRepo(repo)
          setChosenCommit(null)
        }}
        // A null selection only resets the list on mount; it keeps the commit Review shows.
        onSelect={(value) => {
          if (value) showCommit(value)
        }}
      />
    </div>
  )
}
