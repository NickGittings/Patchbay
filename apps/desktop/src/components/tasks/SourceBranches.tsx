import { useCallback, useEffect, useState } from 'react'
import { gitBranches, gitWorktrees, type BranchAction } from '../../lib/ipc'
import { changeBranch } from '../../lib/branches'
import { refreshMainWorktree, useMainWorktree } from '../../lib/mainWorktree'
import { requestGitRefresh } from '../../lib/git'
import { refreshTasks } from '../../lib/tasks'
import type { Worktree } from '../../types'

/** Local branches of the original project folder, independent of the active task. */
export default function SourceBranches({ projectId }: { projectId: string }) {
  const revision = useMainWorktree((s) => s[projectId]?.branch)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [trees, setTrees] = useState<Worktree[]>([])
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = trees.find((t) => t.current)
  const occupied = (branch: string) => trees.find((t) => t.branch === branch)
  const load = useCallback(async () => {
    const [nextBranches, nextTrees] = await Promise.all([
      gitBranches(projectId),
      gitWorktrees(projectId),
    ])
    setBranches(nextBranches)
    setTrees(nextTrees)
    setTarget('')
    setDeleting('')
    setConfirm(false)
  }, [projectId])
  useEffect(() => {
    if (!open) return
    let disposed = false
    void Promise.all([gitBranches(projectId), gitWorktrees(projectId)])
      .then(([nextBranches, nextTrees]) => {
        if (disposed) return
        setBranches(nextBranches)
        setTrees(nextTrees)
        setTarget('')
        setDeleting('')
        setConfirm(false)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
    return () => {
      disposed = true
    }
  }, [open, revision, projectId])
  const run = async (action: BranchAction) => {
    if (!current) return
    setBusy(true)
    setError('')
    try {
      if (await changeBranch(projectId, current, action)) setName('')
    } catch (e) {
      setError(String(e))
    } finally {
      await load().catch((e) => setError(String(e)))
      refreshMainWorktree(projectId)
      await Promise.all([refreshTasks(projectId), requestGitRefresh(projectId)])
      setBusy(false)
    }
  }
  return (
    <div className="worktree-detail-panel source-branches">
      <button
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setError('')
          if (!open) setBusy(true)
          setOpen(!open)
        }}
      >
        Branches
      </button>
      {open && (
        <div role="region" aria-label="Source branches">
          <p>
            Source branch: <code>{current?.branch ?? 'detached'}</code>
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void run({ kind: 'switch', branch: target })
            }}
          >
            <label>
              Switch source branch
              <select
                aria-label="Switch source branch"
                value={target}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose a local branch…</option>
                {branches.map((branch) => {
                  const tree = occupied(branch)
                  return (
                    <option key={branch} value={branch} disabled={!!tree}>
                      {branch}
                      {tree ? ` — checked out at ${tree.path}` : ''}
                    </option>
                  )
                })}
              </select>
            </label>
            <button disabled={busy || !current || !target}>Switch branch</button>
          </form>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void run({ kind: 'rename', branch: name.trim() })
            }}
          >
            <label>
              Rename source branch
              <input
                aria-label="New source branch name"
                value={name}
                disabled={busy || !current?.branch}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button disabled={busy || !current?.branch || !name.trim()}>Rename branch</button>
          </form>
          <label>
            Delete local branch
            <select
              aria-label="Delete local branch"
              value={deleting}
              disabled={busy}
              onChange={(e) => {
                setDeleting(e.target.value)
                setConfirm(false)
              }}
            >
              <option value="">Choose an unused branch…</option>
              {branches.map((branch) => (
                <option key={branch} value={branch} disabled={!!occupied(branch)}>
                  {branch}
                  {occupied(branch) ? ' — checked out' : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            className="danger"
            disabled={busy || !deleting || !current}
            onClick={() => setConfirm(true)}
          >
            Delete branch
          </button>
          {confirm && (
            <div className="worktree-confirm">
              <p>
                Delete local branch <code>{deleting}</code>? It must be merged into the current
                source branch. Remote branches are kept.
              </p>
              <button
                className="danger"
                disabled={busy}
                onClick={() => void run({ kind: 'delete', branch: deleting })}
              >
                Confirm delete branch
              </button>
              <button disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          )}
          <p className="hint">
            Switching requires a clean source checkout. If terminals or agents are running, you’ll
            be asked to stop them. Branches checked out in another worktree must be released there
            first.
          </p>
          {error && (
            <p role="alert" className="file-tree-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
