import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { useChatTeams } from '../lib/chatTeams'
import { changedFileRef } from '../lib/review'
import { profileHookProvider } from '../lib/agentProfiles'
import {
  recordStage,
  pendingLaunch,
  LAUNCH_RECORD_GRACE_MS,
  retryMergeBranch,
  thread,
} from '../lib/simple'
import { leadStageSessions } from '../lib/leadStageRun'
import {
  chatStatus,
  chatStepHeading,
  chatStepper,
  flow,
  workflowPromptKey,
} from '../lib/simpleFlow'
import { inPlace } from '../lib/auto'
import type { useSimpleData } from '../lib/useSimpleData'
import { useExpiredDeadline } from '../lib/clock'
import { pinChatTerminal, simpleKey, useSimpleUi, EMPTY_SIMPLE_UI } from '../lib/simpleUi'
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
import {
  chatRecipient,
  chatBusy,
  chatAutoActive,
  chatInputRequests,
  withOfferedQuestions,
} from '../lib/chat'
import { listenAgentQuestions, useAgentQuestions, watchQuestions } from '../lib/agentQuestions'
import { teamJobs, workerSession, workerStatus } from '../lib/chatProgress'
import { useChatModeWorkflow } from '../lib/useChatModeWorkflow'
import { useChatIdentity } from '../lib/chatIdentity'
import { stopTerminal } from '../lib/sessions'
import { useRail } from '../lib/rail'
import ChatModeTimeline from './ChatModeTimeline'
import { ChatCoordinationAlerts } from './ChatCoordination'
import ReviewAgentDialog from './ReviewAgentDialog'
import MergeAgentDialog from './MergeAgentDialog'
import SimpleComposer from './SimpleComposer'
import ChatAgentPicker from './ChatAgentPicker'
import ChatLimitNotice from './ChatLimitNotice'
import Dialog from './Dialog'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import './auto/auto.css'
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
  const [confirm, setConfirm] = useState<{ kind: 'clear' | 'fresh' | 'stop'; key: string }>()
  if (confirm && confirm.key !== key) setConfirm(undefined)
  const closeConfirm = () => setConfirm(undefined)
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
    lead: team?.lead.sessionId,
  }
  const model = thread(snapshot, worktree)
  const launch = pendingLaunch(snapshot, model.records)
  const now = useExpiredDeadline(launch ? launch.atMs + LAUNCH_RECORD_GRACE_MS : undefined)
  const retryBranch = retryMergeBranch(s.simple, data?.outcome)
  const target = worktrees.find(
    (w) =>
      w.branch ===
      (retryBranch ?? (source && defaultMergeDestination(source, worktrees, branches))),
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
  const identity = useChatIdentity(recipient)
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
  const derived = flow(flowSnapshot, model)
  const status = chatStatus(derived.step, {
    lead: team?.status,
    autoRunning: !!s.auto && !['stopped', 'failed', 'done'].includes(s.auto.status),
    simple: s.simple,
  })
  // The derived prompt belongs to the derived step, so it goes when the lead says otherwise.
  const state =
    status.step === derived.step ? derived : { ...derived, step: status.step, prompt: undefined }
  const verdict = findings?.findings?.verdict
  const autoActive = chatAutoActive(s.auto?.status)
  const autoStatus = s.auto?.status
  const autoHalt = autoStatus === 'paused' || autoStatus === 'failed' ? autoStatus : undefined
  const stepper = chatStepper(state.step, {
    issues: verdict ? Object.values(verdict.counts).reduce((sum, n) => sum + n, 0) : undefined,
    inPlace: !!s.auto && !['stopped', 'failed'].includes(s.auto.status) && inPlace(s.auto),
    // A stopped Auto run hands the worktree back to you, so only a paused or failed one halts it.
    halt:
      autoHalt ?? (team?.state === 'paused' || team?.state === 'stopped' ? team.state : undefined),
    note: autoActive || autoHalt ? s.auto?.reason || undefined : status.note,
  })
  const runs = useChatTeams((state) => (team ? state.runs[team.projectId] : undefined))
  const offered = useAgentQuestions((q) => q.pending)
  // The lead, and the workers it is running: their approvals and questions are answered here too.
  const conversation = model.records.filter(
    (r) => !model.foreign.has(r.id) && (!team || r.id === team.lead.sessionId),
  )
  const workers = team
    ? teamJobs(runs ?? [], team.id).flatMap((job) => {
        const record =
          workerStatus(job, s.sessions) === 'complete'
            ? undefined
            : workerSession(job, s.sessionRecords, team.projectId)
        return record && !conversation.includes(record) ? [record] : []
      })
    : []
  // Agents of the lead's stages ask here too: the user only talks to Chat.
  const stageAgents = leadStageSessions(team).flatMap((id) => {
    const record = s.sessionRecords.find((r) => r.id === id)
    return record && !conversation.includes(record) && !workers.includes(record) ? [record] : []
  })
  const askers = [...conversation, ...workers, ...stageAgents]
  const waits = chatInputRequests(askers, s.sessions, ui.inputRequests)
  const inputKey = JSON.stringify(waits)
  const questions = withOfferedQuestions(waits, offered, askers, s.sessions)
  // Chat answers the questions of the agents it shows; others ask in their terminals.
  const askerKey = JSON.stringify(askers.map((r) => r.id).sort())
  useEffect(() => {
    void listenAgentQuestions()
  }, [])
  useEffect(() => watchQuestions(JSON.parse(askerKey)), [askerKey])
  useEffect(() => () => watchQuestions(null), [])
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
        : chatStepHeading(state.step)
  const launching = ['build', 'fix', 'review', 'merge'].includes(pending)
  const openWorkerTerminal = (record: SessionRecord) =>
    pinChatTerminal(key, record.id, s.sessions[record.id]?.generation)
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
        <Menu label="•••" triggerLabel="Chat menu" caret={false} align="right" portal>
          {team && (
            <>
              <MenuItem
                disabled={!!pending || team.state !== 'running'}
                onClick={() => void workflow.pauseWork()}
              >
                Pause work
              </MenuItem>
              <MenuItem
                disabled={!!pending || team.state === 'running'}
                onClick={() => void workflow.continueWork()}
              >
                Continue work
              </MenuItem>
              <MenuItem
                disabled={!!pending || team.state === 'stopped'}
                onClick={() => setConfirm({ kind: 'stop', key })}
              >
                Stop work
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={!!team.reset || !!ui.pendingAction || !!ui.pendingWorkflow}
                title="Reset the lead’s provider context. Workers and a concise work handoff are retained."
                onClick={() => setConfirm({ kind: 'fresh', key })}
              >
                Clear lead context
              </MenuItem>
            </>
          )}
          {recipient &&
            s.sessions[recipient.id]?.running &&
            (team || !chatAutoActive(s.auto?.status)) && (
              <MenuItem
                disabled={!!ui.pendingAction}
                title="Ends this agent’s process. Send a message to start it again."
                onClick={() => void stopTerminal(recipient.id)}
              >
                Stop {identity.role}
              </MenuItem>
            )}
          <MenuItem onClick={() => useRail.setState({ settings: 'roles' })}>
            Agent settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
            onClick={() => setConfirm({ kind: 'clear', key })}
            title="Clear Patchbay’s saved history. Provider transcripts and terminal history remain available."
          >
            Clear chat
          </MenuItem>
        </Menu>
        <button
          className="inspector-close simple-hide-chat"
          aria-label="Hide chat"
          title="Hide chat"
          onClick={onHide}
        >
          ×
        </button>
      </header>
      {confirm?.kind === 'clear' && (
        <Dialog
          title="Clear chat"
          className="centered confirm-dialog"
          onClose={closeConfirm}
          footer={
            <>
              <button autoFocus onClick={closeConfirm}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={!!ui.pendingWorkflow || !!ui.pendingAction}
                onClick={async () => {
                  if (await workflow.clearHistory(confirm.key)) closeConfirm()
                }}
              >
                Clear
              </button>
            </>
          }
        >
          <p>Clear this worktree’s chat history? Agents keep their context.</p>
          <p>Provider transcripts and terminal history remain available.</p>
        </Dialog>
      )}
      {team && confirm?.kind === 'fresh' && (
        <Dialog
          title="Clear lead context"
          className="centered confirm-dialog"
          onClose={closeConfirm}
          footer={
            <>
              <button autoFocus onClick={closeConfirm}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={!!team.reset || !!pending || !!ui.pendingAction || !!ui.pendingWorkflow}
                onClick={() => {
                  const target = confirm.key
                  void workflow.startFresh(target, () => {
                    setConfirm((value) => (value?.key === target ? undefined : value))
                  })
                }}
              >
                Clear context
              </button>
            </>
          }
        >
          <p>
            Clear the lead’s context? Its provider conversation resets and the chat is replaced with
            a concise handoff. Workers and results are retained.
          </p>
        </Dialog>
      )}
      {team && confirm?.kind === 'stop' && (
        <Dialog
          title="Stop work"
          className="centered confirm-dialog"
          onClose={closeConfirm}
          footer={
            <>
              <button autoFocus onClick={closeConfirm}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={!!pending || team.state === 'stopped'}
                onClick={() => {
                  closeConfirm()
                  void workflow.stopWork()
                }}
              >
                Stop work
              </button>
            </>
          }
        >
          <p>Stop the lead and workers for this task? You can continue work later.</p>
        </Dialog>
      )}
      {(state.step !== 'idle' || autoActive || autoHalt) && (
        <div className="chat-progress">
          <ol className="auto-stepper chat-stepper" aria-label="Workflow stages">
            {stepper.map((item) => (
              <li
                key={item.stage}
                aria-current={
                  ['current', 'ready', 'attention', 'stopped', 'failed'].includes(item.state)
                    ? 'step'
                    : undefined
                }
                data-state={item.state}
                title={item.note}
              >
                <span>
                  {CHAT_STAGE_LABELS[item.stage]}
                  {item.note && <small> · {item.note}</small>}
                </span>
              </li>
            ))}
          </ol>
          {autoActive && (
            <button className="chat-auto-pause" onClick={workflow.pauseAuto}>
              Pause Auto
            </button>
          )}
        </div>
      )}
      {team && (
        <ChatCoordinationAlerts key={team.id} team={team} openTerminal={openWorkerTerminal} />
      )}
      <ChatLimitNotice records={model.records} />
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
          initialDestination={retryBranch ?? target?.branch ?? undefined}
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
        askers={askers}
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

const CHAT_STAGE_LABELS = {
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  merge: 'Merge',
} as const
