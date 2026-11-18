import { useEffect, useState } from 'react'
import Menu, { MenuItem } from '../Menu'
import RailIcon from '../RailIcon'
import { gitBranches, gitWorktrees } from '../../lib/ipc'
import { changeBranch } from '../../lib/branches'
import { readMainWorktrees, refreshMainWorktree } from '../../lib/mainWorktree'
import { refreshTasks } from '../../lib/tasks'
import { requestGitRefresh } from '../../lib/git'
import { useStore } from '../../store'
import type { Worktree } from '../../types'
import PanelStatus from '../PanelStatus'

export default function FooterBranchPicker({
  projectId,
  branch,
  worktree,
}: {
  projectId: string
  branch?: string
  worktree?: string
}) {
  const [busy, setBusy] = useState(false)
  const switchBranch = async (current: Worktree, next: string) => {
    setBusy(true)
    try {
      await changeBranch(projectId, current, { kind: 'switch', branch: next })
    } catch (e) {
      useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    } finally {
      refreshMainWorktree(projectId)
      await Promise.all([refreshTasks(projectId), requestGitRefresh(projectId)])
      setBusy(false)
    }
  }
  return (
    <Menu
      label={
        <span className="workspace-context-branch" title={`Branch: ${branch ?? 'detached'}`}>
          <RailIcon name="branch" />
          <span>{busy ? 'Switching…' : (branch ?? 'detached')}</span>
        </span>
      }
      triggerLabel="Switch branch"
      title="Switch branch in the selected worktree"
      className="footer-branch-picker"
      portal
    >
      <BranchChoices
        projectId={projectId}
        worktree={worktree}
        busy={busy}
        onSwitch={(current, next) => void switchBranch(current, next)}
      />
    </Menu>
  )
}

function BranchChoices({
  projectId,
  worktree,
  busy,
  onSwitch,
}: {
  projectId: string
  worktree?: string
  busy: boolean
  onSwitch: (current: Worktree, next: string) => void
}) {
  const [data, setData] = useState<{ branches: string[]; trees: Worktree[] }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    // Share the worktree read, so the footer label always matches the checked branch.
    void Promise.all([
      gitBranches(projectId),
      readMainWorktrees(projectId, gitWorktrees(projectId)),
    ])
      .then(([branches, trees]) => {
        if (!disposed) setData({ branches, trees })
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [projectId, worktree])
  if (error) return <p role="alert">{error}</p>
  if (!data) return <PanelStatus compact kind="loading" message="Loading branches…" />
  const current = data.trees.find((t) => (worktree ? t.path === worktree : t.current))
  if (!current) return <p>Selected worktree is no longer available.</p>
  return (
    <>
      {data.branches.map((branch) => {
        const occupied = data.trees.find((t) => t.branch === branch)
        return (
          <MenuItem
            key={branch}
            radio
            checked={current.branch === branch}
            disabled={busy || !!occupied}
            title={occupied ? `Checked out at ${occupied.path}` : `Switch to ${branch}`}
            onClick={() => onSwitch(current, branch)}
          >
            {branch}
            {occupied && occupied.path !== current.path ? ' (another worktree)' : ''}
          </MenuItem>
        )
      })}
      {!data.branches.length && <p>No local branches.</p>}
    </>
  )
}
