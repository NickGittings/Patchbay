import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { componentTerminals, revealTerminal, worktreeAttention } from '../../lib/attention'
import { KIND_COLOR } from '../../lib/display'
import { gitReview, taskUpdate } from '../../lib/ipc'
import { refreshMainWorktree, useMainWorktree } from '../../lib/mainWorktree'
import { useShallow } from 'zustand/react/shallow'
import { planTerminals } from '../../lib/plan'
import { refreshTasks, removeTask, seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import {
  TASK_ROOT_SCOPE,
  PLAN_SCOPE,
  PROJECT_SCOPE,
  plannerSessionId,
  sessionId,
  type Review,
  type Task,
} from '../../types'

import { CloseMenu } from '../menuContext'

/**
 * Pick the worktree where planning and implementation terminals run; with `copyPlan` (Plan's
 * Planner scope), a new one starts with a copy of the project plan.
 */
export default function WorktreePicker({ copyPlan = false }: { copyPlan?: boolean }) {
  const projectId = useStore((s) => s.project?.id)
  const counts = useStore(useShallow(worktreeAttention))
  const main = useMainWorktree((m) => m[projectId ?? ''])
  const refreshBranch = useCallback(() => refreshMainWorktree(projectId), [projectId])
  return (
    <WorktreeOverview
      branch={main?.branch ?? ''}
      onOpen={refreshBranch}
      counts={counts}
      git={!!main?.git}
      copyPlan={copyPlan}
    />
  )
}

function WorktreeOverview({
  branch,
  onOpen,
  counts,
  git,
  copyPlan,
}: {
  branch: string
  onOpen: () => void
  counts: Record<string, number>
  git: boolean
  copyPlan: boolean
}) {
  const tasks = useStore((s) => s.tasks)
  const close = useContext(CloseMenu)
  useEffect(() => {
    void refreshTasks()
    onOpen()
  }, [onOpen])
  return (
    <>
      <div className="worktree-list">
        {!tasks.some((t) => t.current && !t.missing) && (
          <WorktreeRow task={null} branch={branch} attention={counts[''] ?? 0} />
        )}
        {tasks.map((task) => (
          <WorktreeRow key={task.id} task={task} attention={counts[task.id] ?? 0} />
        ))}
      </div>
      <button
        className="worktree-new"
        disabled={!git}
        title={git ? undefined : 'Named tasks require a Git repository'}
        onClick={() => {
          close()
          seedNewTask(undefined, { copyPlan })
        }}
      >
        ＋ New task
      </button>
    </>
  )
}

/** Save notes still waiting in `pending`, once. */
function saveNotes(pending: RefObject<{ id: string; notes: string; projectId?: string } | null>) {
  const edit = pending.current
  if (!edit) return
  pending.current = null
  void taskUpdate(edit.id, { notes: edit.notes }, edit.projectId)
    .then(() => refreshTasks(edit.projectId))
    .catch((e) => useStore.getState().setMessage(String(e)))
}

const ROW_CONTROLS =
  'button, a, input, textarea, select, summary, form, details[open] > :not(summary), .chip, ' +
  '.worktree-path, .worktree-confirm, .file-tree-error'

/** One worktree's summary and its rename, notes and remove controls. */
function WorktreeRow({
  task,
  attention,
  branch,
}: {
  task: Task | null
  attention: number
  branch?: string
}) {
  const close = useContext(CloseMenu)
  const projectId = useStore((s) => s.project?.id)
  const [rename, setRename] = useState(false)
  const [title, setTitle] = useState(task?.title ?? '')
  const id = task?.id ?? null
  const switchTo = () => {
    if (task?.missing) return
    close()
    useStore.getState().setActiveTask(id)
  }
  const nodes = useStore((s) => s.nodes)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const devices = useStore((s) => s.devices)
  const activeTask = useStore((s) => s.activeTask)
  const rootTerminals = useStore((s) => s.rootTerminals)
  const taskWorkspaces = useStore((s) => s.taskWorkspaces)
  const roots = activeTask === id ? rootTerminals : (taskWorkspaces[id ?? '']?.rootTerminals ?? [])
  const revision = useStore((s) => s.gitChanges)
  const pathsKey = useStore((s) => s.nodes.map((n) => `${n.id}\0${n.data.path}`).join('\n'))
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState(task?.notes ?? '')
  // Saved shortly after typing stops, and when the card goes away, since a blur isn't reliable.
  const pendingNotes = useRef<{ id: string; notes: string; projectId?: string } | null>(null)
  const taskId = task?.id
  const savedNotes = task?.notes
  useEffect(() => {
    if (!taskId || notes === savedNotes) {
      pendingNotes.current = null
      return
    }
    pendingNotes.current = { id: taskId, notes, projectId }
    const timer = setTimeout(() => saveNotes(pendingNotes), 600)
    return () => clearTimeout(timer)
  }, [taskId, notes, savedNotes, projectId])
  useEffect(() => () => saveNotes(pendingNotes), [])
  const [confirming, setConfirming] = useState(false)
  const active = activeTask === id
  const worktree = task && !task.current ? task.worktree : undefined
  // Git refreshes follow the watched worktrees (the open one and the active task's); other
  // tasks reload on mount when the picker opens.
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
  }, [worktree, task?.missing, changes, pathsKey])

  const nameOf = (cid: string) => nodes.find((n) => n.id === cid)?.data.name ?? cid
  const changed = Object.entries(review?.changes ?? {})
    .filter(([cid, files]) => files.length && cid !== PROJECT_SCOPE)
    .map(([cid, files]) => ({ id: cid, files: files.length }))
  const projectFiles = review?.changes[PROJECT_SCOPE]?.length ?? 0
  const changedCount = new Set(
    Object.values(review?.changes ?? {}).flatMap((files) => files.map((f) => f.path)),
  ).size
  const running = [
    ...roots.map((t) => ({
      componentId: TASK_ROOT_SCOPE,
      name: 'Task root',
      t,
      sid: sessionId(TASK_ROOT_SCOPE, t.id, id),
    })),
    ...nodes.flatMap((n) =>
      componentTerminals(n.id, n.data.terminals, runtimeTerminals, id).map(([sid, t]) => ({
        componentId: n.id,
        name: n.data.name,
        t,
        sid,
      })),
    ),
    // The planner belongs to the project folder, whichever worktree is active.
    ...(id === null ? planTerminals(devices) : []).map((t) => ({
      componentId: PLAN_SCOPE,
      name: 'Planner',
      t,
      sid: plannerSessionId(t.id),
    })),
  ].filter(({ sid }) => sessions[sid]?.running)

  const chip = (cid: string, extra?: string) => {
    const node = nodes.find((n) => n.id === cid)
    if (!node) return null
    return (
      <button
        key={cid}
        className="chip"
        title="Show in Build"
        onClick={() => {
          const s = useStore.getState()
          close()
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

  return (
    // Another worktree's whole card switches, except its own controls, chips, the path and error
    // (kept for copying) and the remove confirmation; the title button stays the keyboard and
    // screen-reader way in, and its click is excluded here.
    <section
      className={`worktree-row ${active ? 'active' : ''} ${task?.missing ? 'missing' : ''}`}
      onClick={(e) => {
        if (active || (e.target as Element).closest(ROW_CONTROLS)) return
        if (window.getSelection()?.toString()) return
        switchTo()
      }}
    >
      <header className="worktree-row-header">
        <button
          className="worktree-row-switch"
          disabled={!!task?.missing}
          aria-pressed={active}
          onClick={switchTo}
        >
          <strong>{task ? task.title : 'Main worktree'}</strong>
          {(task?.branch ?? branch) && <code>{task?.branch ?? branch}</code>}
        </button>
        {task?.current && <span className="worktree-tag">main worktree</span>}
        {task?.missing && <span className="worktree-tag bad">worktree missing</span>}
        {attention > 0 && (
          <span
            className="worktree-tag attention"
            title="Terminals or finished actions that need you"
          >
            ● {attention}
          </span>
        )}
        {review && (
          <span className="worktree-tag" title="Uncommitted files">
            ±{changedCount}
          </span>
        )}
        <span className="worktree-tag">{running.length} running</span>
        <button
          disabled={!!task?.missing}
          onClick={() => {
            const s = useStore.getState()
            close()
            s.setActiveTask(id)
            s.setView('review')
          }}
        >
          Review
        </button>
        {task && <button onClick={() => setRename(!rename)}>Rename</button>}
        {task && !confirming && (
          <button className="danger" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </header>
      {task && rename && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void taskUpdate(task.id, { title }, projectId)
              .then(() => refreshTasks(projectId))
              .catch((e) => useStore.getState().setMessage(String(e)))
            setRename(false)
          }}
        >
          <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button disabled={!title.trim()}>Save name</button>
        </form>
      )}
      {task && (
        <div className="worktree-path mono" title={task.worktree}>
          {task.worktree}
        </div>
      )}
      {task && confirming && (
        <div className="worktree-confirm row">
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
            Forget only
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      <div className="worktree-detail">
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
        <div className="worktree-detail">
          <span className="section-title">May affect</span>
          <div className="scope-chips">
            {review.affected.map((a) => chip(a.id, `via ${a.via.map(nameOf).join(', ')}`))}
          </div>
        </div>
      )}
      <div className="worktree-detail">
        <span className="section-title">Running</span>
        <div className="scope-chips">
          {running.length ? (
            running.map(({ componentId, name, t, sid }) => (
              <button
                key={sid}
                className="chip"
                onClick={() => {
                  close()
                  revealTerminal({ sid, componentId })
                }}
              >
                {name}: {t.name}
              </button>
            ))
          ) : (
            <span className="hint flush">No terminals running</span>
          )}
        </div>
      </div>
      {task && (
        <details className="worktree-notes-detail">
          <summary>Notes{notes ? `: ${notes.split('\n')[0]}` : ''}</summary>
          <textarea
            aria-label={`Notes for ${task.title}`}
            className="worktree-notes"
            rows={2}
            placeholder="Notes for this worktree (shared with its agents)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </details>
      )}
    </section>
  )
}
