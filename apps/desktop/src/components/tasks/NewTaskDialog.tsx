import { useEffect, useState } from 'react'
import { KIND_COLOR } from '../../lib/display'
import { gitWorktrees } from '../../lib/ipc'
import { attachTask, branchFor, cancelNewTask, createTask } from '../../lib/tasks'
import { useStore } from '../../store'
import type { Worktree } from '../../types'

export default function NewTaskDialog() {
  const seed = useStore((s) => s.newTask)
  return seed ? <Dialog seed={seed} /> : null
}
function Dialog({ seed }: { seed: { components: string[]; title?: string } }) {
  const nodes = useStore((s) => s.nodes)
  const tasks = useStore((s) => s.tasks)
  const projectId = useStore((s) => s.project?.id)
  const close = cancelNewTask
  const [mode, setMode] = useState<'new' | 'attach'>('new')
  const [title, setTitle] = useState(seed.title ?? '')
  const [branch, setBranch] = useState(() => branchFor(seed.title ?? ''))
  const [branchEdited, setBranchEdited] = useState(false)
  const [base, setBase] = useState('')
  const [components, setComponents] = useState(seed.components)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktree, setWorktree] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    void gitWorktrees()
      .then((list) => {
        if (!disposed) setWorktrees(list)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [projectId])
  const current = worktrees.find((w) => w.current)
  const others = worktrees.filter((w) => !w.current)
  const chosen = mode === 'attach' ? worktree : undefined
  const assigned = tasks.find((t) => t.worktree === chosen)
  const ready = !!title.trim() && (mode === 'new' ? !!branch.trim() && !!current : !!chosen)
  const submit = async () => {
    if (!ready || useStore.getState().project?.id !== projectId) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'new') await createTask({ title, branch, base: base || undefined, components })
      else await attachTask(chosen!, components, title)
      if (useStore.getState().project?.id === projectId) close()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="extension-overlay"
      onClick={() => {
        if (!busy) close()
      }}
    >
      <form
        className="extensions-panel panel task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) void submit()
        }}
      >
        <div className="row">
          <h2>New task</h2>
          <span className="spacer" />
        </div>
        <label>
          Goal title
          <input
            autoFocus
            value={title}
            placeholder="Fix login"
            onChange={(e) => {
              setTitle(e.target.value)
              if (!branchEdited) setBranch(branchFor(e.target.value))
            }}
          />
        </label>
        <div className="view-switcher" role="group" aria-label="Task checkout">
          <button
            type="button"
            className={mode === 'new' ? 'active' : ''}
            onClick={() => setMode('new')}
          >
            New worktree
          </button>
          <button
            type="button"
            className={mode === 'attach' ? 'active' : ''}
            disabled={!others.length}
            onClick={() => {
              setMode('attach')
              setWorktree(worktree || others[0]?.path || '')
            }}
          >
            Existing worktree
          </button>
        </div>
        {mode === 'new' ? (
          <>
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
                <input
                  value={base}
                  placeholder={current?.branch ?? 'HEAD'}
                  onChange={(e) => setBase(e.target.value)}
                />
              </label>
            </div>
            <p className="hint flush">
              Creates the checkout before planning. Start the stopped root shell to set up this
              worktree.
            </p>
          </>
        ) : (
          <label>
            Worktree
            <select value={worktree} onChange={(e) => setWorktree(e.target.value)}>
              {others.map((w) => (
                <option key={w.path} value={w.path}>
                  {tasks.find((t) => t.worktree === w.path)?.title ?? w.branch ?? 'Detached'} ·{' '}
                  {w.path}
                </option>
              ))}
            </select>
          </label>
        )}
        {assigned && (
          <p className="hint flush">
            This checkout belongs to “{assigned.title}”. Creating activates that task.
          </p>
        )}
        <div className="section-title">Components in scope (optional)</div>
        <p className="hint flush">
          Leave empty to let the planner decide; the whole map stays in scope.
        </p>
        <div className="scope-chips">
          {nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`chip ${components.includes(n.id) ? 'active' : ''}`}
              aria-pressed={components.includes(n.id)}
              onClick={() =>
                setComponents(
                  components.includes(n.id)
                    ? components.filter((id) => id !== n.id)
                    : [...components, n.id],
                )
              }
            >
              <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
              {n.data.name}
            </button>
          ))}
        </div>
        {error && <div className="hint file-tree-error">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy ? 'Creating…' : assigned ? 'Activate task' : 'Create task'}
          </button>
        </div>
      </form>
    </div>
  )
}
