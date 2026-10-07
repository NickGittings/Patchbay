import { useEffect, useRef, useState, type RefObject } from 'react'
import { attentionCounts, revealTerminal } from '../../lib/attention'
import { useClockTick } from '../../lib/clock'
import { KIND_COLOR } from '../../lib/display'
import { gitReview, taskUpdate } from '../../lib/ipc'
import { ago } from '../../lib/review'
import { refreshTasks, removeTask } from '../../lib/tasks'
import { useStore } from '../../store'
import { PROJECT_SCOPE, sessionId, type Review, type Task } from '../../types'
import EmptyState from '../EmptyState'

/**
 * Every task with its branch, worktree, the components it is about and those its changes touch
 * or may affect, and its terminals: one place to organize parallel work.
 */
export default function TasksView() {
  const tasks = useStore((s) => s.tasks)
  const setNewTask = useStore((s) => s.setNewTask)
  const counts = JSON.parse(useStore(attentionCounts)) as Record<string, number>
  const [reload, setReload] = useState(0)
  useEffect(() => void refreshTasks(), [])

  return (
    <div className="workspace tasks-view">
      <div className="tasks-header">
        <span className="review-title">Tasks</span>
        <span className="hint flush">
          Each task has its own branch and worktree; terminals started while it is active run there.
        </span>
        <span className="spacer" />
        <button
          onClick={() => {
            setReload((n) => n + 1)
            void refreshTasks()
          }}
          title="Reload tasks"
        >
          ↻
        </button>
        <button className="primary" onClick={() => setNewTask([])}>
          + New task
        </button>
      </div>
      <div className="tasks-list">
        <TaskCard task={null} attention={counts[''] ?? 0} reload={reload} />
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} attention={counts[t.id] ?? 0} reload={reload} />
        ))}
        {!tasks.length && (
          <EmptyState
            compact
            icon="⑂"
            title="No tasks yet"
            actions={
              <button className="primary" onClick={() => setNewTask([])}>
                + New task
              </button>
            }
          >
            Work on a branch in its own worktree, with the same map and terminals.
          </EmptyState>
        )}
      </div>
    </div>
  )
}

/** Save notes still waiting in `pending`, once. */
function saveNotes(pending: RefObject<{ id: string; notes: string } | null>) {
  const edit = pending.current
  if (!edit) return
  pending.current = null
  void taskUpdate(edit.id, { notes: edit.notes })
    .then(() => refreshTasks())
    .catch((e) => useStore.getState().setMessage(String(e)))
}

function TaskCard({
  task,
  attention,
  reload,
}: {
  task: Task | null
  attention: number
  reload: number
}) {
  const id = task?.id ?? null
  const nodes = useStore((s) => s.nodes)
  const sessions = useStore((s) => s.sessions)
  const activeTask = useStore((s) => s.activeTask)
  const revision = useStore((s) => s.gitChanges)
  const pathsKey = useStore((s) => s.nodes.map((n) => `${n.id}\0${n.data.path}`).join('\n'))
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState(task?.notes ?? '')
  // Saved shortly after typing stops, and when the card goes away, since a blur isn't reliable.
  const pendingNotes = useRef<{ id: string; notes: string } | null>(null)
  const taskId = task?.id
  const savedNotes = task?.notes
  useEffect(() => {
    if (!taskId || notes === savedNotes) {
      pendingNotes.current = null
      return
    }
    pendingNotes.current = { id: taskId, notes }
    const timer = setTimeout(() => saveNotes(pendingNotes), 600)
    return () => clearTimeout(timer)
  }, [taskId, notes, savedNotes])
  useEffect(() => () => saveNotes(pendingNotes), [])
  const [confirming, setConfirming] = useState(false)
  useClockTick()
  const active = activeTask === id
  const worktree = task && !task.current ? task.worktree : undefined
  // Git refreshes follow the watched worktrees (the open one and the active task's); other
  // tasks reload on mount and on ↻.
  const watched = active || !worktree
  const changes = watched ? revision : null

  useEffect(() => {
    if (task?.missing) return
    let disposed = false
    void gitReview(useStore.getState().toProject(), worktree)
      .then((r) => {
        if (!disposed) {
          setReview(r)
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [worktree, task?.missing, changes, pathsKey, reload])

  const nameOf = (cid: string) => nodes.find((n) => n.id === cid)?.data.name ?? cid
  const changed = Object.entries(review?.changes ?? {})
    .filter(([cid, files]) => files.length && cid !== PROJECT_SCOPE)
    .map(([cid, files]) => ({ id: cid, files: files.length }))
  const projectFiles = review?.changes[PROJECT_SCOPE]?.length ?? 0
  const running = nodes.flatMap((n) =>
    n.data.terminals
      .map((t) => ({ n, t, sid: sessionId(n.id, t.id, id) }))
      .filter(({ sid }) => sessions[sid]?.running),
  )

  const chip = (cid: string, extra?: string) => {
    const node = nodes.find((n) => n.id === cid)
    if (!node) return null
    return (
      <button
        key={cid}
        className="chip"
        title="Show in Implementation"
        onClick={() => {
          const s = useStore.getState()
          s.setActiveTask(id)
          s.select(cid)
          s.setView('implementation')
        }}
      >
        <span className="kind-dot" style={{ background: KIND_COLOR[node.data.kind] }} />
        {node.data.name}
        {extra && <span className="filter-count">{extra}</span>}
      </button>
    )
  }

  const toggleComponent = (cid: string) => {
    if (!task) return
    // From the latest copy, updated at once, so quick toggles don't overwrite each other.
    const s = useStore.getState()
    const current = s.tasks.find((t) => t.id === task.id)?.components ?? task.components
    const components = current.includes(cid) ? current.filter((c) => c !== cid) : [...current, cid]
    s.setTasks(s.tasks.map((t) => (t.id === task.id ? { ...t, components } : t)))
    void taskUpdate(task.id, { components }).catch((e) => useStore.getState().setMessage(String(e)))
  }

  return (
    <section className={`task-card ${active ? 'active' : ''} ${task?.missing ? 'missing' : ''}`}>
      <header className="task-card-header">
        <strong>{task ? task.title : 'Open worktree'}</strong>
        {task?.branch && <code>{task.branch}</code>}
        {task?.current && <span className="task-tag">open here</span>}
        {task?.missing && <span className="task-tag bad">worktree missing</span>}
        {attention > 0 && (
          <span className="task-tag attention" title="Terminals that need you">
            ● {attention}
          </span>
        )}
        <span className="spacer" />
        {task && <small className="muted">{ago(task.createdMs)}</small>}
        <button
          disabled={active || !!task?.missing}
          onClick={() => useStore.getState().setActiveTask(id)}
        >
          {active ? 'Active' : 'Switch to'}
        </button>
        <button
          disabled={!!task?.missing}
          onClick={() => {
            const s = useStore.getState()
            s.setActiveTask(id)
            s.setView('review')
          }}
        >
          Review
        </button>
        {task && !confirming && (
          <button className="danger" onClick={() => setConfirming(true)}>
            Remove…
          </button>
        )}
      </header>
      {task && (
        <div className="task-path mono" title={task.worktree}>
          {task.worktree}
        </div>
      )}
      {task && confirming && (
        <div className="task-confirm row">
          <span className="grow">
            Remove the worktree too? git refuses if it has uncommitted changes. The branch{' '}
            {task.branch ? <code>{task.branch}</code> : null} is kept.
          </span>
          <button
            className="danger"
            disabled={task.current}
            onClick={() =>
              void removeTask(task.id, true).catch((e) => useStore.getState().setMessage(String(e)))
            }
          >
            Remove worktree
          </button>
          <button
            onClick={() =>
              void removeTask(task.id, false).catch((e) =>
                useStore.getState().setMessage(String(e)),
              )
            }
          >
            Forget task only
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {task && (
        <div className="task-row">
          <span className="section-title">About</span>
          <div className="scope-chips">
            {nodes.map((n) => (
              <button
                key={n.id}
                className={`chip ${task.components.includes(n.id) ? 'active' : 'off'}`}
                aria-pressed={task.components.includes(n.id)}
                title={task.components.includes(n.id) ? 'Remove from task' : 'Add to task'}
                onClick={() => toggleComponent(n.id)}
              >
                <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
                {n.data.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="task-row">
        <span className="section-title">Changed</span>
        <div className="scope-chips">
          {error ? (
            <span className="hint flush file-tree-error">{error}</span>
          ) : !review ? (
            <span className="hint flush">{task?.missing ? '—' : 'Loading…'}</span>
          ) : changed.length || projectFiles ? (
            <>
              {changed.map((c) => chip(c.id, `±${c.files}`))}
              {projectFiles > 0 && <span className="chip">Project files ±{projectFiles}</span>}
            </>
          ) : (
            <span className="hint flush">No uncommitted changes</span>
          )}
        </div>
      </div>
      {review && review.affected.length > 0 && (
        <div className="task-row">
          <span className="section-title">May affect</span>
          <div className="scope-chips">
            {review.affected.map((a) => chip(a.id, `via ${a.via.map(nameOf).join(', ')}`))}
          </div>
        </div>
      )}
      <div className="task-row">
        <span className="section-title">Running</span>
        <div className="scope-chips">
          {running.length ? (
            running.map(({ n, t, sid }) => (
              <button
                key={sid}
                className="chip"
                onClick={() => revealTerminal({ sid, componentId: n.id })}
              >
                {n.data.name} · {t.name}
              </button>
            ))
          ) : (
            <span className="hint flush">No terminals running</span>
          )}
        </div>
      </div>
      {task && (
        <textarea
          className="task-notes"
          rows={2}
          placeholder="Notes for this task (shared with its agents)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      )}
    </section>
  )
}
