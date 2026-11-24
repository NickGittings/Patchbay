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
  retryRepos,
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
  const reposError = useSyncScope((s) => s.reposError)
  const worktree = useStore(activeWorktree)
  const selected = useChosenCommit()?.selection ?? null
  const { status, busy } = entry
  const error = entry.error ?? entry.statusError
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
      void runSync(scope, 'fetch', { quiet: true })
  })
  useEffect(() => {
    if (loaded) fetchIfStale()
  }, [key, loaded])

  if (!scope) {
    if (reposError)
      return (
        <div className="hint git-sync-error" role="alert">
          {reposError} <button onClick={retryRepos}>Retry</button>
        </div>
      )
    if (repos && !repos.length) return <p className="panel-empty">No Git repository.</p>
    return <PanelStatus compact kind="loading" message="Loading repository…" />
  }
  const run = (action: SyncAction) => void runSync(scope, action)
  const upstream = status?.upstream
  const branch = status?.branch
  const missing = status?.missingUpstream
  const pushTo = status?.pushTo
  const publish = !!pushTo && status?.unpushed === null
  const diverged = !!status && status.ahead > 0 && status.behind > 0
  return (
    <div className="git-panel">
      <section className="git-sync" aria-label="Sync with remote">
        {(repos?.length ?? 0) > 1 && (
          <select
            aria-label="Repository"
            value={scope.repo}
            onChange={(e) => {
              chooseRepo(e.target.value)
              setChosenCommit(null)
            }}
          >
            {repos?.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        <div className="git-sync-branch">
          <RailIcon name="branch" size={16} />
          <strong title={branch ?? 'Detached HEAD'}>{branch ?? 'Detached HEAD'}</strong>
          {status && (
            <span className="git-sync-upstream" title={upstream ?? missing ?? undefined}>
              {upstream
                ? `→ ${upstream}`
                : missing
                  ? `${missing} is gone`
                  : status.remote
                    ? 'Not published'
                    : 'No remote'}
            </span>
          )}
        </div>
        {status ? (
          <div className="git-sync-counts" data-diverged={diverged || undefined}>
            <span
              aria-label={`${status.ahead} ahead of the upstream`}
              title={upstream ? `Commits ${upstream} doesn't have` : 'No upstream'}
            >
              ↑ {status.ahead}
            </span>
            <span aria-label={`${status.behind} to pull`} title="Commits to pull">
              ↓ {status.behind}
            </span>
            {pushTo && pushTo !== upstream && status.unpushed !== null && (
              <span title={`Commits ${pushTo} doesn't have`}>
                {status.unpushed} to {pushTo}
              </span>
            )}
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
            disabled={!!busy || !pushTo || !!status?.pushBehind || (!publish && !status?.unpushed)}
            title={
              !status
                ? undefined
                : (status.pushRefused ??
                  (status.pushBehind
                    ? `${pushTo} has commits this branch doesn't; pull first`
                    : publish
                      ? `Publish ${branch} to ${pushTo}`
                      : `Push to ${pushTo}`))
            }
            onClick={() => run('push')}
          >
            {busy === 'push' ? BUSY.push : publish && !upstream ? 'Publish branch' : 'Push'}
          </button>
        </div>
        {error && !busy && (
          <div className="hint git-sync-error" role="alert">
            {error}
          </div>
        )}
      </section>
      <CommitHistory
        key={scope.repo}
        worktree={worktree}
        selected={selected}
        initialRepo={scope.repo}
        repoPicker={false}
        // A null selection only resets the list on mount; it keeps the commit Review shows.
        onSelect={(value) => {
          if (value) showCommit(value)
        }}
      />
    </div>
  )
}
