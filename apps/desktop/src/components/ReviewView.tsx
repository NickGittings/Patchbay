import { changeGroups } from '../lib/changeGroups'
import PersistedGroup from './PersistedGroup'
import { useEffect, useState, type MouseEvent } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR, plural } from '../lib/display'
import { gitReview, gitWorktrees, reviewPrune } from '../lib/ipc'
import { ago, changedFileRef, latestChange, latestChangeOf, lineTotals } from '../lib/review'
import { useCollapsed } from '../lib/useCollapsed'
import { activeWorktree } from '../lib/tasks'
import {
  currentReviewAgentRecord,
  mergeDestinations,
  reviewAgentRecords,
  reviewState,
} from '../lib/reviewAgents'
import MergeAgentDialog from './MergeAgentDialog'
import ReviewAgentDialog from './ReviewAgentDialog'
import { useReviewFindings, type LoadedFindings } from '../lib/useReviewFindings'
import { useClockTick } from '../lib/clock'
import ReviewAgentPanel from './ReviewAgentPanel'
import { useStore } from '../store'
import { PROJECT_SCOPE, REVIEW_SCOPE, type Review, type Worktree } from '../types'
import ChangeList from './changes/ChangeList'
import DiffStat from './changes/DiffStat'
import DiffView from './changes/DiffView'
import ValidationChips from './changes/ValidationChips'
import FindingsPanel, { SeverityCounts, VerdictBadge } from './findings/FindingsPanel'
import { useRunningReviewLanes } from '../lib/reviewAgents'
import FixFindingsButton from './findings/FixFindingsButton'
import type { FileRef } from '../lib/findings'

/** The watcher covers the open and active task's worktrees; another one is polled while shown. */
const WORKTREE_POLL_MS = 5000

/**
 * Every uncommitted change on the map, grouped by component (plus project files no component
 * contains), with the components that depend on changed ones and whether each one's task
 * terminals ran since the change. Chips filter the components; the toolbar's worktree picker
 * chooses which worktree of the repo is reviewed.
 */
export default function ReviewView() {
  const revision = useStore((s) => s.gitChanges)
  const nodes = useStore((s) => s.nodes)
  // Selecting or dragging replaces nodes and edges; refetch only when folders or links change.
  const pathsKey = useStore((s) => s.nodes.map((n) => `${n.id}\0${n.data.path}`).join('\n'))
  const linksKey = useStore((s) => s.edges.map((e) => `${e.source}>${e.target}`).join('\n'))
  const select = useStore((s) => s.select)
  const [loaded, setLoaded] = useState<{ scope: string; review: Review }>()
  const [failed, setFailed] = useState<{ scope: string; message: string }>()
  const [selected, setSelected] = useState<{ componentId: string; path: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // "Open in Review" (outside Review, so this mounts afterwards) asks to start with one component.
  const reviewFocus = useStore((s) => s.reviewFocus)
  const [filter, setFilter] = useState<string[]>(reviewFocus ? [reviewFocus] : [])
  useEffect(() => {
    if (reviewFocus) useStore.setState({ reviewFocus: null })
  }, [reviewFocus])
  // The right pane shows findings in place of a diff; a diff opened from a finding offers a way back.
  const findingsFocus = useStore((s) => s.reviewFindingsFocus)
  const [pane, setPane] = useState<'diff' | 'findings' | 'fromFindings'>(
    findingsFocus ? 'findings' : 'diff',
  )
  useEffect(() => {
    if (findingsFocus) useStore.setState({ reviewFindingsFocus: false })
  }, [findingsFocus])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  const taskWorktree = useStore(activeWorktree)
  if (findingsFocus && pane !== 'findings') setPane('findings')
  // Review follows the toolbar's worktree picker.
  const worktree = taskWorktree
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
  const error = failed?.scope === reviewScope ? failed.message : ''
  const findings = useReviewFindings(projectId, source?.branch)
  const reviewLanes = useRunningReviewLanes(source?.branch)
  const status = reviewState(findings?.findings, source)
  // The newest review session of the source branch, for the fix handoff beside its findings.
  const reviewRecord = useStore((s) =>
    source?.branch
      ? reviewAgentRecords(s.sessionRecords, projectId).find(
          (r) => r.metadata.componentId === REVIEW_SCOPE && r.metadata.branch === source.branch,
        )
      : undefined,
  )
  // Terminals are keyed by task, so validation status shows for the open worktree and tasks.
  // The open worktree's sessions belong to the active task when the project is open in its
  // worktree, and to no task otherwise.
  const openTask = tasks.find((t) => t.id === activeTask && t.current && !t.missing)
  const reviewTask = other ? tasks.find((t) => t.worktree === other.path && !t.missing) : openTask
  const validationTask = other ? (reviewTask?.id ?? undefined) : (openTask?.id ?? null)
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
          setFailed(undefined)
        }
      })
      .catch((e) => {
        if (!disposed) setFailed({ scope: reviewScope, message: String(e) })
      })
    return () => {
      disposed = true
    }
  }, [revision, pathsKey, linksKey, refresh, reviewScope, target])

  const groups = changeGroups(nodes, review)
  const active = filter.filter((id) => groups.some((g) => g.id === id))
  const shown = active.length ? groups.filter((g) => active.includes(g.id)) : groups
  const shownFiles = shown.flatMap((g) => g.files)
  const totals = lineTotals(shownFiles)
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

  // Reviewers name paths relative to their worktree, which is usually the project root too.
  // An exact path wins; otherwise the ref must match one changed file by suffix, so a bare
  // `index.ts:12` among several changed index.ts files opens none rather than a guess.
  const changedFile = (path: string) => {
    const files = groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
    return changedFileRef(files, path, source?.path)
  }
  const openRef = (ref: FileRef) => {
    const file = changedFile(ref.path)
    if (!file) return
    if (active.length && !active.includes(file.componentId)) setFilter([])
    setCollapsed({ ...collapsed, [file.componentId]: false })
    setSelected(file)
    setPane('fromFindings')
  }

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
                    {!other && reviewTask && <strong>{reviewTask.title}</strong>}
                    <span className="review-totals">
                      {review && shownFiles.length > 0 && <DiffStat {...totals} />}
                    </span>
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
                  <div className="review-status-row">
                    <ReviewStatus branch={source?.branch} findings={findings} status={status} />
                    {source?.branch && (
                      <button
                        className={`review-findings-button ${pane === 'findings' ? 'on' : ''}`}
                        aria-pressed={pane === 'findings'}
                        title="Show the review agents' findings for this branch"
                        onClick={() => setPane(pane === 'findings' ? 'diff' : 'findings')}
                      >
                        Findings
                        {findings?.findings && (
                          <>
                            <VerdictBadge findings={findings.findings} running={reviewLanes} />
                            <SeverityCounts findings={findings.findings} />
                          </>
                        )}
                      </button>
                    )}
                  </div>
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
                    Viewing {reviewTask ? `“${reviewTask.title}” on ` : ''}
                    <code>{other.branch ?? `detached ${other.head.slice(0, 7)}`}</code> at{' '}
                    <code>{other.path}</code>.
                    {validationTask === undefined &&
                      ' Validation status is hidden because this worktree has no tracked task sessions.'}
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
                          selected={
                            pane !== 'findings' && current?.componentId === g.id
                              ? current.path
                              : undefined
                          }
                          onSelect={(path) => {
                            setSelected({ componentId: g.id, path })
                            setPane('diff')
                          }}
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
              {pane === 'findings' ? (
                <FindingsPanel
                  loaded={findings}
                  status={status}
                  branch={source?.branch}
                  onOpenFile={openRef}
                  canOpen={(path) => !!changedFile(path)}
                  actions={
                    reviewRecord && (
                      <FixFindingsButton
                        record={reviewRecord}
                        hasFindings={!!findings?.findings?.text.trim()}
                      />
                    )
                  }
                />
              ) : current && pane === 'fromFindings' ? (
                <div className="review-diff-pane">
                  <div className="review-diff-back">
                    <button onClick={() => setPane('findings')}>← Findings</button>
                  </div>
                  <DiffView
                    componentId={current.componentId}
                    file={currentFile}
                    revision={review}
                    worktree={target}
                  />
                </div>
              ) : current ? (
                <DiffView
                  componentId={current.componentId}
                  file={currentFile}
                  revision={review}
                  worktree={target}
                />
              ) : (
                <div className="diff-view">
                  <div className="review-empty" role={error ? 'alert' : 'status'}>
                    {error
                      ? `Could not load changes: ${error}`
                      : !review
                        ? 'Loading changes…'
                        : 'No uncommitted changes.'}
                  </div>
                </div>
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
              sourceBranch={source?.branch}
              sourceFindings={findings}
              sourceStatus={status}
              openFindings={() => setPane('findings')}
            />
          )}
        </Panel>
      </PersistedGroup>
    </div>
  )
}

/** Its own component, so the relative time ticks without re-rendering all of Review. */
function ReviewStatus({
  branch,
  findings,
  status,
}: {
  branch: string | null | undefined
  findings: LoadedFindings | undefined
  status: ReturnType<typeof reviewState>
}) {
  useClockTick()
  return (
    <div className="review-status" role="status">
      {findings?.error
        ? findings.error
        : !branch
          ? 'Not reviewed'
          : !findings
            ? 'Loading review status…'
            : status === 'none'
              ? 'Not reviewed'
              : status === 'stale'
                ? 'Changed since review'
                : `Reviewed ${ago(findings.findings!.modifiedMs)}`}
    </div>
  )
}
