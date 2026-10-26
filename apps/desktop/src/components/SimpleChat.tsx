import { useEffect, useId, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { PLAN_SCOPE, REVIEW_SCOPE, isReservedScope, type SessionRecord } from '../types'
import { SIMPLE_STAGES, thread, type SimpleStage } from '../lib/simple'
import { logSimple } from '../lib/simpleActions'
import type { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { changeGroups } from '../lib/changeGroups'
import { simpleKey, stageOpen, pendingInput, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import { terminalStatus } from '../lib/display'
import { revealTerminal } from '../lib/attention'
import { openComponentWindow } from '../lib/windows'
import { implementPlannerPlan } from '../lib/planHandoff'
import { fixReviewFindings } from '../lib/reviewHandoff'
import { chatRolePresets, roleDevice } from '../lib/agentRoles'
import { reviewState, reviewWorktreeBusy, useRunningReviewLanes } from '../lib/reviewAgents'
import { graphActionIn } from '../lib/actions'
import {
  missingHooks,
  sessionReportedHooks,
  openIntegrations,
  useAgentHooksInstalled,
  usePresetProviders,
  type HookProvider,
} from '../lib/agentHooks'
import FindingsPanel, { VerdictBadge, SeverityCounts } from './findings/FindingsPanel'
import ValidationChips from './changes/ValidationChips'
import { latestChange, latestChangeOf } from '../lib/review'
import ReviewAgentDialog from './ReviewAgentDialog'
import MergeAgentDialog from './MergeAgentDialog'
import SimpleComposer from './SimpleComposer'
import SimpleAgent from './SimpleAgent'
import SimpleStatus from './SimpleStatus'
import './simple.css'

const pendingActions = new Set<string>()

export default function SimpleChat({ reader }: { reader: ReturnType<typeof useSimpleData> }) {
  const s = useStore(
    useShallow((s) => ({
      project: s.project,
      activeTask: s.activeTask,
      tasks: s.tasks,
      nodes: s.nodes,
      sessionRecords: s.sessionRecords,
      sessions: s.sessions,
      simple: s.simple,
      auto: s.auto,
      devices: s.devices,
      agentRoles: s.agentRoles,
      graphActionBusy: s.graphActionBusy,
      setActiveSession: s.setActiveSession,
      select: s.select,
      toProject: s.toProject,
    })),
  )
  const { data, source, error, findings } = reader
  const key = simpleKey(s.project?.id, s.activeTask)
  const [pending, setPending] = useState(''),
    [failure, setFailure] = useState<{ action: string; text: string }>()
  const [dialog, setDialog] = useState<'review' | 'merge'>()
  const stageContentId = useId()
  const runningReview = useRunningReviewLanes(source?.branch)
  const filter = useSimpleUi((u) => u.worktrees[key]?.stageFilter ?? 'all')
  const stageUi = useSimpleUi(
    useShallow((u) => ({
      stages: u.worktrees[key]?.stages ?? EMPTY_SIMPLE_UI.stages,
      inputRequests: u.worktrees[key]?.inputRequests ?? EMPTY_SIMPLE_UI.inputRequests,
      expandedAgents: u.worktrees[key]?.expanded ?? EMPTY_SIMPLE_UI.expanded,
    })),
  )
  // The stage holding keyboard focus, which an advance must not fold out from under the user.
  const [focusedStage, setFocusedStage] = useState<SimpleStage>()
  const threadRef = useRef<HTMLDivElement>(null)
  // A new filter starts at the top, unless an input request or answer needs to stay in view.
  // Only actual changes scroll, so mounting never undoes an agent's own scroll into view.
  const shownFilter = useRef(filter)
  useEffect(() => {
    if (shownFilter.current === filter) return
    shownFilter.current = filter
    const thread = threadRef.current
    // A filter can unmount the focused control without a blur reaching its section.
    if (!thread?.contains(document.activeElement)) setFocusedStage(undefined)
    const asking = thread?.querySelector('.simple-agent[data-input-open]')
    if (asking) asking.scrollIntoView({ block: 'nearest' })
    else thread?.scrollTo({ top: 0 })
  }, [filter])
  useEffect(() => {
    const current = useStore.getState()
    if (current.project && !current.simple)
      current.patchTask(current.project.id, current.activeTask, {
        simple: { startedMs: Date.now(), log: [] },
      })
  }, [s.project, s.activeTask, s.simple])
  const roleProviders = usePresetProviders(chatRolePresets(s.devices, s.agentRoles))
  const projectId = s.project?.id ?? '',
    task = s.activeTask
  const worktree = {
    projectId,
    task,
    path: source?.path ?? s.tasks.find((t) => t.id === task)?.worktree ?? s.project?.root ?? '',
    branch: source?.branch,
  }
  const model = thread(
    { records: s.sessionRecords, sessions: s.sessions, simple: s.simple, auto: s.auto, ...data },
    worktree,
  )
  // Share a single status with filtering, disclosures, cards and labels.
  const stageSections = model.sections.map((section) => {
    const agents = section.sessions.map((record) => {
      const status = terminalStatus('agent', s.sessions[record.id])
      const input = pendingInput(
        record.id,
        s.sessions[record.id],
        status,
        stageUi.inputRequests[record.id],
      )
      return { record, status, input }
    })
    return {
      ...section,
      agents,
      asking: agents.some(({ status }) => status.health === 'input'),
      inputOpen: agents.some(({ input }) => !!input),
    }
  })
  // A string, so the store is synced only when the requests or the agents asking change.
  const inputSync = JSON.stringify(
    stageSections.flatMap(({ agents }) =>
      agents.flatMap(({ record, input, status }) =>
        input ? [[record.id, input, status.health === 'input']] : [],
      ),
    ),
  )
  useEffect(() => {
    if (!projectId) return
    const requests = JSON.parse(inputSync) as [string, string, boolean][]
    useSimpleUi.getState().syncInputRequests(
      key,
      Object.fromEntries(requests.map(([sid, run]) => [sid, run])),
      requests.flatMap(([sid, , asking]) => (asking ? [sid] : [])),
    )
  }, [key, projectId, inputSync])
  if (!s.project) return null
  // Keep requests and partially typed answers visible whatever the filter.
  const sections = stageSections.filter(
    (section) => filter === 'all' || section.id === filter || section.inputOpen,
  )
  const groups = changeGroups(s.nodes, data?.review)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const busy = reviewWorktreeBusy(model.records, s.sessions, worktree.path)
  const status = reviewState(findings?.findings, source)
  const planner =
    model.records.filter((r) => r.metadata.componentId === PLAN_SCOPE).at(-1)?.metadata
      .terminalId ?? roleDevice(s.devices, s.agentRoles, 'plan').id
  // Agents that run or would: the chat's running sessions and the presets its roles launch.
  const running = model.records.filter((r) => s.sessions[r.id]?.running)
  const hookProviders = [...running.map((r) => r.metadata.adapter), ...roleProviders].flatMap(
    (p) => p ?? [],
  )
  // Native reporting proves hooks even after Esc temporarily revokes readiness.
  const reporting = new Set(
    running.flatMap((r) =>
      sessionReportedHooks(s.sessions[r.id]) ? (r.metadata.adapter ?? []) : [],
    ),
  )
  const run = async (
    action: 'implement' | 'fix' | 'validate',
    stage: SimpleStage,
    fn: () => Promise<string | void>,
  ) => {
    const actionKey = `${key}:${action}`
    if (pendingActions.has(actionKey)) return
    pendingActions.add(actionKey)
    setPending(action)
    setFailure(undefined)
    try {
      const sid = await fn()
      logSimple(projectId, task, {
        kind: 'action',
        action,
        stage,
        sessionId: sid ?? undefined,
        generation: sid ? useStore.getState().sessions[sid]?.generation : undefined,
      })
    } catch (e) {
      setFailure({ action, text: String(e) })
    } finally {
      pendingActions.delete(actionKey)
      setPending('')
    }
  }
  const openTerminal = (record: SessionRecord) => {
    if (!isReservedScope(record.metadata.componentId)) {
      s.setActiveSession(record.id)
      void openComponentWindow(
        record.metadata.componentId,
        s.nodes.find((n) => n.id === record.metadata.componentId)?.data.name ??
          record.metadata.name,
        projectId,
      ).catch((e) => setFailure({ action: 'terminal', text: String(e) }))
    } else revealTerminal({ sid: record.id, componentId: record.metadata.componentId })
  }
  const openFile = (path: string, line?: number) => {
    const files = groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
    const exact = files.find((f) => f.path === path)
    const suffix = files.filter((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`))
    const match = exact ?? (suffix.length === 1 ? suffix[0] : undefined)
    useSimpleUi.getState().patch(key, {
      diff: { componentId: match?.componentId ?? '@project', path: match?.path ?? path, line },
    })
  }
  const errorFor = (action: string) =>
    failure?.action === action && <p role="alert">{failure.text}</p>
  return (
    <div className="simple-chat">
      <header>
        <strong>Worktree chat</strong>
        <span>{source?.branch ?? 'Project folder'}</span>
      </header>
      <nav className="simple-stage-tabs" aria-label="Chat stages">
        {(['all', ...SIMPLE_STAGES] as const).map((stage) => (
          <button
            key={stage}
            aria-pressed={filter === stage}
            onClick={() => useSimpleUi.getState().patch(key, { stageFilter: stage })}
          >
            {stage[0].toUpperCase() + stage.slice(1)}
            {model.stage === stage && (
              <span className="current-stage-dot" aria-label="Current stage">
                ●
              </span>
            )}
          </button>
        ))}
      </nav>
      <ActivityHooksNotice providers={hookProviders} reporting={reporting} />
      {error && <p role="alert">{error}</p>}
      {source && dialog === 'review' && (
        <ReviewAgentDialog
          source={source}
          worktrees={data?.worktrees ?? []}
          close={() => setDialog(undefined)}
          launched={(sid) => {
            logSimple(projectId, task, {
              kind: 'action',
              action: 'review',
              stage: 'review',
              sessionId: sid,
              generation: useStore.getState().sessions[sid]?.generation,
            })
            setDialog(undefined)
          }}
        />
      )}
      {source && dialog === 'merge' && (
        <MergeAgentDialog
          source={source}
          worktrees={data?.worktrees ?? []}
          findings={findings}
          close={() => setDialog(undefined)}
          onRequest={(request, sid) =>
            logSimple(projectId, task, {
              kind: 'action',
              action: 'merge',
              stage: 'merge',
              request,
              sessionId: sid,
              generation: useStore.getState().sessions[sid]?.generation,
            })
          }
          launched={() => setDialog(undefined)}
        />
      )}
      <div className="simple-thread" ref={threadRef}>
        {sections.map((section) => {
          const { asking } = section
          // Focus or an inline terminal opened here keeps the stage open as the thread advances.
          const inUse =
            focusedStage === section.id ||
            section.agents.some(({ record }) => stageUi.expandedAgents.includes(record.id))
          const expanded =
            filter !== 'all' ||
            section.inputOpen ||
            stageOpen(stageUi.stages, section.id, model.stage, inUse)
          const contentId = `${stageContentId}-${section.id}`
          const label = section.id[0].toUpperCase() + section.id.slice(1)
          return (
            <section
              className="simple-stage"
              key={section.id}
              aria-current={model.stage === section.id ? 'step' : undefined}
              data-collapsed={!expanded || undefined}
              onFocusCapture={() => {
                if (expanded) setFocusedStage(section.id)
              }}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setFocusedStage((stage) => (stage === section.id ? undefined : stage))
              }}
            >
              <h2>
                {filter === 'all' ? (
                  <button
                    className="simple-stage-toggle"
                    aria-expanded={expanded}
                    aria-controls={contentId}
                    aria-disabled={asking || undefined}
                    aria-describedby={asking ? `${contentId}-asking` : undefined}
                    title={asking ? 'An agent is waiting for input' : undefined}
                    onClick={() => {
                      if (asking) return
                      useSimpleUi.getState().toggleStage(key, section.id, model.stage, {
                        inputs: section.agents
                          .filter(({ input }) => !!input)
                          .map(({ record }) => record.id),
                        inUse,
                      })
                    }}
                  >
                    <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {label}
                  </button>
                ) : (
                  label
                )}
                {asking && filter === 'all' && (
                  <span id={`${contentId}-asking`} hidden>
                    Stays open while an agent is waiting for input
                  </span>
                )}
                {!expanded && (
                  <SimpleStatus
                    sessions={section.agents.map(({ record }) => s.sessions[record.id])}
                    folded
                  />
                )}
              </h2>
              <div id={contentId} hidden={!expanded}>
                {section.id === 'plan' && (
                  <article>
                    <h3>Project plan · shared across worktree chats</h3>
                    <Markdown text={data?.plan.text || 'No saved plan yet.'} />
                    {data?.proposal && <Markdown text={data.proposal.plan} />}
                    <button
                      disabled={!model.planReady || !!pending}
                      onClick={() =>
                        void run('implement', 'build', () =>
                          implementPlannerPlan(planner, undefined, undefined, 'stay'),
                        )
                      }
                    >
                      Implement
                    </button>
                    {errorFor('implement')}
                  </article>
                )}
                {section.id === 'build' && (
                  <>
                    <article>
                      <h3>Accepted worktree plan</h3>
                      <Markdown
                        text={
                          task
                            ? data?.acceptedPlan.text || 'No accepted plan yet.'
                            : data?.acceptedPlan.text || 'No saved plan yet.'
                        }
                      />
                    </article>
                    <article>
                      <h3>Changes</h3>
                      {groups.length ? (
                        groups.map((g) => (
                          <div key={g.id}>
                            <strong>{g.name}</strong>
                            {g.id !== '@project' && (
                              <ValidationChips
                                componentId={g.id}
                                changedAt={latestChange(g.files)}
                                task={task}
                              />
                            )}
                            {g.files.map((f) => (
                              <button
                                className="simple-file"
                                key={f.path}
                                onClick={() => openFile(f.path)}
                              >
                                {f.path}
                              </button>
                            ))}
                          </div>
                        ))
                      ) : (
                        <p>No uncommitted changes.</p>
                      )}
                      <button
                        disabled={!source?.branch || busy || !!pending}
                        onClick={() => setDialog('review')}
                      >
                        Review…
                      </button>
                    </article>
                    {!!data && (groups.length > 0 || data.review.affected.length > 0) && (
                      <article>
                        <h3>May affect</h3>
                        {data.review.affected.map((a) => (
                          <div key={a.id}>
                            <button onClick={() => s.select(a.id)}>
                              {s.nodes.find((n) => n.id === a.id)?.data.name ?? a.id}
                            </button>
                            <ValidationChips
                              componentId={a.id}
                              changedAt={latestChangeOf(data.review.changes, a.via)}
                              task={task}
                            />
                          </div>
                        ))}
                        <button
                          disabled={s.graphActionBusy || !!pending}
                          onClick={() =>
                            void run('validate', 'build', async () => {
                              await graphActionIn(projectId, task, s.toProject(), {
                                kind: 'validateChanged',
                                componentIds: groups
                                  .filter((g) => g.id !== '@project')
                                  .map((g) => g.id),
                              })
                            })
                          }
                        >
                          Run validation
                        </button>
                        {errorFor('validate')}
                      </article>
                    )}
                  </>
                )}
                {section.id === 'review' && (
                  <article>
                    <h3>
                      Findings{' '}
                      {findings?.findings && (
                        <>
                          <VerdictBadge findings={findings.findings} running={runningReview} />
                          <SeverityCounts findings={findings.findings} />
                        </>
                      )}
                    </h3>
                    <FindingsPanel
                      loaded={findings}
                      branch={source?.branch}
                      status={status}
                      onOpenFile={(ref) => openFile(ref.path, ref.line)}
                      canOpen={() => true}
                    />
                    {!!findings?.findings?.text.trim() &&
                      !findings.findings.verdict?.clean &&
                      reviewer && (
                        <button
                          disabled={busy || !!pending}
                          onClick={() =>
                            void run('fix', 'build', () =>
                              fixReviewFindings(reviewer, undefined, undefined, 'stay'),
                            )
                          }
                        >
                          Fix findings
                        </button>
                      )}
                    {errorFor('fix')}
                    <button
                      disabled={
                        busy ||
                        !!pending ||
                        status !== 'current' ||
                        !findings?.findings?.verdict?.clean ||
                        !source?.branch
                      }
                      onClick={() => setDialog('merge')}
                    >
                      Merge…
                    </button>
                  </article>
                )}
                {section.id === 'merge' && (
                  <article>
                    {data?.outcome ??
                      (data?.outcomeError
                        ? `Merge status unavailable: ${data.outcomeError}`
                        : 'Choose a merge destination after review.')}
                  </article>
                )}
                {section.entries.map((entry) => (
                  <article className="simple-entry" key={entry.id}>
                    <time>{new Date(entry.atMs).toLocaleTimeString()}</time>
                    {entry.kind === 'prompt' ? (
                      <>
                        <strong>You</strong>
                        <pre>{entry.text}</pre>
                        {entry.mentions.map((id) => (
                          <span className="simple-scope-chip" key={id}>
                            {s.nodes.find((n) => n.id === id)?.data.name ?? id}
                          </span>
                        ))}
                      </>
                    ) : (
                      entry.action
                    )}
                  </article>
                ))}
                {section.agents.map(({ record, status, input }) => (
                  <SimpleAgent
                    key={record.id}
                    record={record}
                    status={status}
                    inputOpen={!!input}
                    scopeKey={key}
                    openTerminal={openTerminal}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      {errorFor('terminal')}
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        openTerminal={openTerminal}
      />
    </div>
  )
}

/** Activity lists and map pulses come from hooks: says so while a chat agent's provider lacks them. */
function ActivityHooksNotice({
  providers,
  reporting,
}: {
  providers: HookProvider[]
  reporting: ReadonlySet<HookProvider>
}) {
  const hooks = useAgentHooksInstalled(providers)
  const missing = missingHooks(providers, hooks, reporting)
  if (!missing) return null
  return (
    <p className="simple-hook-notice">
      {missing.check === false
        ? 'Live tool activity needs Agent status integration.'
        : 'Agent status integration couldn’t be checked, so live tool activity may be missing.'}{' '}
      <button onClick={() => openIntegrations(missing.provider)}>Set up…</button>
    </p>
  )
}
