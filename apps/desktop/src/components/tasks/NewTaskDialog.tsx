import { useEffect, useState } from 'react'
import { KIND_COLOR } from '../../lib/display'
import { gitWorktrees } from '../../lib/ipc'
import { attachTask, branchFor, createTask } from '../../lib/tasks'
import { useStore } from '../../store'
import type { Worktree } from '../../types'

/**
 * Start a task: a new branch in a worktree beside the repo (or an existing worktree), connected
 * to the components it is about. Open while the store's `newTask` holds the seed components.
 */
export default function NewTaskDialog() {
  const seed = useStore((s) => s.newTask)
  if (!seed) return null
  return <Dialog seed={seed} />
}

function Dialog({ seed }: { seed: string[] }) {
  const nodes = useStore((s) => s.nodes)
  const tasks = useStore((s) => s.tasks)
  const close = () => useStore.getState().setNewTask(null)
  const [mode, setMode] = useState<'new' | 'attach'>('new')
  const [title, setTitle] = useState('')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [base, setBase] = useState('')
  // Shown as the placeholder: an empty base branches from the open HEAD, and keeps an existing
  // branch as it is.
  const [head, setHead] = useState('HEAD')
  const [components, setComponents] = useState(seed)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktree, setWorktree] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void gitWorktrees()
      .then((list) => {
        if (disposed) return
        setWorktrees(list)
        const current = list.find((w) => w.current)
        if (current?.branch) setHead(current.branch)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [])

  const free = worktrees.filter((w) => !w.current && !tasks.some((t) => t.worktree === w.path))
  const toggle = (id: string) =>
    setComponents(
      components.includes(id) ? components.filter((c) => c !== id) : [...components, id],
    )

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      if (mode === 'new') await createTask({ title, branch, base: base || undefined, components })
      else await attachTask(worktree, components)
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const ready = mode === 'new' ? title.trim() && branch.trim() : worktree

  return (
    <div className="extension-overlay" onClick={close}>
      <form
        className="extensions-panel panel task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && !busy) void submit()
        }}
      >
        <div className="row">
          <h2>New task</h2>
          <span className="spacer" />
          <div className="view-switcher" role="group" aria-label="Worktree">
            <button
              type="button"
              className={mode === 'new' ? 'active' : ''}
              aria-pressed={mode === 'new'}
              onClick={() => setMode('new')}
            >
              New branch
            </button>
            <button
              type="button"
              className={mode === 'attach' ? 'active' : ''}
              aria-pressed={mode === 'attach'}
              disabled={!free.length}
              title={free.length ? '' : 'Every other worktree already has a task'}
              onClick={() => {
                setMode('attach')
                setWorktree(worktree || free[0]?.path || '')
              }}
            >
              Existing worktree
            </button>
          </div>
        </div>
        {mode === 'new' ? (
          <>
            <label>
              Title
              <input
                autoFocus
                value={title}
                placeholder="Fix checkout totals"
                onChange={(e) => {
                  setTitle(e.target.value)
                  if (!branchEdited) setBranch(branchFor(e.target.value))
                }}
              />
            </label>
            <div className="row">
              <label className="grow">
                Branch
                <input
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value)
                    setBranchEdited(true)
                  }}
                />
              </label>
              <label className="grow">
                From
                <input value={base} placeholder={head} onChange={(e) => setBase(e.target.value)} />
              </label>
            </div>
            <div className="hint flush">
              The worktree is created beside the repo. An existing branch is checked out as is.
            </div>
          </>
        ) : (
          <label>
            Worktree
            <select autoFocus value={worktree} onChange={(e) => setWorktree(e.target.value)}>
              {free.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch ?? `detached ${w.head.slice(0, 7)}`} · {w.path}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="section-title">Components</div>
        <div className="scope-chips">
          {nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`chip ${components.includes(n.id) ? 'active' : ''}`}
              aria-pressed={components.includes(n.id)}
              onClick={() => toggle(n.id)}
            >
              <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
              {n.data.name}
            </button>
          ))}
        </div>
        {error && <div className="hint file-tree-error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy ? 'Creating…' : mode === 'new' ? 'Create task' : 'Attach task'}
          </button>
        </div>
      </form>
    </div>
  )
}
