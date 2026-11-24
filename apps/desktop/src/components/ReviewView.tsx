import { availableReviewBase } from '../lib/reviewAgents'
import PanelStatus from './PanelStatus'
import CommitDetails from './changes/CommitDetails'
import { setChosenCommit as setHistory, useChosenCommit } from '../lib/gitSync'
import { useStepKeys } from './changes/useStepKeys'
import { changeGroups } from '../lib/changeGroups'
import { changePosition, changeRefs, stepChange } from '../lib/changeNav'
import PersistedGroup from './PersistedGroup'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR } from '../lib/display'
import { gitReview, gitBranches, gitWorktrees, reviewPrune } from '../lib/ipc'
import { ago, changedFileRef, latestChangeOf, lineTotals } from '../lib/review'
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
import { REVIEW_SCOPE, type Review, type Worktree } from '../types'
import ChangeList from './changes/ChangeList'
import ChangeGroupCard from './changes/ChangeGroupCard'
import DiffStat from './changes/DiffStat'
import DiffView from './changes/DiffView'
import ValidationChips from './changes/ValidationChips'
import FindingsPanel, { SeverityCounts, VerdictBadge } from './findings/FindingsPanel'
import { useRunningReviewLanes } from '../lib/reviewAgents'
import FixFindingsButton from './findings/FixFindingsButton'
import StageStrip from './StageStrip'
import { useStageModel } from '../lib/useStageModel'
import type { FileRef } from '../lib/findings'
import { shortSha } from '../lib/commitId'

/** Worktree branches and HEADs are polled while shown; the watcher covers their diffs. */
const WORKTREE_POLL_MS = 5000

/**
 * Every uncommitted change on the map, grouped by component (plus project files no component
 * contains), with the components that depend on changed ones and whether each one's task
 * terminals ran since the change. Chips filter the components; the toolbar's worktree picker
 * chooses which worktree of the repo is reviewed.
 */
export default function ReviewView() {
  // The Git panel chooses a commit; it opens here, in place of a change's diff.
  const chosen = useChosenCommit()
  const history = chosen?.selection ?? null
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
  const [branches, setBranches] = useState<string[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const tasks = useStore((s) => s.tasks)
  const activeTask = useStore((s) => s.activeTask)
  // Review follows the toolbar's worktree picker; switching worktree drops the previous one's
  // selection, loaded review and a diff opened from its findings.
  const worktree = useStore(activeWorktree)
  if (findingsFocus && pane !== 'findings') setPane('findings')
  const [shownWorktree, setShownWorktree] = useState(worktree)
  if (shownWorktree !== worktree) {
    setShownWorktree(worktree)
    setSelected(null)
    setLoaded(undefined)
    if (pane === 'fromFindings') setPane('diff')
  }
  const [shownCommit, setShownCommit] = useState(history)
  if (shownCommit !== history) {
    setShownCommit(history)
    if (history && pane !== 'diff') setPane('diff')
  }
  const [refresh, setRefresh] = useState(0)
  const [worktreeRefresh, setWorktreeRefresh] = useState(0)
  const [reviewDialogScope, setReviewDialogScope] = useState<string | null>(null)
  const [mergeDialogScope, setMergeDialogScope] = useState<string | null>(null)
  const other = worktrees.find((w) => w.path === worktree && !w.current)
  // `undefined` reviews the open worktree, which the watcher keeps current.
  const target = other?.path
  const projectId = useStore((s) => s.project?.id)
  const source = other ?? worktrees.find((w) => w.current)
  const agentSelection = useStore((s) => s.reviewAgents[s.project?.id ?? ''])
  // The shown worktree's reviewers and merges, wherever they were started.
  // An explicit selection of this worktree's agent (one just launched, even merging another
  // source into it) shows first; otherwise its running reviewer or merge, wherever started.
  const currentAgent = useStore((s) => {
    const records = reviewAgentRecords(s.sessionRecords, s.project?.id)
    const selected = s.reviewAgents[s.project?.id ?? '']?.sid
    // A selection belongs to the shown worktree when it reviews it or merges from or into it.
    const ofShown = (r: (typeof records)[number]) =>
      !source ||
      (r.metadata.componentId === REVIEW_SCOPE
        ? r.spec.cwd === source.path
        : r.spec.merge_source === source.path || r.spec.cwd === source.path)
    return (
      records.find((r) => r.id === selected && ofShown(r)) ??
      currentReviewAgentRecord(
        records.filter(
          (r) =>
            !source ||
            (r.metadata.componentId === REVIEW_SCOPE
              ? r.spec.cwd === source.path
              : r.spec.merge_source === source.path),
        ),
        s.sessions,
        undefined,
      )
    )
  })
  // Where the worktree's work is, as Chat and the Auto panel show it, and what comes next.
  const stage = useStageModel()
  const next = new Set(stage?.state.prompt?.actions.map((a) => a.action))
  // Auto's own gate is approved in Chat or the Auto panel; the dialog here can't merge for it.
  const nextMerge = next.has('checkMerge') || next.has('merge')
  const nextFix = next.has('fix')
  // Hiding the dock sticks, also for the shown worktree's own agent when the hidden selection was
  // another worktree's; Show agents (or a launch here) brings it back.
  const agentsHidden = !!currentAgent && !!agentSelection?.hidden
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
  const canMerge = !!source?.branch && mergeDestinations(source, worktrees, branches).length > 0
  const findings = useReviewFindings(projectId, source?.branch)
  const base = availableReviewBase(source, tasks, worktrees, branches, findings?.findings?.base)
  const reviewScope = JSON.stringify([
    projectId,
    target,
    source?.head,
    base,
    worktrees.find((w) => w.branch === base)?.head,
  ])
  const [findingRef, setFindingRef] = useState<FileRef | null>(null)

  const review = loaded?.scope === reviewScope ? loaded.review : null
  const error = failed?.scope === reviewScope ? failed.message : ''
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
  // Match validators to the worktree actually being reviewed. Until another worktree resolves,
  // the diff falls back to the project folder; only its current task can supply validators.
  const reviewTask = tasks.find(
    (t) => !t.missing && (other ? t.worktree === other.path : t.current),
  )
  const validationTask = reviewTask?.id ?? null

  // Findings of deleted branches are dropped once per visit, off the polling path.
  useEffect(() => {
    if (projectId) reviewPrune(projectId).catch(() => {})
  }, [projectId])

  useEffect(() => {
    let disposed = false
    void gitWorktrees(projectId)
      .then(async (list) => [list, list.length ? await gitBranches(projectId) : []] as const)
      .then(([list, names]) => {
        if (!disposed) setBranches(names)
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

  // Poll branch metadata independently of the diff watcher.
  useEffect(() => {
    const bump = () => setWorktreeRefresh((n) => n + 1)
    const timer = window.setInterval(bump, WORKTREE_POLL_MS)
    window.addEventListener('focus', bump)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', bump)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    void gitReview(useStore.getState().toProject(), target, base)
      .then((r) => {
        if (!disposed) {
          setLoaded({ scope: reviewScope, review: r })
          setFailed(undefined)
        }
      })
      .catch((e) => {
        if (!disposed) {
          setLoaded(undefined)
          setFailed({ scope: reviewScope, message: String(e) })
        }
      })
    return () => {
      disposed = true
    }
  }, [revision, pathsKey, linksKey, refresh, reviewScope, target, base])

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

  // Arrows step through the files of expanded groups, in the order the list shows them.
  const order = changeRefs(shown.filter((g) => !collapsed[g.id]))
  const step = (delta: -1 | 1) => {
    if (history) return
    const next = stepChange(order, current, delta)
    if (!next) return
    setSelected(next)
    setFindingRef(null)
    if (pane === 'findings') setPane('diff')
  }
  // Findings text keeps its arrow keys for scrolling: only the list and a diff step files.
  const listPane = useRef<HTMLDivElement>(null)
  const diffPane = useRef<HTMLDivElement>(null)
  useStepKeys(step, [listPane, diffPane])
  const nav = { position: changePosition(order, current), total: order.length, step }

  // Reviewers name paths relative to their worktree, which is usually the project root too.
  // An exact path wins; otherwise the ref must match one changed file by suffix, so a bare
  // `index.ts:12` among several changed index.ts files opens none rather than a guess.
  const changedFile = (path: string) => {
    const files = groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
    return changedFileRef(files, path, source?.path)
  }
  const openRef = (ref: FileRef) => {
    const file = changedFile(ref.path)
    setFindingRef(ref)
    setPane('fromFindings')
    if (!file) return
    if (active.length && !active.includes(file.componentId)) setFilter([])
    setCollapsed({ ...collapsed, [file.componentId]: false })
    setSelected(file)
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
          origin="manual"
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
          origin="manual"
          source={source}
          worktrees={worktrees}
          branches={branches}
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
              <div className="review-list" ref={listPane}>
                <div className="review-header">
                  {stage?.visible && (
                    <>
                      <StageStrip items={stage.stepper} className="view-stepper" />
                      {stage.driver !== 'user' && (
                        <p className="view-stepper-hint">
                          {stage.driver === 'lead'
                            ? 'The chat’s lead is deciding the next stage.'
                            : stage.autoHalt === 'paused'
                              ? 'Auto is paused here; work you do now is where Resume continues from.'
                              : 'Auto is running this worktree’s stages.'}
                        </p>
                      )}
                    </>
                  )}
                  <div className="review-context">
                    <strong>{reviewTask?.title ?? 'Main worktree'}</strong>
                    <code>
                      {source?.branch ??
                        (source ? `detached ${shortSha(source.head)}` : 'Resolving branch…')}
                    </code>
                    <span>
                      {base ? `Changes since merge base with ${base}` : 'Uncommitted changes'}
                    </span>
                    {source?.path && (
                      <details>
                        <summary>Worktree location</summary>
                        <code>{source.path}</code>
                      </details>
                    )}
                  </div>
                  <div className="review-title-row">
                    <span className="review-totals">
                      {review && shownFiles.length > 0 && <DiffStat {...totals} />}
                    </span>
                    <button
                      className={`review-agent-button${nextMerge || nextFix ? '' : ' primary'}`}
                      disabled={!source?.branch}
                      onClick={() => setReviewDialogScope(dialogScope)}
                    >
                      Review branch…
                    </button>
                    <button
                      className={`review-merge-button${nextMerge ? ' primary' : ''}`}
                      disabled={!canMerge}
                      title={
                        canMerge
                          ? 'Merge the reviewed branch into another local branch'
                          : 'Merging requires another local branch'
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
                      aria-label="Refresh review"
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
                {error && (
                  <PanelStatus
                    kind="error"
                    message="Could not load changes."
                    details={error}
                    onRetry={() => {
                      setRefresh((n) => n + 1)
                      setWorktreeRefresh((n) => n + 1)
                    }}
                  />
                )}
                {!review && !error && <PanelStatus kind="loading" message="Loading changes…" />}
                {review && !groups.length && (
                  <div className="review-empty">
                    <div className="review-empty-mark">✓</div>
                    {base ? `No changes since merge base with ${base}.` : 'No uncommitted changes.'}
                  </div>
                )}
                {shown.map((g) => {
                  const open = !collapsed[g.id]
                  return (
                    <ChangeGroupCard
                      key={g.id}
                      group={g}
                      open={open}
                      onToggle={() => setCollapsed({ ...collapsed, [g.id]: open })}
                      onSelectComponent={() => select(g.id)}
                      task={validationTask}
                    >
                      <ChangeList
                        files={g.files}
                        base={g.base}
                        selected={
                          !history && pane !== 'findings' && current?.componentId === g.id
                            ? current.path
                            : undefined
                        }
                        onSelect={(path) => {
                          setHistory(null)
                          setSelected({ componentId: g.id, path })
                          setPane('diff')
                        }}
                        onStep={step}
                        task={null}
                        worktree={target}
                      />
                    </ChangeGroupCard>
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
                          <ValidationChips
                            componentId={a.id}
                            changedAt={latestChangeOf(review.changes, a.via)}
                            task={validationTask}
                          />
                        </section>
                      )
                    })}
                  </>
                )}
              </div>
            </Panel>
            <Separator className="separator" />
            <Panel id="ReviewView-pane-2" defaultSize="62" minSize="30">
              <div ref={pane === 'findings' ? undefined : diffPane} className="review-pane">
                {history && pane === 'diff' ? (
                  <CommitDetails
                    onSelect={setHistory}
                    selection={history}
                    worktree={chosen?.worktree}
                  />
                ) : pane === 'findings' ? (
                  <FindingsPanel
                    loaded={findings}
                    status={status}
                    branch={source?.branch}
                    onOpenFile={openRef}
                    canOpen={() => true}
                    actions={
                      reviewRecord && (
                        <FixFindingsButton
                          record={reviewRecord}
                          hasFindings={!!findings?.findings?.text.trim()}
                          primary={nextFix}
                        />
                      )
                    }
                  />
                ) : pane === 'fromFindings' ? (
                  <div className="review-diff-pane">
                    <div className="review-diff-back">
                      <button onClick={() => setPane('findings')}>← Findings</button>
                    </div>
                    {findingRef && !changedFile(findingRef.path) ? (
                      <div className="hint">
                        Diff unavailable: {findingRef.path} is no longer changed in this comparison.
                      </div>
                    ) : (
                      current && (
                        <DiffView
                          base={base}
                          lineFocus={findingRef?.line}
                          componentId={current.componentId}
                          file={currentFile}
                          revision={review}
                          worktree={target}
                          nav={nav}
                        />
                      )
                    )}
                  </div>
                ) : current ? (
                  <DiffView
                    base={base}
                    componentId={current.componentId}
                    file={currentFile}
                    revision={review}
                    worktree={target}
                    nav={nav}
                  />
                ) : (
                  <div className="diff-view">
                    {review && !error && (
                      <div className="review-empty">
                        {base
                          ? `No changes since merge base with ${base}.`
                          : 'No uncommitted changes.'}
                      </div>
                    )}
                  </div>
                )}
              </div>
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
