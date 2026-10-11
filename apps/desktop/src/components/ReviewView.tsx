import PersistedGroup from './PersistedGroup'
import { useEffect, useState, type MouseEvent } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR } from '../lib/display'
import { gitReview, gitWorktrees, reviewPrune } from '../lib/ipc'
import { ago, latestChange, latestChangeOf, lineTotals } from '../lib/review'
import { useCollapsed } from '../lib/useCollapsed'
import { activeWorktree } from '../lib/tasks'
import {
  currentReviewAgentRecord,
  mergeDestinations,
  reviewAgentRecords,
  reviewState,
  sourceLatestChange,
} from '../lib/reviewAgents'
import MergeAgentDialog from './MergeAgentDialog'
import ReviewAgentDialog from './ReviewAgentDialog'
import { useReviewFindings } from '../lib/useReviewFindings'
import { useClockTick } from '../lib/clock'
import ReviewAgentPanel from './ReviewAgentPanel'
import { useStore } from '../store'
import { PROJECT_SCOPE, type ChangedFile, type Review, type Worktree } from '../types'
import ChangeList from './changes/ChangeList'
import DiffStat from './changes/DiffStat'
import DiffView from './changes/DiffView'
import ValidationChips from './changes/ValidationChips'

/** The watcher covers the open and active task's worktrees; another one is polled while shown. */
const WORKTREE_POLL_MS = 5000

interface ChangeGroup {
  id: string
  name: string
  color: string
  base: string
  files: ChangedFile[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function worktreeLabel(w: Worktree) {
  const name = w.path.split(/[\\/]/).pop() ?? w.path
  const branch = w.branch ?? `detached ${w.head.slice(0, 7)}`
  return `${branch} · ${name}${w.current ? ' (main worktree)' : ''}`
}

/**
 * Every uncommitted change on the map, grouped by component (plus project files no component
 * contains), with the components that depend on changed ones and whether each one's task
 * terminals ran since the change. Chips filter the components; another worktree of the repo can
 * be reviewed in place of the open one.
 */
export default function ReviewView() {
  const revision = useStore((s) => s.gitChanges)
  const nodes = useStore((s) => s.nodes)
  // Selecting or dragging replaces nodes and edges; refetch only when folders or links change.
  const pathsKey = useStore((s) => s.nodes.map((n) => `${n.id}\0${n.data.path}`).join('\n'))
  const linksKey = useStore((s) => s.edges.map((e) => `${e.source}>${e.target}`).join('\n'))
  const select = useStore((s) => s.select)
  const [loaded, setLoaded] = useState<{ scope: string; review: Review }>()
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ componentId: string; path: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<string[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const taskWorktree = useStore(activeWorktree)
  // The worktree picked here; until then (and after switching tasks) the active task's.
  const [picked, setPicked] = useState<{ task: string | null; path: string | undefined }>()
  const worktree = picked?.task === activeTask ? picked.path : taskWorktree
  const [refresh, setRefresh] = useState(0)
  const [worktreeRefresh, setWorktreeRefresh] = useState(0)
  const [reviewDialogScope, setReviewDialogScope] = useState<string | null>(null)
  const [mergeDialogScope, setMergeDialogScope] = useState<string | null>(null)
  const agentSelection = useStore((s) => s.reviewAgents[s.project?.id ?? ''])
  const currentAgent = useStore((s) =>
    currentReviewAgentRecord(
      reviewAgentRecords(s.sessionRecords, s.project?.id),
      s.sessions,
      s.reviewAgents[s.project?.id ?? '']?.sid,
    ),
  )

  const other = worktrees.find((w) => w.path === worktree && !w.current)
  // `undefined` reviews the open worktree, which the watcher keeps current.
  const target = other?.path
  const projectId = useStore((s) => s.project?.id)
  const source = other ?? worktrees.find((w) => w.current)
  const agentsHidden = agentSelection?.sid === currentAgent?.id && !!agentSelection?.hidden
  const showAgents = !!currentAgent && !agentsHidden
  const hideAgents = () => {
    if (currentAgent) useStore.getState().hideReviewAgent(currentAgent.id)
  }
  const agentPanel = useCollapsed(
    'ReviewView-merge-terminal',
    showAgents,
    currentAgent?.id,
    hideAgents,
    'ReviewView-open',
  )
  // Refresh worktree branches and HEADs independently of the diff watcher.
  const worktreesKey = tasks
    .map((t) => `${t.id}\0${t.worktree}\0${t.branch}\0${t.missing}`)
    .join('\n')
  const dialogScope = JSON.stringify([projectId, source?.path, source?.branch, activeTask])
  const reviewDialog = reviewDialogScope === dialogScope
  if (reviewDialogScope && !reviewDialog) setReviewDialogScope(null)
  const mergeDialog = mergeDialogScope === dialogScope
  if (mergeDialogScope && !mergeDialog) setMergeDialogScope(null)
  const canMerge = !!source?.branch && mergeDestinations(source, worktrees).length > 0
  const reviewScope = JSON.stringify([projectId, target])

  const review = loaded?.scope === reviewScope ? loaded.review : null
  const findings = useReviewFindings(projectId, source?.branch)
  useClockTick()
  const repos = useStore((s) => s.repos)
  const latestChangeMs = sourceLatestChange(review?.changes, repos)
  const status = reviewState(findings?.findings, source, latestChangeMs)
  // Terminals are keyed by task, so validation status shows for the open worktree and tasks.
  const reviewTask = other ? tasks.find((t) => t.worktree === other.path && !t.missing) : undefined
  // The open worktree's sessions belong to the active task when the project is open in its
  // worktree, and to no task otherwise.
  const openTask = tasks.find((t) => t.id === activeTask && t.current)?.id ?? null
  const validationTask = other ? (reviewTask?.id ?? undefined) : openTask
  const watched = !other || other.path === taskWorktree

  // Findings of deleted branches are dropped once per visit, off the polling path.
  useEffect(() => {
    if (projectId) reviewPrune(projectId).catch(() => {})
  }, [projectId])

  useEffect(() => {
    let disposed = false
    void gitWorktrees()
      .then((list) => {
        if (!disposed)
          setWorktrees((previous) =>
            JSON.stringify(previous) === JSON.stringify(list) ? previous : list,
          )
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [projectId, worktreesKey, activeTask, worktreeRefresh])

  // Poll branch metadata independently; also refresh diffs for an unwatched worktree.
  useEffect(() => {
    const bump = () => {
      setWorktreeRefresh((n) => n + 1)
      if (target && !watched) setRefresh((n) => n + 1)
    }
    const timer = window.setInterval(bump, WORKTREE_POLL_MS)
    window.addEventListener('focus', bump)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', bump)
    }
  }, [target, watched])

  useEffect(() => {
    let disposed = false
    void gitReview(useStore.getState().toProject(), target)
      .then((r) => {
        if (!disposed) {
          setLoaded({ scope: reviewScope, review: r })
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [revision, pathsKey, linksKey, refresh, reviewScope, target])

  const groups: ChangeGroup[] = []
  if (review) {
    for (const n of nodes) {
      const files = review.changes[n.id]
      if (files?.length)
        groups.push({
          id: n.id,
          name: n.data.name,
          color: KIND_COLOR[n.data.kind],
          base: n.data.path,
          files,
        })
    }
    const loose = review.changes[PROJECT_SCOPE]
    if (loose?.length)
      groups.push({ id: PROJECT_SCOPE, name: 'Project files', color: '', base: '.', files: loose })
  }
  const active = filter.filter((id) => groups.some((g) => g.id === id))
  const shown = active.length ? groups.filter((g) => active.includes(g.id)) : groups
  const shownFiles = shown.flatMap((g) => g.files)
  const totals = lineTotals(shownFiles)
  const componentCount = shown.filter((g) => g.id !== PROJECT_SCOPE).length
  const affected = (review?.affected ?? []).filter(
    (a) => !active.length || a.via.some((id) => active.includes(id)),
  )

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  const current =
    (selected &&
      shown.some(
        (g) => g.id === selected.componentId && g.files.some((f) => f.path === selected.path),
      ) &&
      selected) ||
    (shown[0] && { componentId: shown[0].id, path: shown[0].files[0].path })
  const currentFile = current
    ? (review?.changes[current.componentId]?.find((f) => f.path === current.path) ?? null)
    : null

  // Click shows one component; Cmd/Ctrl/Shift-click adds or removes it.
  const toggleFilter = (id: string, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey)
      setFilter(active.includes(id) ? active.filter((x) => x !== id) : [...active, id])
    else setFilter(active.length === 1 && active[0] === id ? [] : [id])
  }

  return (
    <div className="workspace review-view">
      {reviewDialog && source?.branch && (
        <ReviewAgentDialog
          key={`${projectId}/${source.path}/${source.branch}`}
          source={source}
          worktrees={worktrees}
          close={() => setReviewDialogScope(null)}
          launched={(sid) => {
            if (useStore.getState().project?.id === projectId)
              useStore.getState().setActiveSession(sid)
            setReviewDialogScope(null)
          }}
        />
      )}
      {mergeDialog && source?.branch && (
        <MergeAgentDialog
          key={`${projectId}/${source.path}/${source.branch}`}
          source={source}
          worktrees={worktrees}
          findings={findings}
          latestChangeMs={latestChangeMs}
          close={() => setMergeDialogScope(null)}
          launched={(sid) => {
            if (useStore.getState().project?.id === projectId)
              useStore.getState().setActiveSession(sid)
            setMergeDialogScope(null)
          }}
        />
      )}
      <PersistedGroup layoutId="ReviewView-merge" orientation="vertical">
        <Panel id="ReviewView-changes" defaultSize="65" minSize="25">
          <PersistedGroup layoutId="ReviewView-1" orientation="horizontal">
            <Panel id="ReviewView-pane-1" defaultSize="38" minSize="20">
              <div className="review-list">
                <div className="review-header">
                  <div className="review-title-row">
                    <span className="review-title">Review</span>
                    <button
                      className="review-agent-button"
                      disabled={!source?.branch}
                      onClick={() => setReviewDialogScope(dialogScope)}
                    >
                      Review branch…
                    </button>
                    <button
                      className="review-merge-button"
                      disabled={!canMerge}
                      title={
                        canMerge
                          ? 'Merge the reviewed branch into another worktree'
                          : 'Choose a branch with another destination worktree'
                      }
                      onClick={() => setMergeDialogScope(dialogScope)}
                    >
                      Merge into…
                    </button>
                    {agentsHidden && currentAgent && (
                      <button onClick={() => useStore.getState().setActiveSession(currentAgent.id)}>
                        Show agents
                      </button>
                    )}
                    {worktrees.length > 1 && (
                      <select
                        className="review-worktree"
                        title="Worktree to review"
                        value={other?.path ?? ''}
                        onChange={(e) => {
                          setPicked({ task: activeTask, path: e.target.value || undefined })
                          setSelected(null)
                          setLoaded(undefined)
                        }}
                      >
                        {worktrees.map((w) => {
                          const task = tasks.find((t) => t.worktree === w.path)
                          return (
                            <option key={w.path} value={w.current ? '' : w.path}>
                              {task ? `${task.title} — ` : ''}
                              {worktreeLabel(w)}
                            </option>
                          )
                        })}
                      </select>
                    )}
                    <button
                      className="review-refresh"
                      title="Refresh review"
                      onClick={() => {
                        setRefresh((n) => n + 1)
                        setWorktreeRefresh((n) => n + 1)
                      }}
                    >
                      ↻
                    </button>
                  </div>
                  <div className="review-status" role="status">
                    {findings?.error
                      ? findings.error
                      : !source?.branch
                        ? 'Not reviewed'
                        : !findings
                          ? 'Loading review status…'
                          : status === 'none'
                            ? 'Not reviewed'
                            : status === 'stale'
                              ? 'Changed since review'
                              : `Reviewed ${ago(findings.findings!.modifiedMs)}`}
                  </div>
                  {review && (
                    <div className="review-summary">
                      <span>{plural(shownFiles.length, 'file')}</span>
                      {shownFiles.length > 0 && <DiffStat {...totals} />}
                      {componentCount > 0 && <span>{plural(componentCount, 'component')}</span>}
                    </div>
                  )}
                  {groups.length > 1 && (
                    <div className="review-filter" role="toolbar" aria-label="Filter components">
                      <button
                        className={`filter-chip ${active.length ? '' : 'on'}`}
                        aria-pressed={!active.length}
                        onClick={() => setFilter([])}
                      >
                        All
                      </button>
                      {groups.map((g) => (
                        <button
                          key={g.id}
                          className={`filter-chip ${active.includes(g.id) ? 'on' : ''}`}
                          aria-pressed={active.includes(g.id)}
                          title={`Show only ${g.name} (⌘/⇧-click to add)`}
                          onClick={(e) => toggleFilter(g.id, e)}
                        >
                          <span
                            className={`kind-dot ${g.color ? '' : 'project'}`}
                            style={g.color ? { background: g.color } : undefined}
                          />
                          {g.name}
                          <span className="filter-count">{g.files.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {other && (
                  <div className="review-banner">
                    Viewing worktree {reviewTask && <>“{reviewTask.title}” on </>}
                    <code>{other.branch ?? other.head.slice(0, 7)}</code> at{' '}
                    <code title={other.path}>{other.path}</code>.
                    {!reviewTask &&
                      " Terminal status is hidden; it isn't tracked, so no terminals ran there."}
                  </div>
                )}
                {error && <div className="hint file-tree-error">{error}</div>}
                {!review && !error && <div className="hint">Loading…</div>}
                {review && !groups.length && (
                  <div className="review-empty">
                    <div className="review-empty-mark">✓</div>
                    No uncommitted changes.
                  </div>
                )}
                {shown.map((g) => {
                  const open = !collapsed[g.id]
                  const project = g.id === PROJECT_SCOPE
                  return (
                    <section key={g.id} className="review-group">
                      <header className="review-group-header">
                        <button
                          className="review-toggle"
                          aria-expanded={open}
                          aria-label={open ? 'Collapse' : 'Expand'}
                          onClick={() => setCollapsed({ ...collapsed, [g.id]: open })}
                        >
                          {open ? '▾' : '▸'}
                        </button>
                        <span
                          className={`kind-dot ${project ? 'project' : ''}`}
                          style={project ? undefined : { background: g.color }}
                        />
                        {project ? (
                          <span className="review-name" title="Files no component contains">
                            {g.name}
                          </span>
                        ) : (
                          <button className="review-name" onClick={() => select(g.id)}>
                            {g.name}
                          </button>
                        )}
                        <span className="review-count">{plural(g.files.length, 'file')}</span>
                        <DiffStat {...lineTotals(g.files)} />
                      </header>
                      {!project && validationTask !== undefined && (
                        <ValidationChips
                          componentId={g.id}
                          changedAt={latestChange(g.files)}
                          task={validationTask}
                        />
                      )}
                      {open && (
                        <ChangeList
                          files={g.files}
                          base={g.base}
                          selected={current?.componentId === g.id ? current.path : undefined}
                          onSelect={(path) => setSelected({ componentId: g.id, path })}
                          task={null}
                          worktree={target}
                        />
                      )}
                    </section>
                  )
                })}
                {review && affected.length > 0 && (
                  <>
                    <div className="panel-title review-affected-title">May be affected</div>
                    {affected.map((a) => {
                      const node = nodes.find((n) => n.id === a.id)
                      if (!node) return null
                      return (
                        <section key={a.id} className="review-group affected">
                          <header className="review-group-header">
                            <span
                              className="kind-dot"
                              style={{ background: KIND_COLOR[node.data.kind] }}
                            />
                            <button className="review-name" onClick={() => select(a.id)}>
                              {node.data.name}
                            </button>
                            <span className="review-via">via {a.via.map(nameOf).join(', ')}</span>
                          </header>
                          {validationTask !== undefined && (
                            <ValidationChips
                              componentId={a.id}
                              changedAt={latestChangeOf(review.changes, a.via)}
                              task={validationTask}
                            />
                          )}
                        </section>
                      )
                    })}
                  </>
                )}
              </div>
            </Panel>
            <Separator className="separator" />
            <Panel id="ReviewView-pane-2" defaultSize="62" minSize="30">
              {current ? (
                <DiffView
                  componentId={current.componentId}
                  file={currentFile}
                  revision={review}
                  worktree={target}
                />
              ) : (
                <div className="diff-view hint">Nothing to review.</div>
              )}
            </Panel>
          </PersistedGroup>
        </Panel>
        <Separator className="separator horizontal" />
        <Panel id="ReviewView-merge-terminal" defaultSize="35" minSize="15" {...agentPanel.props}>
          {currentAgent && !agentPanel.collapsed && (
            <ReviewAgentPanel
              selected={currentAgent}
              select={(sid) => useStore.getState().setActiveSession(sid)}
              hide={hideAgents}
            />
          )}
        </Panel>
      </PersistedGroup>
    </div>
  )
}
