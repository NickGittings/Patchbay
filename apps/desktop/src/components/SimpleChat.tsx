import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { PLAN_SCOPE, REVIEW_SCOPE, type SessionRecord } from '../types'
import {
  recordStage,
  selectRecipient,
  thread,
  type SimpleAction,
  type SimpleStage,
} from '../lib/simple'
import { flow, type FlowAction } from '../lib/simpleFlow'
import { logSimple } from '../lib/simpleActions'
import type { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { changeGroups } from '../lib/changeGroups'
import { simpleKey, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
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
import { startSimpleReview } from '../lib/simpleReview'
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
      nodes: s.nodes,
      sessionRecords: s.sessionRecords,
      sessions: s.sessions,
      simple: s.simple,
      auto: s.auto,
      devices: s.devices,
      agentRoles: s.agentRoles,
      revealed: s.revealed,
    })),
  )
  const { data, source, error, findings } = reader
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
  const worktree = {
    projectId,
    task,
    path: source?.path ?? s.tasks.find((t) => t.id === task)?.worktree ?? s.project?.root ?? '',
    branch: source?.branch,
  }
  const snapshot = {
    records: s.sessionRecords,
    sessions: s.sessions,
    simple: s.simple,
    auto: s.auto,
    ...data,
    createdMs: s.tasks.find((t) => t.id === task)?.createdMs,
  }
  const model = thread(snapshot, worktree)
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
  const state = flow({
    ...snapshot,
    worktree,
    findings: findings?.findings,
    base: base ?? undefined,
    conflicts: check?.key === checkKey ? check.paths : undefined,
  })
  const recipient = selectRecipient(model.records, s.sessions, model.stage)
  const asking =
    recipient && terminalStatus('agent', s.sessions[recipient.id]).health === 'input'
      ? recipient
      : undefined
  const inputKey = asking
    ? `${asking.id}:${s.sessions[asking.id]?.generation}:${s.sessions[asking.id]?.status?.agent?.sinceMs}`
    : ''
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
  useEffect(() => {
    const drawer = useSimpleUi.getState().worktrees[key]?.terminal ?? 'closed'
    if (inputKey && drawer === 'closed') useSimpleUi.getState().patch(key, { terminal: 'input' })
    else if (!inputKey && drawer === 'input')
      useSimpleUi.getState().patch(key, { terminal: 'closed' })
  }, [key, inputKey])
  const contentKey = JSON.stringify([
    model.items,
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
      block.scrollIntoView({ block: 'nearest' })
      useStore.getState().setRevealed(null)
    }
  }, [s.revealed, key, contentKey])
  if (!s.project) return null
  const groups = changeGroups(s.nodes, data?.review)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const planner =
    model.records.filter((r) => r.metadata.componentId === PLAN_SCOPE).at(-1)?.metadata
      .terminalId ?? roleDevice(s.devices, s.agentRoles, 'plan')?.id
  const openFile = (path: string, line?: number) => {
    const files = groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
    const exact = files.find((f) => f.path === path)
    const suffix = files.filter((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`))
    const match = exact ?? (suffix.length === 1 ? suffix[0] : undefined)
    useSimpleUi.getState().patch(key, {
      diff: { componentId: match?.componentId ?? '@project', path: match?.path ?? path, line },
    })
  }
  const log = (action: SimpleAction, stage: SimpleStage, sid?: string, destinationTask = task) =>
    logSimple(projectId, destinationTask, {
      kind: 'action',
      action,
      stage,
      sessionId: sid,
      atMs: sid ? useStore.getState().sessions[sid]?.startedMs : undefined,
      generation: sid ? useStore.getState().sessions[sid]?.generation : undefined,
    })
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
    const sid = await implementPlannerPlan(planner, undefined, undefined, 'stay')
    log('implement', 'build', sid, destinationTask)
  }
  const act = (action: FlowAction) =>
    void run(action, async () => {
      if (action === 'build') {
        if (task) await build()
        else {
          const conversation = s.simple
          const story = useStore.getState().planStory
          seedNewTask(
            (created, pid) => {
              if (ui.terminal === 'user')
                useSimpleUi.getState().patch(simpleKey(pid, created.id), { terminal: 'user' })
              if (conversation)
                useStore.getState().patchTask(pid, created.id, {
                  simple: {
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
      } else if (action === 'review' && source?.branch && base) {
        const { started, errors } = await startSimpleReview(
          useStore.getState().toProject(),
          { worktree: source.path, branch: source.branch, base },
          roleDevices(s.devices, s.agentRoles, 'review'),
        )
        for (const r of started) log('review', 'review', r.sessionId)
        if (errors.length) setFailure(errors.join('\n'))
      } else if (action === 'fix' && reviewer) {
        log('fix', 'build', await fixReviewFindings(reviewer, undefined, undefined, 'stay'))
      } else if (action === 'checkMerge') {
        if (!target?.branch || !source?.branch) {
          setDialog('merge')
          return
        }
        const project = useStore.getState().toProject()
        const trees = await gitWorktrees(projectId)
        const from = trees.find((w) => w.path === source.path)
        const to = trees.find((w) => w.path === target.path)
        if (!from || !to)
          throw new Error('The merge worktrees changed. Choose a destination again.')
        const paths = await mergeConflicts(project, from.head, to.head)
        setCheck({ key: JSON.stringify([key, from.head, to.head]), paths })
      } else if (action === 'merge' && source?.branch && target?.branch) {
        const request = {
          source: source.path,
          sourceBranch: source.branch,
          destination: target.path,
          destinationBranch: target.branch,
        }
        const sid = await startMergeAgent(
          useStore.getState().toProject(),
          request,
          roleDevice(s.devices, s.agentRoles, 'merge'),
          crypto.randomUUID(),
        )
        logSimple(projectId, task, {
          kind: 'action',
          action: 'merge',
          stage: 'merge',
          request,
          sessionId: sid,
          generation: useStore.getState().sessions[sid]?.generation,
        })
      } else if (action === 'resumeAuto') {
        await resumeAuto(projectId, task)
        log('resumeAuto', model.stage)
      } else if (action === 'mergeApproval') {
        mergeNow(projectId, task)
        log('mergeApproval', 'merge')
      }
    })
  const items = model.items
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
          launched={(sid) => {
            log('review', 'review', sid)
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
      <div
        className="simple-thread"
        ref={threadRef}
        onScroll={() => {
          const el = threadRef.current!
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70
        }}
      >
        {!items.length && <p className="simple-narration">Describe a feature to start planning.</p>}
        {items.map((item, index) => {
          if (item.kind === 'agent') {
            const latest = !items
              .slice(index + 1)
              .some((i) => i.kind === 'agent' && i.sessionId === item.sessionId)
            return (
              <SimpleAgent
                key={item.id}
                record={item.record}
                sessionId={item.sessionId}
                entries={item.entries}
                latest={latest}
                working={state.busyAgent?.id === item.sessionId}
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
          if (item.result === 'changes')
            return (
              <article className="simple-result" key={item.id}>
                <h3>Changes</h3>
                <p>
                  {groups.reduce((sum, g) => sum + g.files.length, 0)} uncommitted files ·{' '}
                  {groups.length} components
                </p>
                {groups.flatMap((g) =>
                  g.files.map((f) => (
                    <button
                      className="simple-file"
                      key={`${g.id}:${f.path}`}
                      onClick={() => openFile(f.path)}
                    >
                      {f.path}
                    </button>
                  )),
                )}
              </article>
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
        })}
        {asking && (
          <p className="simple-narration" role="status">
            {s.sessions[asking.id]?.status?.agent?.message ??
              'The agent needs your input in its terminal.'}
          </p>
        )}
        {state.prompt && (
          <div className="simple-step" data-step={state.step}>
            <p>{state.prompt.text}</p>
            {state.prompt.actions.map((b) => (
              <button disabled={!!pending} key={b.action} onClick={() => act(b.action)}>
                {b.label}
              </button>
            ))}
          </div>
        )}
        {['built', 'reviewed', 'fixed'].includes(state.step) && (
          <button className="simple-options" onClick={() => setDialog('review')}>
            Options…
          </button>
        )}
        {failure && <p role="alert">{failure}</p>}
      </div>
      {ui.terminal !== 'closed' && recipient && (
        <div className="simple-terminal-drawer" aria-label={`${recordStage(recipient)} terminal`}>
          <TerminalPane
            key={recipient.id}
            componentId={recipient.metadata.componentId}
            terminal={{
              id: recipient.metadata.terminalId,
              name: recipient.metadata.name,
              kind: 'agent',
              command: recipient.spec.command,
            }}
            task={recipient.metadata.task ?? null}
            existingSessionId={recipient.id}
            focus={false}
          />
        </div>
      )}
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        openTerminal={(_record: SessionRecord) =>
          useSimpleUi
            .getState()
            .patch(key, { terminal: ui.terminal === 'closed' ? 'user' : 'closed' })
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
