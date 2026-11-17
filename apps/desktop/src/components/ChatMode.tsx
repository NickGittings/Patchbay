import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { useChatTeams } from '../lib/chatTeams'
import { changedFileRef } from '../lib/review'
import { profileHookProvider } from '../lib/agentProfiles'
import { recordStage, pendingLaunch, LAUNCH_RECORD_GRACE_MS, thread } from '../lib/simple'
import { flow, workflowPromptKey } from '../lib/simpleFlow'
import type { useSimpleData } from '../lib/useSimpleData'
import { useExpiredDeadline } from '../lib/clock'
import { simpleKey, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
import { chatRolePresets } from '../lib/agentRoles'
import { defaultMergeDestination, chatReviewBase } from '../lib/reviewAgents'
import {
  missingHooks,
  sessionReportedHooks,
  openIntegrations,
  useAgentHooksInstalled,
  usePresetProviders,
  type HookProvider,
} from '../lib/agentHooks'
import { chatRecipient, chatBusy, chatAutoActive, chatInputRequests } from '../lib/chat'
import {
  claimQuestions,
  listenAgentQuestions,
  releaseQuestions,
  useAgentQuestions,
} from '../lib/agentQuestions'
import { useChatModeWorkflow } from '../lib/useChatModeWorkflow'
import ChatModeTimeline from './ChatModeTimeline'
import ChatCoordination from './ChatCoordination'
import ReviewAgentDialog from './ReviewAgentDialog'
import MergeAgentDialog from './MergeAgentDialog'
import SimpleComposer from './SimpleComposer'
import ChatAgentPicker from './ChatAgentPicker'
import './simple.css'

export default function ChatMode({
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
  const [clearKey, setClearKey] = useState<string>()
  if (clearKey !== undefined && clearKey !== key) setClearKey(undefined)
  const [freshKey, setFreshKey] = useState<string>()
  if (freshKey !== undefined && freshKey !== key) setFreshKey(undefined)
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
  const chatRef = useRef<HTMLDivElement>(null)
  const workflow = useChatModeWorkflow({
    key,
    projectId,
    task,
    model,
    source,
    target,
    reviewBase,
    devices: s.devices,
    agentRoles: s.agentRoles,
    auto: s.auto,
    simple: s.simple,
    changed,
    team,
    focusComposer: () => chatRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
  })
  const { pending, failure, dialog, setDialog, check, act, logReviewers, logMerge } = workflow
  const checkKey = JSON.stringify([key, source?.head, target?.head])
  const recipient = chatRecipient(model.records, s.simple?.selectedAgent)
  const flowSnapshot = {
    ...snapshot,
    worktree,
    findings: findings?.findings,
    outcomePending: !data && !error,
    outcomeError: data?.outcomeError || error || undefined,
    base: base ?? undefined,
    conflicts: check?.key === checkKey ? check.paths : undefined,
    now,
  }
  const state = flow(flowSnapshot, model)
  const askers = model.records.filter(
    (r) => !model.foreign.has(r.id) && (!team || r.id === team.lead.sessionId),
  )
  const questions = chatInputRequests(askers, s.sessions, ui.inputRequests)
  const inputKey = JSON.stringify(questions)
  // Chat answers the questions of the agents it shows; others go to their terminals.
  const askerKey = JSON.stringify(askers.map((r) => r.id).sort())
  const offered = useAgentQuestions((q) => Object.keys(q.pending).sort().join())
  useEffect(() => {
    void listenAgentQuestions()
  }, [])
  useEffect(() => {
    const ids = new Set<string>(JSON.parse(askerKey))
    releaseQuestions(ids)
    void claimQuestions(ids)
  }, [askerKey, offered])
  useEffect(() => () => releaseQuestions(null), [])
  useEffect(() => {
    const previous = useSimpleUi.getState().worktrees[key]?.inputRequests ?? []
    if (JSON.stringify(previous) !== inputKey)
      useSimpleUi.getState().patch(key, { inputRequests: JSON.parse(inputKey) })
  }, [key, inputKey])
  const drawerRecord = ui.terminalSession
    ? s.sessionRecords.find((r) => r.id === ui.terminalSession?.id)
    : recipient
  const drawerShown = ui.terminal !== 'closed' && !!drawerRecord
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
  const promptKey = workflowPromptKey(flowSnapshot, model, state)
  if (!s.project) return null
  // Review's own dialog, beside the step's actions once there is work to review.
  const options = ['built', 'reviewed', 'fixed'].includes(state.step)
  const openFile = (path: string, line?: number) => {
    const match = changedFileRef(changed, path, source?.path)
    useSimpleUi.getState().patch(key, {
      changes: true,
      diff: { componentId: match?.componentId ?? '@project', path: match?.path ?? path, line },
    })
  }
  // Until this launch's run reconciles (or its grace expires), an old slot's result is history.
  const items =
    launch && now === undefined
      ? model.items.filter((i) => i.kind !== 'result' || i.result !== launch.stage)
      : model.items
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
    <div className="simple-chat" ref={chatRef}>
      <header>
        <strong>Chat</strong>
        <ChatAgentPicker key={key} records={model.records} />
        <button
          disabled={
            !!ui.pendingAction || !!ui.queued || chatBusy(recipient && s.sessions[recipient.id])
          }
          title="Finish or stop the current agent turn before handing off"
          onClick={workflow.openAuto}
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
                  onClick={() => void workflow.pauseWork()}
                >
                  Pause work
                </button>
                <button
                  disabled={!!pending || team.state === 'running'}
                  onClick={() => void workflow.continueWork()}
                >
                  Continue work
                </button>
                <button
                  disabled={!!pending || team.state === 'stopped'}
                  onClick={() => void workflow.stopWork()}
                >
                  Stop work
                </button>
              </div>
            )}
            {team && (
              <button
                disabled={!!team.reset || !!ui.pendingAction || !!ui.pendingWorkflow}
                title="Start a fresh provider conversation. Workers and a concise work handoff are retained."
                onClick={() => {
                  setClearKey(undefined)
                  setFreshKey(key)
                }}
              >
                Start fresh conversation
              </button>
            )}
            <button
              disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
              onClick={() => {
                setFreshKey(undefined)
                setClearKey(key)
              }}
              title="Clear Patchbay’s saved history. Provider transcripts and terminal history remain available."
            >
              Clear visible history
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
        <div
          className="simple-clear-confirm"
          role="group"
          aria-label="Clear visible history confirmation"
        >
          <span>Clear this worktree’s chat history? Agents keep their context.</span>
          <button
            disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
            onClick={async () => {
              if (await workflow.clearHistory(clearKey)) setClearKey(undefined)
            }}
          >
            Clear
          </button>
          <button onClick={() => setClearKey(undefined)}>Cancel</button>
        </div>
      )}
      {team && freshKey === key && (
        <div
          className="simple-fresh-confirm"
          role="group"
          aria-label="Start fresh conversation confirmation"
        >
          <span>
            Start a fresh provider conversation? Provider context resets and visible history is
            replaced with a concise handoff. Workers and results are retained.
          </span>
          <button
            disabled={!!team.reset || !!pending || !!ui.pendingAction || !!ui.pendingWorkflow}
            onClick={() => {
              void workflow.startFresh(freshKey, () => {
                setFreshKey((value) => (value === key ? undefined : value))
              })
            }}
          >
            Start fresh
          </button>
          <button onClick={() => setFreshKey(undefined)}>Cancel</button>
        </div>
      )}
      {team && (
        <ChatCoordination
          key={team.id}
          team={team}
          openTerminal={(record) =>
            useSimpleUi.getState().patch(key, {
              terminal: 'user',
              terminalSession: {
                id: record.id,
                generation: s.sessions[record.id]?.generation,
                pinned: true,
              },
            })
          }
        />
      )}
      {s.auto && (
        <p role="status">
          Auto · {s.auto.stage} · {s.auto.status} {s.auto.reason}
          {chatAutoActive(s.auto.status) && (
            <button onClick={workflow.pauseAuto}>Pause Auto</button>
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
      <ChatModeTimeline
        scopeKey={key}
        model={model}
        items={items}
        state={state}
        questions={questions}
        simple={s.simple}
        revealed={s.revealed}
        terminal={ui.terminal}
        data={data}
        source={source}
        findings={findings}
        pending={pending}
        failure={failure}
        drawerRecord={drawerRecord}
        drawerShown={drawerShown}
        openFile={openFile}
        openDiff={(file) => useSimpleUi.getState().patch(key, { changes: true, diff: file })}
      />
      {!launching && !ui.dismissedPrompts?.includes(promptKey) && (state.prompt || options) && (
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
              onClick={() =>
                useSimpleUi.getState().patch(key, {
                  dismissedPrompts: [...(ui.dismissedPrompts ?? []), promptKey],
                })
              }
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
                onClick={() => (b.action === 'retryMergeStatus' ? reader.retry() : act(b.action))}
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
