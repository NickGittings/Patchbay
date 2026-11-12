import PanelSection from '../PanelSection'
import Menu, { MenuItem } from '../Menu'
import RailIcon from '../RailIcon'
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  attentionItems,
  componentTerminals,
  revealTerminal,
  type AttentionItem,
} from '../../lib/attention'
import { KIND_COLOR } from '../../lib/display'
import { gitReview, taskUpdate } from '../../lib/ipc'
import { refreshMainWorktree, useMainWorktree } from '../../lib/mainWorktree'
import { useShallow } from 'zustand/react/shallow'
import { planTerminals } from '../../lib/plan'
import { selectPanel } from '../../lib/rail'
import { unseenFinished } from '../../lib/taskActions'
import { useClockTick } from '../../lib/clock'
import { refreshTasks, removeTask, seedNewTask } from '../../lib/tasks'
import { useStore } from '../../store'
import {
  TASK_ROOT_SCOPE,
  PLAN_SCOPE,
  PROJECT_SCOPE,
  plannerSessionId,
  parseSessionId,
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
  const main = useMainWorktree((m) => m[projectId ?? ''])
  const refreshBranch = useCallback(() => refreshMainWorktree(projectId), [projectId])
  return (
    <WorktreeOverview
      branch={main?.branch ?? ''}
      onOpen={refreshBranch}
      git={!!main?.git}
      copyPlan={copyPlan}
    />
  )
}

/** One project snapshot and attention scan serves every card in the overview. */
function useWorktreeSnapshot() {
  return useStore(
    useShallow((s) => ({
      nodes: s.nodes,
      sessions: s.sessions,
      runtimeTerminals: s.runtimeTerminals,
      devices: s.devices,
      activeTask: s.activeTask,
      rootTerminals: s.rootTerminals,
      taskWorkspaces: s.taskWorkspaces,
      tasks: s.tasks,
      auto: s.auto,
      sessionRecords: s.sessionRecords,
      taskActivities: s.taskActivities,
      seenActivities: s.seenActivities,
    })),
  )
}

function WorktreeOverview({
  branch,
  onOpen,
  git,
  copyPlan,
}: {
  branch: string
  onOpen: () => void
  git: boolean
  copyPlan: boolean
}) {
  useClockTick()
  const snapshot = useWorktreeSnapshot()
  const { tasks } = snapshot
  const attention = attentionItems(snapshot)
  const close = useContext(CloseMenu)
  useEffect(() => {
    void refreshTasks()
    onOpen()
  }, [onOpen])
  return (
    <>
      <button
        className="worktree-new primary"
        disabled={!git}
        title={git ? undefined : 'Named tasks require a Git repository'}
        onClick={() => {
          close()
          seedNewTask(undefined, { copyPlan })
        }}
      >
        ＋ New task
      </button>
      <PanelSection title="Worktrees">
        <div className="worktree-list">
          {!tasks.some((t) => t.current && !t.missing) && (
            <WorktreeRow task={null} branch={branch} snapshot={snapshot} attention={attention} />
          )}
          {tasks.map((task) => (
            <WorktreeRow key={task.id} task={task} snapshot={snapshot} attention={attention} />
          ))}
        </div>
      </PanelSection>
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
    .catch((e) => useStore.getState().setMessage(String(e), undefined, undefined, 'error'))
}

const ROW_CONTROLS =
  'button, a, input, textarea, select, summary, form, details[open] > :not(summary), .chip, ' +
  '.worktree-path, .worktree-confirm, .file-tree-error, .worktree-detail-panel, [role="menu"]'

/** One worktree's summary and its rename, notes and remove controls. */
function WorktreeRow({
  task,
  branch,
  snapshot,
  attention,
}: {
  task: Task | null
  branch?: string
  snapshot: ReturnType<typeof useWorktreeSnapshot>
  attention: AttentionItem[]
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
  const { nodes, sessions, runtimeTerminals, devices, activeTask, rootTerminals, taskWorkspaces } =
    snapshot
  const issues = attention.filter((item) => item.task === id)
  const activities = Object.values(snapshot.taskActivities)
    .filter((a) => a.projectId === projectId && (a.task ?? null) === id)
    .reverse()
  const tests = activities
    .filter((a) => ['validate', 'validateChanged', 'validateSelected'].includes(a.action.kind))
    .flatMap((a) => (a.report?.results ?? []).map((result) => ({ ...result, activityId: a.id })))
  const seen = new Set(snapshot.seenActivities)
  const finished = activities.filter(
    (a) => activeTask !== id && unseenFinished(a, projectId, id, seen),
  )
  const terminalName = (sid: string) => {
    const { componentId, terminalId } = parseSessionId(sid)
    const record = snapshot.sessionRecords.find((r) => r.id === sid)
    const terminal = componentTerminals(
      componentId,
      nodes.find((n) => n.id === componentId)?.data.terminals ?? [],
      runtimeTerminals,
      id,
    ).find(([session]) => session === sid)?.[1]
    return record?.metadata.name ?? terminal?.name ?? terminalId ?? sid
  }
  const openTerminal = (sid: string) => {
    close()
    revealTerminal({ sid, componentId: parseSessionId(sid).componentId })
  }
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
    ...planTerminals(devices).map((t) => ({
      componentId: PLAN_SCOPE,
      name: 'Planner',
      t,
      sid: plannerSessionId(t.id, undefined, id),
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
    // Background clicks select even the current worktree. The title button provides keyboard
    // access; controls and selectable detail text keep their own interactions.
    <section
      className={`worktree-row ${active ? 'active' : ''} ${task?.missing ? 'missing' : ''}`}
      aria-label={task?.title ?? 'Main worktree'}
      onClick={(e) => {
        if ((e.target as Element).closest(ROW_CONTROLS)) return
        if (window.getSelection()?.toString()) return
        switchTo()
      }}
    >
      <header className="worktree-row-header">
        <button
          className="worktree-row-switch"
          disabled={!!task?.missing}
          aria-pressed={active}
          title={task?.worktree}
          onClick={switchTo}
        >
          <strong title={task?.title ?? 'Main worktree'}>
            {task ? task.title : 'Main worktree'}
          </strong>
          {(task?.branch ?? branch) && (
            <code title={task?.branch ?? branch}>{task?.branch ?? branch}</code>
          )}
        </button>
        {task?.current && <span className="worktree-tag">main worktree</span>}
        {task?.missing && <span className="worktree-tag bad">worktree missing</span>}
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
        {task && (
          <Menu label="⋯" triggerLabel={`Actions for ${task.title}`} caret={false} portal>
            <MenuItem onClick={() => setRename(!rename)}>Rename</MenuItem>
            <MenuItem disabled={confirming} onClick={() => setConfirming(true)}>
              Remove
            </MenuItem>
          </Menu>
        )}
      </header>
      {task && rename && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void taskUpdate(task.id, { title }, projectId)
              .then(() => refreshTasks(projectId))
              .catch((e) =>
                useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
              )
            setRename(false)
          }}
        >
          <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button disabled={!title.trim()}>Save name</button>
        </form>
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
              void removeTask(task.id, true).catch((e) =>
                useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
              )
            }
          >
            Remove worktree
          </button>
          <button
            onClick={() =>
              void removeTask(task.id, false).catch((e) =>
                useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
              )
            }
          >
            Forget only
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      )}
      {error && (
        <p className="file-tree-error" role="alert">
          {error}
        </p>
      )}
      <div className="worktree-signals">
        <WorktreeDetail label="Tests" icon="tests" count={tests.length} disabled={!!task?.missing}>
          {() => (
            <>
              {!tests.length && <p>No validation results recorded.</p>}
              {tests.map((result, index) => (
                <button
                  key={`${result.activityId}:${result.sessionId}:${index}`}
                  className="chip"
                  title={result.message}
                  onClick={() => openTerminal(result.sessionId)}
                >
                  {terminalName(result.sessionId)}: {result.outcome}
                  {result.exitCode !== null && result.exitCode !== 0 && ` (${result.exitCode})`}
                </button>
              ))}
            </>
          )}
        </WorktreeDetail>
        <WorktreeDetail
          label="Issues"
          icon="issues"
          count={issues.length + finished.length}
          disabled={!!task?.missing}
        >
          {() => (
            <>
              {!issues.length && !finished.length && <p>Nothing needs attention.</p>}
              {issues.map((item) => (
                <button
                  key={item.sid}
                  className="chip"
                  title={item.status.detail}
                  onClick={() => {
                    close()
                    revealTerminal(item)
                  }}
                >
                  {item.owner}: {item.terminal.name} · {item.status.label}
                </button>
              ))}
              {finished.map((activity) => (
                <div key={activity.id} className="worktree-action-result">
                  <span>
                    {activity.action.kind.startsWith('validate') ? 'Validation' : 'Stack'} ·{' '}
                    {activity.state}
                  </span>
                  {activity.error && <p className="file-tree-error">{activity.error}</p>}
                  {activity.report?.results.map((result, index) => (
                    <button
                      key={`${result.sessionId}:${index}`}
                      className="chip"
                      onClick={() => openTerminal(result.sessionId)}
                    >
                      {terminalName(result.sessionId)}: {result.outcome}
                    </button>
                  ))}
                  {!activity.report?.results.length && (
                    <button
                      onClick={() => {
                        useStore.getState().setActiveTask(id)
                        selectPanel('activity')
                      }}
                    >
                      View activity
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </WorktreeDetail>
        <WorktreeDetail
          label="Changes"
          icon="changes"
          count={changedCount}
          disabled={!!task?.missing}
        >
          {() => (
            <>
              {!review && !error && <p>Loading changes…</p>}
              {review && !changedCount && !review.affected.length && <p>No changes.</p>}
              {(changed.length > 0 || projectFiles > 0) && (
                <div className="worktree-detail">
                  <span className="section-title">Changed</span>
                  <div className="scope-chips">
                    {changed.map((c) => chip(c.id, `±${c.files}`))}
                    {projectFiles > 0 && (
                      <span className="chip">Project files ±{projectFiles}</span>
                    )}
                  </div>
                </div>
              )}
              {!!review?.affected.length && (
                <div className="worktree-detail">
                  <span className="section-title">May affect</span>
                  <div className="scope-chips">
                    {review.affected.map((a) => chip(a.id, `via ${a.via.map(nameOf).join(', ')}`))}
                  </div>
                </div>
              )}
            </>
          )}
        </WorktreeDetail>
        <WorktreeDetail
          label="Running"
          icon="running"
          count={running.length}
          disabled={!!task?.missing}
        >
          {() => (
            <>
              {!running.length && <p>No running terminals.</p>}
              {running.map(({ componentId, name, t, sid }) => (
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
              ))}
            </>
          )}
        </WorktreeDetail>
      </div>
      {active && task && (
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

/** Each category owns its disclosure so opening one never collapses its neighbors. */
function WorktreeDetail({
  label,
  icon,
  count,
  disabled,
  children,
}: {
  label: string
  icon: string
  count: number
  disabled: boolean
  children: () => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const expanded = open && !disabled
  return (
    <>
      <button
        className="worktree-signal"
        title={`${label}: ${count}${label === 'Changes' ? ' files' : ''}`}
        aria-label={`${label}: ${count}`}
        aria-expanded={expanded}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <RailIcon name={icon} />
        <span>{count}</span>
      </button>
      <div
        id={panelId}
        className="worktree-detail-panel"
        role="region"
        aria-label={label}
        hidden={!expanded}
      >
        <span className="section-title">{label}</span>
        <div className="scope-chips">{expanded && children()}</div>
      </div>
    </>
  )
}
