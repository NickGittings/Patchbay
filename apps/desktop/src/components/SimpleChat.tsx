import ChatCoordination from './ChatCoordination'
import { useChatIdentity } from '../lib/chatIdentity'
import { useChatTeams, resetLead, controlTeam } from '../lib/chatTeams'
import { changedFileRef } from '../lib/review'
import { profileHookProvider } from '../lib/agentProfiles'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { PLAN_SCOPE, REVIEW_SCOPE, type MergeRequest, type SessionRecord } from '../types'
import {
  recordStage,
  pendingLaunch,
  LAUNCH_RECORD_GRACE_MS,
  sections,
  thread,
  type SimpleAction,
  type SimpleStage,
} from '../lib/simple'
import { flow, type FlowAction } from '../lib/simpleFlow'
import { clearSimpleChat, logLaunch, logSimple } from '../lib/simpleActions'
import type { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { useExpiredDeadline } from '../lib/clock'
import { simpleKey, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import { implementPlannerPlan } from '../lib/planHandoff'
import { fixReviewFindings } from '../lib/reviewHandoff'
import { chatRolePresets, roleDevice, roleDevices } from '../lib/agentRoles'
import {
  defaultMergeDestination,
  chatReviewBase,
  reviewState,
  startMergeAgent,
  useRunningReviewLanes,
} from '../lib/reviewAgents'
import { simpleReviewRequest, startSimpleReview, type StartedReviewer } from '../lib/simpleReview'
import { gitBranches, gitWorktrees, mergeConflicts } from '../lib/ipc'
import { mergeNow, resumeAuto } from '../lib/auto'
import {
  missingHooks,
  sessionReportedHooks,
  openIntegrations,
  useAgentHooksInstalled,
  usePresetProviders,
  type HookProvider,
} from '../lib/agentHooks'
import FindingsPanel, { VerdictBadge, SeverityCounts } from './findings/FindingsPanel'
import ReviewAgentDialog from './ReviewAgentDialog'
import MergeAgentDialog from './MergeAgentDialog'
import SimpleComposer from './SimpleComposer'
import SimpleAgent from './SimpleAgent'
import TerminalPane from './TerminalPane'
import ChatQuestion from './ChatQuestion'
import ChatAgentPicker from './ChatAgentPicker'
import {
  chatRecipient,
  chatHandoff,
  chatBusy,
  chatAutoActive,
  chatInputRequests,
} from '../lib/chat'
import { autoDrafts, autoDraftKey, emptyAutoDraft } from '../lib/autoDrafts'
import { pauseAuto, stopAuto } from '../lib/auto'
import './simple.css'

const pendingActions = new Set<string>()
export default function SimpleChat({
  reader,
  onHide,
}: {
  reader: ReturnType<typeof useSimpleData>
  onHide: () => void
}) {
  const s = useStore(
    useShallow((s) => ({
      project: s.project,
      activeTask: s.activeTask,
      tasks: s.tasks,
      sessionRecords: s.sessionRecords,
      sessions: s.sessions,
      simple: s.simple,
      auto: s.auto,
      devices: s.devices,
      agentRoles: s.agentRoles,
      revealed: s.revealed,
    })),
  )
  const {
    data,
    source,
    worktrees,
    branches,
    scope: worktree,
    files: changed,
    error,
    findings,
  } = reader
  const key = simpleKey(s.project?.id, s.activeTask)
  const team = useChatTeams((state) =>
    state.teams[s.project?.id ?? '']?.find((t) => t.task === s.activeTask),
  )
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const [pendingResult, setPendingResult] = useState({ key: '', action: '' })
  const pending = pendingResult.key === key ? pendingResult.action : ''
  const [failureResult, setFailureResult] = useState({ key: '', text: '' })
  const failure = failureResult.key === key ? failureResult.text : ''
  const setFailure = (text: string) => setFailureResult({ key, text })
  const [dialog, setDialog] = useState<'review' | 'merge'>()
  const [check, setCheck] = useState<{ key: string; paths: string[] }>()
  const [clearKey, setClearKey] = useState<string>()
  if (clearKey !== undefined && clearKey !== key) setClearKey(undefined)
  const threadRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const projectId = s.project?.id ?? '',
    task = s.activeTask
  const snapshot = {
    records: s.sessionRecords,
    sessions: s.sessions,
    simple: s.simple,
    auto: s.auto,
    ...data,
    findings: findings?.findings,
    createdMs: s.tasks.find((t) => t.id === task)?.createdMs,
  }
  const model = thread(snapshot, worktree)
  const launch = pendingLaunch(snapshot, model.records)
  const now = useExpiredDeadline(launch ? launch.atMs + LAUNCH_RECORD_GRACE_MS : undefined)
  const target = worktrees.find(
    (w) => w.branch === (source && defaultMergeDestination(source, worktrees, branches)),
  )
  const merging = model.records.filter((r) => recordStage(r) === 'merge').at(-1)
  const mergeBase =
    model.stage === 'merge'
      ? worktrees.find((w) => w.path === merging?.spec.cwd)?.branch
      : undefined
  const base = chatReviewBase(source, s.tasks, worktrees, branches, mergeBase)
  const reviewBase = chatReviewBase(
    source,
    s.tasks,
    worktrees,
    branches,
    findings?.findings?.base || mergeBase,
  )
  const checkKey = JSON.stringify([key, source?.head, target?.head])
  const recipient = chatRecipient(model.records, s.simple?.selectedAgent)
  const state = flow(
    {
      ...snapshot,
      worktree,
      findings: findings?.findings,
      base: base ?? undefined,
      conflicts: check?.key === checkKey ? check.paths : undefined,
      now,
    },
    model,
  )
  const questions = chatInputRequests(
    model.records.filter(
      (r) => !model.foreign.has(r.id) && (!team || r.id === team.lead.sessionId),
    ),
    s.sessions,
    ui.inputRequests,
  )
  const inputKey = JSON.stringify(questions)
  useEffect(() => {
    const previous = useSimpleUi.getState().worktrees[key]?.inputRequests ?? []
    if (JSON.stringify(previous) !== inputKey)
      useSimpleUi.getState().patch(key, { inputRequests: JSON.parse(inputKey) })
  }, [key, inputKey])
  const drawerRecord = ui.terminalSession
    ? model.records.find((r) => r.id === ui.terminalSession?.id)
    : recipient
  const drawerShown = ui.terminal !== 'closed' && !!drawerRecord
  const drawerIdentity = useChatIdentity(drawerRecord)
  const runningReview = useRunningReviewLanes(source?.branch)
  const roleProviders = usePresetProviders(chatRolePresets(s.devices, s.agentRoles))
  const running = model.records.filter((r) => s.sessions[r.id]?.running)
  const hookProviders = [
    ...running.map((r) => profileHookProvider(r.spec.command) ?? r.metadata.adapter),
    ...roleProviders,
  ].flatMap((p) => p ?? [])
  const reporting = new Set(
    running.flatMap((r) =>
      sessionReportedHooks(s.sessions[r.id])
        ? (profileHookProvider(r.spec.command) ?? r.metadata.adapter ?? [])
        : [],
    ),
  )
  useEffect(() => {
    const current = useStore.getState()
    if (current.project && !current.simple)
      current.patchTask(current.project.id, current.activeTask, {
        simple: { startedMs: Date.now(), log: [] },
      })
  }, [s.project, s.activeTask, s.simple])
  // What can grow the thread, without serializing its records or reply texts on every render.
  const contentKey = JSON.stringify([
    model.items.map((i) =>
      i.kind === 'agent'
        ? `${i.id}:${i.entries.length}`
        : i.kind === 'plan'
          ? `${i.id}:${i.text.length}:${i.stale}`
          : `${i.id}:${i.atMs}`,
    ),
    state.step,
    state.prompt,
    inputKey,
    data?.outcome,
  ])
  useEffect(() => {
    if (atBottom.current) threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [contentKey, ui.terminal])
  useEffect(() => {
    if (!s.revealed) return
    const blocks = threadRef.current?.querySelectorAll<HTMLElement>('[data-session]')
    const block = [...(blocks ?? [])].filter((el) => el.dataset.session === s.revealed?.sid).at(-1)
    if (block) {
      const section = block.closest<HTMLDetailsElement>('details.simple-section')
      if (section) section.open = true
      block.scrollIntoView({ block: 'nearest' })
      useStore.getState().setRevealed(null)
    }
  }, [s.revealed, key, contentKey])
  useEffect(() => {
    if (ui.dismissedStep && ui.dismissedStep !== state.step)
      useSimpleUi.getState().patch(key, { dismissedStep: undefined })
  }, [key, state.step, ui.dismissedStep])
  if (!s.project) return null
  // Review's own dialog, beside the step's actions once there is work to review.
  const options = ['built', 'reviewed', 'fixed'].includes(state.step)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const planner =
    model.records
      .filter((r) => r.metadata.componentId === PLAN_SCOPE && !model.foreign.has(r.id))
      .at(-1)?.metadata.terminalId ?? roleDevice(s.devices, s.agentRoles, 'plan')?.id
  const openFile = (path: string, line?: number) => {
    const match = changedFileRef(changed, path, source?.path)
    useSimpleUi.getState().patch(key, {
      changes: true,
      diff: { componentId: match?.componentId ?? '@project', path: match?.path ?? path, line },
    })
  }
  // A launch's entry claims only the run its request started, dated at its start (`logLaunch`).
  const log = (
    action: SimpleAction,
    stage: SimpleStage,
    launched: { sessionId: string; requestId?: string },
    destinationTask = task,
  ) =>
    logLaunch(
      projectId,
      destinationTask,
      { kind: 'action', action, stage, sessionId: launched.sessionId },
      launched.requestId,
      { atRunStart: true },
    )
  const logReviewers = (reviewers: StartedReviewer[]) =>
    Promise.all(reviewers.map((r) => log('review', 'review', r)))
  const logMerge = (request: MergeRequest, sid: string, requestId: string) =>
    logLaunch(
      projectId,
      task,
      { kind: 'action', action: 'merge', stage: 'merge', request, sessionId: sid },
      requestId,
    )
  const run = async (action: string, fn: () => Promise<void>) => {
    const lock = key
    if (pendingActions.has(lock)) return
    pendingActions.add(lock)
    useSimpleUi.getState().patch(key, { pendingWorkflow: true })
    setPendingResult({ key, action })
    setFailure('')
    try {
      await fn()
    } catch (e) {
      setFailure(String(e))
    } finally {
      pendingActions.delete(lock)
      useSimpleUi.getState().patch(key, { pendingWorkflow: false })
      setPendingResult((current) => (current.key === key ? { key, action: '' } : current))
    }
  }
  const build = async (destinationTask = task) => {
    const current = useStore.getState()
    if (current.project?.id !== projectId || current.activeTask !== destinationTask)
      throw new Error('The worktree changed. Choose Build in the intended chat.')
    const launched = await implementPlannerPlan(planner, undefined, undefined, 'stay')
    await log('implement', 'build', launched, destinationTask)
  }
  const act = (action: FlowAction) =>
    void run(action, async () => {
      if (action === 'build') {
        await build()
      } else if (action === 'plan') {
        threadRef.current
          ?.closest('.simple-chat')
          ?.querySelector<HTMLTextAreaElement>('textarea')
          ?.focus()
      } else if (action === 'review') {
        // Without a base, Options asks for one; the review starts from that dialog.
        if (source?.branch && !reviewBase) {
          setDialog('review')
          return
        }
        const branches = await gitBranches(projectId)
        const current = useStore.getState()
        if (current.project?.id !== projectId || current.activeTask !== task)
          throw new Error('The worktree changed. Choose Review in the intended chat.')
        const request = simpleReviewRequest(source, reviewBase, branches)
        if (!request) {
          setDialog('review')
          return
        }
        const { started, errors } = await startSimpleReview(
          current.toProject(),
          request,
          roleDevices(s.devices, s.agentRoles, 'review'),
        )
        await logReviewers(started)
        if (errors.length) setFailure(errors.join('\n'))
      } else if (action === 'fix' && reviewer) {
        await log('fix', 'build', await fixReviewFindings(reviewer, undefined, undefined, 'stay'))
      } else if (action === 'checkMerge') {
        if (!target?.branch || !source?.branch) {
          setDialog('merge')
          return
        }
        const trees = await gitWorktrees(projectId)
        const from = trees.find((w) => w.path === source.path)
        const to = trees.find((w) => w.path === target.path)
        if (!from || !to)
          throw new Error('The merge worktrees changed. Choose a destination again.')
        const paths = await mergeConflicts(projectId, from.head, to.head)
        setCheck({ key: JSON.stringify([key, from.head, to.head]), paths })
      } else if (action === 'merge' && !target?.branch) {
        setDialog('merge')
      } else if (action === 'merge' && source?.branch && target?.branch) {
        const request = {
          source: source.path,
          sourceBranch: source.branch,
          destination: target.path,
          destinationBranch: target.branch,
        }
        const requestId = crypto.randomUUID()
        const sid = await startMergeAgent(
          useStore.getState().toProject(),
          request,
          roleDevice(s.devices, s.agentRoles, 'merge'),
          requestId,
        )
        await logMerge(request, sid, requestId)
      } else if (action === 'resumeAuto') {
        await resumeAuto(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'resumeAuto', stage: model.stage })
      } else if (action === 'mergeApproval') {
        mergeNow(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'mergeApproval', stage: 'merge' })
      }
    })
  // Until this launch's run reconciles (or its grace expires), an old slot's result is history.
  const items =
    launch && now === undefined
      ? model.items.filter((i) => i.kind !== 'result' || i.result !== launch.stage)
      : model.items
  const grouped = sections(items, model.records)
  const stepHeading = state.prompt?.actions.some((a) => a.action === 'resumeAuto')
    ? 'Continue Auto mode'
    : state.prompt?.actions.some((a) => a.action === 'mergeApproval')
      ? 'Merge'
      : state.prompt?.actions.some((a) => ['merge', 'checkMerge'].includes(a.action))
        ? state.prompt.actions.some((a) => ['review', 'fix'].includes(a.action))
          ? 'Review and merge'
          : 'Merge'
        : state.step === 'planReady'
          ? 'Planning'
          : state.step === 'merged'
            ? 'Merge complete'
            : 'Review'
  const launching = ['build', 'fix', 'review', 'merge'].includes(pending)
  return (
    <div className="simple-chat">
      <header>
        <strong>Chat</strong>
        <ChatAgentPicker key={key} records={model.records} />
        <button
          disabled={
            !!ui.pendingAction || !!ui.queued || chatBusy(recipient && s.sessions[recipient.id])
          }
          title="Finish or stop the current agent turn before handing off"
          onClick={() => {
            if (s.auto && ['running', 'waitingOnYou', 'paused'].includes(s.auto.status)) {
              useStore.getState().showAutoPanel()
              return
            }
            const draftKey = autoDraftKey(projectId, task)
            autoDrafts.set(draftKey, {
              ...(autoDrafts.get(draftKey) ?? emptyAutoDraft()),
              goal: chatHandoff(
                s.simple,
                source?.branch ?? 'Project folder',
                changed.map((f) => f.path),
              ),
              autonomous: true,
            })
            useStore.setState((s) => ({ autoDraftVersion: s.autoDraftVersion + 1 }))
            useStore.getState().showAutoPanel()
          }}
        >
          Auto mode
        </button>
        <details className="chat-menu">
          <summary aria-label="Chat menu">•••</summary>
          <div className="chat-menu-items">
            {team && (
              <div>
                <button
                  disabled={!!pending || team.state !== 'running'}
                  onClick={() =>
                    void run('pause', async () => {
                      await controlTeam(team, { kind: 'pause' })
                      if (chatAutoActive(s.auto?.status)) pauseAuto(projectId, task)
                    })
                  }
                >
                  Pause work
                </button>
                <button
                  disabled={!!pending || team.state === 'running'}
                  onClick={() =>
                    void run('continue', async () => {
                      await controlTeam(team, { kind: 'resume' })
                      if (s.auto?.status === 'paused') await resumeAuto(projectId, task)
                    })
                  }
                >
                  Continue work
                </button>
                <button
                  disabled={!!pending || team.state === 'stopped'}
                  onClick={() =>
                    void run('stop', async () => {
                      await controlTeam(team, { kind: 'stop' })
                      if (s.auto && !['done', 'stopped'].includes(s.auto.status))
                        stopAuto(projectId, task)
                    })
                  }
                >
                  Stop work
                </button>
              </div>
            )}
            {team && (
              <button
                disabled={!!team.reset || !!ui.pendingAction || !!ui.pendingWorkflow}
                title="Start a fresh provider conversation. Workers and a concise work handoff are retained."
                onClick={() =>
                  void run('reset', async () => {
                    await resetLead(team)
                  })
                }
              >
                Clear conversation
              </button>
            )}
            <button
              disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
              onClick={() => setClearKey(key)}
              title="Clear Patchbay’s saved history. Provider transcripts and terminal history remain available."
            >
              Clear chat
            </button>
          </div>
        </details>
        <button
          className="inspector-close simple-hide-chat"
          aria-label="Hide chat"
          title="Hide chat"
          onClick={onHide}
        >
          ×
        </button>
      </header>
      {clearKey === key && (
        <div className="simple-clear-confirm" role="group" aria-label="Clear chat confirmation">
          <span>Clear this worktree’s chat history? Agents keep their context.</span>
          <button
            disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
            onClick={async () => {
              const current = useStore.getState()
              if (
                simpleKey(current.project?.id, current.activeTask) !== clearKey ||
                pendingActions.has(key) ||
                useSimpleUi.getState().worktrees[key]?.pendingAction
              )
                return
              try {
                if (team) await controlTeam(team, { kind: 'historyBoundary' })
                if (clearSimpleChat(projectId, task)) setClearKey(undefined)
              } catch (error) {
                setFailure(String(error))
              }
            }}
          >
            Clear
          </button>
          <button onClick={() => setClearKey(undefined)}>Cancel</button>
        </div>
      )}
      {team && <ChatCoordination key={team.id} team={team} />}
      {s.auto && (
        <p role="status">
          Auto · {s.auto.stage} · {s.auto.status} {s.auto.reason}
          {chatAutoActive(s.auto.status) && (
            <button onClick={() => pauseAuto(projectId, task)}>Pause Auto</button>
          )}
        </p>
      )}
      <ActivityHooksNotice providers={hookProviders} reporting={reporting} />
      {error && <p role="alert">{error}</p>}
      {source && dialog === 'review' && (
        <ReviewAgentDialog
          compact
          key={`${projectId}/${source.path}/${source.branch}`}
          restartSettled
          initialBase={reviewBase || undefined}
          source={source}
          worktrees={worktrees}
          close={() => setDialog(undefined)}
          started={(reviewers) => void logReviewers(reviewers)}
          launched={() => setDialog(undefined)}
        />
      )}
      {source && dialog === 'merge' && (
        <MergeAgentDialog
          compact
          source={source}
          worktrees={worktrees}
          branches={branches}
          close={() => setDialog(undefined)}
          onRequest={(request, sid, requestId) => void logMerge(request, sid, requestId)}
          launched={() => setDialog(undefined)}
        />
      )}
      <div
        className="simple-thread"
        ref={threadRef}
        onScroll={() => {
          const el = threadRef.current!
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70
        }}
      >
        {!items.length && (
          <p className="simple-narration">
            Describe what you want to build or change. Your chat agent starts with your first
            message.
          </p>
        )}
        {grouped.map((section, sectionIndex) => {
          const content = section.items.map((item) => {
            if (item.kind === 'agent') {
              const latest = !items
                .slice(items.indexOf(item) + 1)
                .some((i) => i.kind === 'agent' && i.sessionId === item.sessionId)
              return (
                <SimpleAgent
                  key={item.id}
                  record={item.record}
                  sessionId={item.sessionId}
                  entries={item.entries}
                  latest={latest}
                  working={state.busyAgent?.id === item.sessionId}
                  openFile={(file) =>
                    useSimpleUi.getState().patch(key, { changes: true, diff: file })
                  }
                />
              )
            }
            if (item.kind === 'line')
              return (
                <p className="simple-narration" key={item.id}>
                  {item.text}
                </p>
              )
            if (item.kind === 'plan')
              return item.stale ? (
                <details className="simple-earlier-plan" key={item.id}>
                  <summary>
                    An earlier worktree plan exists
                    {item.atMs ? ` (saved ${new Date(item.atMs).toLocaleString()})` : ''} · Show
                  </summary>
                  <Markdown text={item.text} />
                </details>
              ) : (
                <article className="simple-result" key={item.id}>
                  <h3>Plan</h3>
                  <time dateTime={new Date(item.atMs).toISOString()}>
                    {new Date(item.atMs).toLocaleString()}
                  </time>
                  <Markdown text={item.text} />
                </article>
              )
            if (item.result === 'review')
              return (
                findings?.findings && (
                  <article className="simple-result" key={item.id}>
                    <h3>
                      Review <VerdictBadge findings={findings.findings} running={runningReview} />
                      <SeverityCounts findings={findings.findings} />
                    </h3>
                    <FindingsPanel
                      loaded={findings}
                      branch={source?.branch}
                      status={reviewState(findings.findings, source)}
                      onOpenFile={(ref) => openFile(ref.path, ref.line)}
                      canOpen={() => true}
                    />
                  </article>
                )
              )
            if (state.step === 'merged') return null
            return (
              <p className="simple-narration" key={item.id}>
                {data?.outcomeError ??
                  (data?.outcome === 'inProgress'
                    ? 'Merge in progress…'
                    : 'Waiting for the merge outcome…')}
              </p>
            )
          })
          return sectionIndex === grouped.length - 1 ? (
            <div key={section.id}>{content}</div>
          ) : (
            <details className="simple-section" key={section.id}>
              <summary>
                {[
                  section.title,
                  section.summary,
                  new Date(section.atMs).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </summary>
              {content}
            </details>
          )
        })}
        {questions.map((request) => {
          const record = model.records.find((r) => r.id === request.sessionId)!
          return (
            <ChatQuestion
              key={`${request.sessionId}:${request.generation}:${request.sinceMs}`}
              record={record}
            />
          )
        })}
        {launching && (
          <p className="simple-narration" role="status">
            Starting {pending === 'build' ? 'build' : pending}…
          </p>
        )}
        {failure && <p role="alert">{failure}</p>}
        {drawerShown && drawerRecord && (
          <div className="simple-terminal-drawer" aria-label={`${drawerIdentity.role} terminal`}>
            <p>
              Live activity · {drawerIdentity.label} · Preset: {drawerIdentity.preset}
            </p>
            <TerminalPane
              key={drawerRecord.id}
              componentId={drawerRecord.metadata.componentId}
              terminal={{
                id: drawerRecord.metadata.terminalId,
                name: drawerRecord.metadata.name,
                kind: 'agent',
                command: drawerRecord.spec.command,
              }}
              task={drawerRecord.metadata.task ?? null}
              existingSessionId={drawerRecord.id}
              focus={false}
            />
          </div>
        )}
      </div>
      {!launching && ui.dismissedStep !== state.step && (state.prompt || options) && (
        <section
          className="simple-step"
          data-step={state.step}
          aria-label={`${stepHeading} actions`}
        >
          <div className="simple-step-heading">
            <span className="simple-step-icon" aria-hidden="true">
              ↗
            </span>
            <h3>{stepHeading}</h3>
            <button
              className="simple-dismiss"
              aria-label="Dismiss suggestion"
              title="Dismiss suggestion"
              onClick={() => useSimpleUi.getState().patch(key, { dismissedStep: state.step })}
            >
              ×
            </button>
          </div>
          {state.prompt && <p>{state.prompt.text}</p>}
          <div className="simple-step-actions">
            {state.prompt?.actions.map((b, index) => (
              <button
                className={index === 0 ? 'primary' : undefined}
                disabled={!!pending}
                key={b.action}
                onClick={() => act(b.action)}
              >
                {b.label}
              </button>
            ))}
            {options && (
              <button
                className="simple-options"
                aria-label="Review options"
                disabled={!!pending || !!ui.pendingWorkflow || !!ui.pendingAction}
                onClick={() => setDialog('review')}
              >
                Review options…
              </button>
            )}
          </div>
        </section>
      )}
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        terminalRecord={drawerRecord}
        openTerminal={(record: SessionRecord) =>
          // A drawer whose session is gone shows nothing, so the toggle opens it in one click.
          useSimpleUi.getState().patch(key, {
            terminal: drawerShown && drawerRecord?.id === record.id ? 'closed' : 'user',
            terminalSession: {
              id: record.id,
              generation: s.sessions[record.id]?.generation,
              pinned: true,
            },
          })
        }
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
