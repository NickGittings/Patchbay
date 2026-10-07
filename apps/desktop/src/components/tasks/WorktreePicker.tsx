import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import { attentionCounts, componentTerminals, revealTerminal } from '../../lib/attention'
import { KIND_COLOR } from '../../lib/display'
import { gitReview, gitWorktrees, taskUpdate } from '../../lib/ipc'
import { planTerminals } from '../../lib/plan'
import { refreshTasks, removeTask, seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import {
  TASK_ROOT_SCOPE,
  PLAN_SCOPE,
  PROJECT_SCOPE,
  sessionId,
  type Review,
  type Task,
} from '../../types'

import Popover from '../Popover'
import { CloseMenu } from '../menuContext'

/** Pick the worktree where planning and implementation terminals run. */
export default function WorktreePicker({ align = 'left' }: { align?: 'left' | 'right' }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === s.activeTask))
  const projectId = useStore((s) => s.project?.id)
  const [branch, setBranch] = useState('')
  const counts = JSON.parse(useStore(attentionCounts)) as Record<string, number>
  // The Project folder's branch, read when the project opens and whenever the picker opens
  // rather than on every Git refresh, since it only changes on a checkout.
  const latestRequest = useRef(0)
  const refreshBranch = useCallback(() => {
    const request = ++latestRequest.current
    void gitWorktrees()
      .then((list) => {
        const current = list.find((w) => w.current)
        if (request === latestRequest.current)
          setBranch(current?.branch ?? (current ? `detached ${current.head.slice(0, 7)}` : ''))
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshBranch()
    // Drops the answer for a project that is no longer open.
    const requests = latestRequest
    return () => {
      requests.current++
    }
  }, [projectId, refreshBranch])
  const label = task?.title ?? 'Project folder'
  const currentBranch = task ? task.branch : branch
  const attention = counts[task?.id ?? ''] ?? 0
  const elsewhere = Object.values(counts).reduce((sum, n) => sum + n, 0) - attention

  return (
    <Popover
      label={
        <>
          <span className="worktree-picker-label">
            {label}
            {currentBranch ? ` · ${currentBranch}` : ''}
          </span>
          {attention > 0 && (
            <span className="worktree-attention-dot" title={`${attention} terminals need you`}>
              ●
            </span>
          )}
          {elsewhere > 0 && (
            <span
              className="worktree-attention-dot elsewhere"
              title={`${elsewhere} terminals in other worktrees need you`}
            >
              ○ {elsewhere}
            </span>
          )}
        </>
      }
      title="Task menu"
      className="worktree-picker"
      listClassName="worktree-popover"
      align={align}
      portal
    >
      <WorktreeOverview branch={branch} onOpen={refreshBranch} />
    </Popover>
  )
}

function WorktreeOverview({ branch, onOpen }: { branch: string; onOpen: () => void }) {
  const tasks = useStore((s) => s.tasks)
  const counts = JSON.parse(useStore(attentionCounts)) as Record<string, number>
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
        onClick={() => {
          close()
          seedNewTask()
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
    ...planTerminals(devices).map((t) => ({
      componentId: PLAN_SCOPE,
      name: 'Planner',
      t,
      sid: sessionId(PLAN_SCOPE, t.id, id),
    })),
  ].filter(({ sid }) => sessions[sid]?.running)

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

  const toggleComponent = (cid: string) => {
    if (!task) return
    // From the latest copy, updated at once, so quick toggles don't overwrite each other.
    const s = useStore.getState()
    const current = s.tasks.find((t) => t.id === task.id)?.components ?? task.components
    const components = current.includes(cid) ? current.filter((c) => c !== cid) : [...current, cid]
    s.setTasks(s.tasks.map((t) => (t.id === task.id ? { ...t, components } : t)))
    if (projectId)
      s.patchTask(projectId, task.id, {
        highlighted: components,
        implementationComponents: components.map((id) => ({ id, visible: true })),
      })
    void taskUpdate(task.id, { components }, projectId).catch((e) =>
      useStore.getState().setMessage(String(e)),
    )
  }

  return (
    <section className={`worktree-row ${active ? 'active' : ''} ${task?.missing ? 'missing' : ''}`}>
      <header className="worktree-row-header">
        <button
          className="worktree-row-switch"
          disabled={!!task?.missing}
          aria-pressed={active}
          onClick={switchTo}
        >
          <strong>{task ? task.title : 'Project folder'}</strong>
          {(task?.branch ?? branch) && <code>{task?.branch ?? branch}</code>}
        </button>
        {task?.current && <span className="worktree-tag">project folder</span>}
        {task?.missing && <span className="worktree-tag bad">worktree missing</span>}
        {attention > 0 && (
          <span className="worktree-tag attention" title="Terminals that need you">
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
        {task && <button onClick={() => setRename(!rename)}>Rename…</button>}
        {task && !confirming && (
          <button className="danger" onClick={() => setConfirming(true)}>
            Remove…
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
      {task && (
        <div className="worktree-detail">
          <span className="section-title">About</span>
          <div className="scope-chips">
            {nodes.map((n) => (
              <button
                key={n.id}
                className={`chip ${task.components.includes(n.id) ? 'active' : 'off'}`}
                aria-pressed={task.components.includes(n.id)}
                title={task.components.includes(n.id) ? 'Remove from worktree' : 'Add to worktree'}
                onClick={() => toggleComponent(n.id)}
              >
                <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
                {n.data.name}
              </button>
            ))}
          </div>
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
                {name} · {t.name}
              </button>
            ))
          ) : (
            <span className="hint flush">No terminals running</span>
          )}
        </div>
      </div>
      {task && (
        <details className="worktree-notes-detail">
          <summary>Notes{notes ? ` · ${notes.split('\n')[0]}` : ''}</summary>
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
