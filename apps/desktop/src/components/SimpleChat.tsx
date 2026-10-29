import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { PLAN_SCOPE, REVIEW_SCOPE, type MergeRequest, type SessionRecord } from '../types'
import {
  recordStage,
  pendingLaunch,
  sections,
  selectRecipient,
  thread,
  type SimpleAction,
  type SimpleStage,
} from '../lib/simple'
import { flow, LAUNCH_RECORD_GRACE_MS, type FlowAction } from '../lib/simpleFlow'
import { logLaunch, logSimple } from '../lib/simpleActions'
import type { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { useExpiredDeadline } from '../lib/clock'
import { inputDrawer, simpleKey, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import { terminalStatus } from '../lib/display'
import { implementPlannerPlan } from '../lib/planHandoff'
import { fixReviewFindings } from '../lib/reviewHandoff'
import { chatRolePresets, roleDevice, roleDevices } from '../lib/agentRoles'
import {
  defaultMergeDestination,
  defaultReviewBase,
  reviewState,
  startMergeAgent,
  useRunningReviewLanes,
} from '../lib/reviewAgents'
import { simpleReviewRequest, startSimpleReview, type StartedReviewer } from '../lib/simpleReview'
import { gitWorktrees, mergeConflicts } from '../lib/ipc'
import { seedNewTask } from '../lib/tasks'
import { linkStory } from '../lib/stories'
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
import './simple.css'

const pendingActions = new Set<string>()
export default function SimpleChat({ reader }: { reader: ReturnType<typeof useSimpleData> }) {
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
  const { data, source, scope: worktree, files: changed, error, findings } = reader
  const key = simpleKey(s.project?.id, s.activeTask)
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const [pending, setPending] = useState('')
  const [failure, setFailure] = useState('')
  const [dialog, setDialog] = useState<'review' | 'merge'>()
  const [check, setCheck] = useState<{ key: string; paths: string[] }>()
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
  const target = data?.worktrees.find(
    (w) => w.path === (source && defaultMergeDestination(source, data.worktrees)),
  )
  const merging = model.records.filter((r) => recordStage(r) === 'merge').at(-1)
  const mergeBase =
    model.stage === 'merge'
      ? data?.worktrees.find((w) => w.path === merging?.spec.cwd)?.branch
      : undefined
  const base =
    mergeBase ??
    target?.branch ??
    (source && defaultReviewBase(source, s.tasks, data?.worktrees ?? [], []))
  const checkKey = JSON.stringify([key, source?.head, target?.head])
  const recipient = selectRecipient(
    model.records,
    s.sessions,
    model.stage,
    undefined,
    model.foreign,
  )
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
    recipient,
  )
  const asking =
    recipient && terminalStatus('agent', s.sessions[recipient.id]).health === 'input'
      ? recipient
      : undefined
  const inputKey = asking
    ? `${asking.id}:${s.sessions[asking.id]?.generation}:${s.sessions[asking.id]?.status?.agent?.sinceMs}`
    : ''
  const drawerRecord = ui.terminalSession
    ? model.records.find((r) => r.id === ui.terminalSession?.id)
    : recipient
  const drawerShown = ui.terminal !== 'closed' && !!drawerRecord
  const runningReview = useRunningReviewLanes(source?.branch)
  const roleProviders = usePresetProviders(chatRolePresets(s.devices, s.agentRoles))
  const running = model.records.filter((r) => s.sessions[r.id]?.running)
  const hookProviders = [...running.map((r) => r.metadata.adapter), ...roleProviders].flatMap(
    (p) => p ?? [],
  )
  const reporting = new Set(
    running.flatMap((r) =>
      sessionReportedHooks(s.sessions[r.id]) ? (r.metadata.adapter ?? []) : [],
    ),
  )
  useEffect(() => {
    const current = useStore.getState()
    if (current.project && !current.simple)
      current.patchTask(current.project.id, current.activeTask, {
        simple: { startedMs: Date.now(), log: [] },
      })
  }, [s.project, s.activeTask, s.simple])
  // `thread` lists records afresh on every render; the drawer only needs which ones exist.
  const recordKey = model.records.map((r) => r.id).join('\n')
  useEffect(() => {
    const current = useSimpleUi.getState().worktrees[key] ?? EMPTY_SIMPLE_UI
    const next = inputDrawer(current, asking, s.sessions, recordKey.split('\n'))
    if (next !== current) useSimpleUi.getState().patch(key, next)
  }, [key, asking, s.sessions, recordKey])
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
  if (!s.project) return null
  // Review's own dialog, beside the step's actions once there is work to review.
  const options = ['built', 'reviewed', 'fixed'].includes(state.step)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const planner =
    model.records
      .filter((r) => r.metadata.componentId === PLAN_SCOPE && !model.foreign.has(r.id))
      .at(-1)?.metadata.terminalId ?? roleDevice(s.devices, s.agentRoles, 'plan')?.id
  const openFile = (path: string, line?: number) => {
    const files = changed
    const exact = files.find((f) => f.path === path)
    const suffix = files.filter((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`))
    const match = exact ?? (suffix.length === 1 ? suffix[0] : undefined)
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
    const lock = `${key}:${action}`
    if (pendingActions.has(lock)) return
    pendingActions.add(lock)
    setPending(action)
    setFailure('')
    try {
      await fn()
    } catch (e) {
      setFailure(String(e))
    } finally {
      pendingActions.delete(lock)
      setPending('')
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
        if (task) await build()
        else {
          const conversation = s.simple
          const state = useStore.getState()
          const story = state.planStoryTerminal === planner ? state.planStory : null
          seedNewTask(
            (created, pid) => {
              if (ui.terminal === 'user')
                useSimpleUi.getState().patch(simpleKey(pid, created.id), { terminal: 'user' })
              if (conversation)
                useStore.getState().patchTask(pid, created.id, {
                  simple: {
                    ...conversation,
                    startedMs: model.planningStarted,
                    log: conversation.log.filter((e) => e.atMs >= model.planningStarted),
                  },
                })
              void run('build', async () => {
                if (story) await linkStory(pid, story, created.id)
                await build(created.id)
              })
            },
            { copyPlan: true },
          )
        }
      } else if (action === 'plan') {
        threadRef.current
          ?.closest('.simple-chat')
          ?.querySelector<HTMLTextAreaElement>('textarea')
          ?.focus()
      } else if (action === 'review') {
        // Without a base, Options asks for one; the review starts from that dialog.
        if (source?.branch && !base) {
          setDialog('review')
          return
        }
        const request = simpleReviewRequest(source, base)
        const { started, errors } = await startSimpleReview(
          useStore.getState().toProject(),
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
  const launching = ['build', 'fix', 'review', 'merge'].includes(pending)
  return (
    <div className="simple-chat">
      <header>
        <strong>Worktree chat</strong>
        <span>{source?.branch ?? 'Project folder'}</span>
        <button onClick={() => useStore.getState().showAutoPanel()}>Auto</button>
      </header>
      <ActivityHooksNotice providers={hookProviders} reporting={reporting} />
      {error && <p role="alert">{error}</p>}
      {source && dialog === 'review' && (
        <ReviewAgentDialog
          restartSettled
          source={source}
          worktrees={data?.worktrees ?? []}
          close={() => setDialog(undefined)}
          started={(reviewers) => void logReviewers(reviewers)}
          launched={() => setDialog(undefined)}
        />
      )}
      {source && dialog === 'merge' && (
        <MergeAgentDialog
          source={source}
          worktrees={data?.worktrees ?? []}
          findings={findings}
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
        {!items.length && <p className="simple-narration">Describe a feature to start planning.</p>}
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
                  worktree={worktree.path}
                  changed={changed}
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
                    An earlier project plan exists
                    {data?.plan.savedMs
                      ? ` (saved ${new Date(data.plan.savedMs).toLocaleString()})`
                      : ''}{' '}
                    · Show
                  </summary>
                  <Markdown text={item.text} />
                </details>
              ) : (
                state.step !== 'planning' && (
                  <article className="simple-result" key={item.id}>
                    <h3>Plan</h3>
                    <Markdown text={item.text} />
                  </article>
                )
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
        {asking && (
          <p className="simple-narration" role="status">
            {s.sessions[asking.id]?.status?.agent?.message ??
              'The agent needs your input in its terminal.'}
          </p>
        )}
        {launching && (
          <p className="simple-narration" role="status">
            Starting {pending === 'build' ? 'build' : pending}…
          </p>
        )}
        {!launching && (state.prompt || options) && (
          <div className="simple-step" data-step={state.step}>
            {state.prompt && <p>{state.prompt.text}</p>}
            <div className="simple-step-actions">
              {state.prompt?.actions.map((b) => (
                <button disabled={!!pending} key={b.action} onClick={() => act(b.action)}>
                  {b.label}
                </button>
              ))}
              {options && (
                <button className="simple-options" onClick={() => setDialog('review')}>
                  Options…
                </button>
              )}
            </div>
          </div>
        )}
        {failure && <p role="alert">{failure}</p>}
      </div>
      {drawerShown && drawerRecord && (
        <div
          className="simple-terminal-drawer"
          aria-label={`${recordStage(drawerRecord)} terminal`}
        >
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
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        foreign={model.foreign}
        terminalRecord={drawerRecord}
        openTerminal={(record: SessionRecord) =>
          // A drawer whose session is gone shows nothing, so the toggle opens it in one click.
          useSimpleUi.getState().patch(key, {
            terminal: drawerShown ? 'closed' : 'user',
            terminalSession:
              !drawerShown && record.id === asking?.id
                ? { id: record.id, generation: s.sessions[record.id]?.generation }
                : undefined,
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
