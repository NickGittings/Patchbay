import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { LEAD_HOME_TASK, useChatTeams } from '../lib/chatTeams'
import { autoOf, simpleOf } from '../lib/chatHome'
import { leadThread } from '../lib/leadThread'
import { worktreeChip } from '../lib/worktreeLabel'
import { chatIdentity } from '../lib/chatIdentity'
import { thread } from '../lib/simple'
import { changedFileRef } from '../lib/review'
import { profileHookProvider } from '../lib/agentProfiles'
import { leadStageSessions } from '../lib/leadStageRun'
import { useStageModel } from '../lib/useStageModel'
import type { useSimpleData } from '../lib/useSimpleData'
import {
  EMPTY_SIMPLE_UI,
  pinChatTerminal,
  simpleKey,
  useSimpleUi,
  type SimpleDiff,
} from '../lib/simpleUi'
import { chatRolePresets } from '../lib/agentRoles'
import {
  missingHooks,
  sessionReportedHooks,
  openIntegrations,
  useAgentHooksInstalled,
  usePresetProviders,
  type HookProvider,
} from '../lib/agentHooks'
import { chatRecipient, chatAutoActive, chatInputRequests, withOfferedQuestions } from '../lib/chat'
import { listenAgentQuestions, useAgentQuestions, watchQuestions } from '../lib/agentQuestions'
import { teamJobs, workerSession, workerStatus } from '../lib/chatProgress'
import { workSelection, unavailableWork, type WorkCommand } from '../lib/chatWork'
import { worktreeLabel } from '../lib/workBlocker'
import WorkFeedback from './WorkFeedback'
import { useChatModeWorkflow } from '../lib/useChatModeWorkflow'
import { useChatIdentity } from '../lib/chatIdentity'
import { stopTerminal } from '../lib/sessions'
import { focusTerminal } from '../lib/terminals'
import { useRail } from '../lib/rail'
import ChatModeTimeline from './ChatModeTimeline'
import StageStrip from './StageStrip'
import { ChatCoordinationAlerts } from './ChatCoordination'
import SimpleComposer from './SimpleComposer'
import ChatTerminalPanel from './ChatTerminalPanel'
import ChatAgentPicker from './ChatAgentPicker'
import ChatLimitNotice from './ChatLimitNotice'
import Dialog from './Dialog'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import './auto/auto.css'
import './simple.css'

const WORK_PENDING: Record<WorkCommand, string> = {
  pause: 'Pausing work',
  continue: 'Continuing work',
  stop: 'Stopping work',
}

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
  const { data, source, files: changed, error, findings } = reader
  const stage = useStageModel(reader)!
  const { key, team, ui, model, launch, now } = stage
  const [confirm, setConfirm] = useState<
    | { kind: 'clear' | 'fresh'; key: string }
    | {
        kind: 'stop'
        key: string
        selection: ReturnType<typeof workSelection>
        tree?: string
        branch?: string | null
      }
  >()
  const projectId = s.project?.id ?? '',
    task = s.activeTask
  // One conversation per project: the lead lives in the project folder, and the worktree picker
  // only moves the focus, which the stage strip, Changes, Auto and work controls follow.
  const chatTask = LEAD_HOME_TASK
  const chatKey = simpleKey(projectId, chatTask)
  const focused = task !== chatTask
  const chatTeam = useChatTeams((state) => state.teams[projectId]?.find((t) => t.task === chatTask))
  const allTeams = useChatTeams((state) => state.teams[projectId])
  const allRuns = useChatTeams((state) => state.runs[projectId])
  const chatUi = useSimpleUi((u) => u.worktrees[chatKey] ?? EMPTY_SIMPLE_UI)
  const chatSimple = useStore((state) => simpleOf(state, chatTask))
  const chatAuto = useStore((state) => autoOf(state, chatTask))
  const chatModel = focused
    ? thread(
        {
          records: s.sessionRecords,
          sessions: s.sessions,
          simple: chatSimple,
          auto: chatAuto,
          lead: chatTeam?.lead.sessionId,
        },
        { projectId, task: chatTask, path: s.project?.root ?? '' },
      )
    : model
  if (confirm && confirm.key !== (confirm.kind === 'stop' ? key : chatKey)) setConfirm(undefined)
  const closeConfirm = () => setConfirm(undefined)
  const chatRef = useRef<HTMLDivElement>(null)
  // Pause, Continue and Stop work control the lead's team only in the project folder; in another
  // worktree they control its Auto run, never the lead's other work.
  const workTeam = focused ? undefined : team
  const workflow = useChatModeWorkflow({
    key,
    projectId,
    task,
    source,
    auto: s.auto,
    simple: s.simple,
    changed,
    team: workTeam,
    chat: { key: chatKey, task: chatTask, team: chatTeam, model: chatModel, simple: chatSimple },
    focusComposer: () =>
      chatRef.current?.querySelector<HTMLTextAreaElement>('.simple-composer textarea')?.focus(),
  })
  const { pending, failure } = workflow
  const blockedHandoff = workflow.handoffBlock
  const workTarget = { projectId, task }
  const stopSelection = workflow.selected('stop')
  const workBlocked = !!pending || !!ui.pendingWorkflow || !!ui.pendingAction
  const recipient = chatRecipient(chatModel.records, chatSimple?.selectedAgent)
  const identity = useChatIdentity(recipient)
  const { state, stepper, visible: stripShown } = stage
  const mergeGateError =
    stage.autoCurrent && s.auto?.stage === 'mergeGate' && s.auto.status === 'waitingOnYou'
      ? s.auto.gateError
      : undefined
  const mergeStatus = stage.flow.step === 'merging' ? stage.flow.prompt : undefined
  const retryMergeStatus = mergeStatus?.actions.some(
    (action) => action.action === 'retryMergeStatus',
  )
    ? reader.retry
    : undefined
  const runs = allRuns
  const offered = useAgentQuestions((q) => q.pending)
  // The lead, and the workers it is running: their approvals and questions are answered here too.
  const conversation = chatModel.records.filter(
    (r) => !chatModel.foreign.has(r.id) && (!chatTeam || r.id === chatTeam.lead.sessionId),
  )
  const workers = chatTeam
    ? teamJobs(runs ?? [], chatTeam.id).flatMap((job) => {
        const record =
          workerStatus(job, s.sessions) === 'complete'
            ? undefined
            : workerSession(job, s.sessionRecords, chatTeam.projectId)
        return record && !conversation.includes(record) ? [record] : []
      })
    : []
  // Agents of the lead's stages ask here too, in whichever worktree: the user only talks to Chat.
  const stageAgents = leadStageSessions(chatTeam).flatMap((id) => {
    const record = s.sessionRecords.find((r) => r.id === id)
    return record && !conversation.includes(record) && !workers.includes(record) ? [record] : []
  })
  // A worktree's lead from before one lead per project, finishing its work: the conversation it
  // had stays readable in that worktree, and its questions are answered here.
  const earlierTeam = focused ? allTeams?.find((t) => t.task === task) : undefined
  const earlierLeads = new Set(
    [earlierTeam?.lead.sessionId, focused ? s.simple?.selectedAgent : undefined].filter(
      (id): id is string => !!id && id !== chatTeam?.lead.sessionId,
    ),
  )
  const earlierAskers = s.sessionRecords.filter(
    (r) =>
      earlierTeam?.state !== 'stopped' &&
      earlierLeads.has(r.id) &&
      ![...conversation, ...workers, ...stageAgents].includes(r),
  )
  const askers = [...conversation, ...workers, ...stageAgents, ...earlierAskers]
  const waits = chatInputRequests(askers, s.sessions, chatUi.inputRequests)
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
    const previous = useSimpleUi.getState().worktrees[chatKey]?.inputRequests ?? []
    if (JSON.stringify(previous) !== inputKey)
      useSimpleUi.getState().patch(chatKey, { inputRequests: JSON.parse(inputKey) })
  }, [chatKey, inputKey])
  // The drawer belongs to the conversation, so it stays put while the focus moves.
  const drawerRecord = chatUi.terminalSession
    ? s.sessionRecords.find((r) => r.id === chatUi.terminalSession?.id)
    : recipient
  const drawerShown = chatUi.terminal !== 'closed' && !!drawerRecord
  const roleProviders = usePresetProviders(chatRolePresets(s.devices, s.agentRoles))
  const running = chatModel.records.filter((r) => s.sessions[r.id]?.running)
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
    if (current.project && !simpleOf(current, chatTask))
      current.patchTask(current.project.id, chatTask, {
        simple: { startedMs: Date.now(), log: [] },
      })
  }, [s.project, s.activeTask, s.simple, chatSimple, chatTask])
  if (!s.project) return null
  const openDiff = (diff: SimpleDiff) =>
    useSimpleUi.getState().patch(key, { changes: true, agents: false, diff })
  const openFile = (path: string, line?: number) => {
    const match = changedFileRef(changed, path, source?.path)
    openDiff({ componentId: match?.componentId ?? '@project', path: match?.path ?? path, line })
  }
  // Until this launch's run reconciles (or its grace expires), an old slot's result is history.
  const focusItems =
    launch && now === undefined
      ? model.items.filter((i) => i.kind !== 'result' || i.result !== launch.stage)
      : model.items
  // The project folder is git's main worktree.
  const projectBranch = reader.worktrees.find((w) => w.main)?.branch
  const conversationLabel = worktreeChip(s.tasks, chatTask, projectBranch).label
  const focusLabel = worktreeChip(s.tasks, task, projectBranch).label
  // Every agent that has been this conversation's lead, so a Switch agent or a cleared context
  // keeps the history before it.
  const leads = new Set(
    [
      chatTeam?.lead.sessionId,
      chatSimple?.selectedAgent,
      ...(chatSimple?.agentRuns ?? []).map((r) => r.sessionId),
    ].filter((id): id is string => !!id),
  )
  // Only the lead talks; stage results carry the worktree and branch they come from.
  const { items, chips } = leadThread({
    conversation: chatModel.items,
    focus: focusItems,
    leads,
    earlierLeads,
    focused,
    conversationLabel,
    focusLabel,
  })
  const questionLabel = (record: SessionRecord) =>
    leads.has(record.id)
      ? undefined
      : `${chatIdentity(record, allTeams, allRuns).role} · ${
          worktreeChip(s.tasks, record.metadata.task, projectBranch).label
        }`
  const openWorkerTerminal = (record: SessionRecord) => {
    pinChatTerminal(chatKey, record.id, s.sessions[record.id]?.generation)
    focusTerminal(record.id)
  }
  const closeTerminal = () => {
    useSimpleUi
      .getState()
      .patch(chatKey, { terminal: 'closed', terminalSession: undefined, terminalMaximized: false })
    requestAnimationFrame(() =>
      chatRef.current?.querySelector<HTMLTextAreaElement>('.simple-composer textarea')?.focus(),
    )
  }
  return (
    <div
      className="simple-chat"
      data-terminal-maximized={(drawerShown && chatUi.terminalMaximized) || undefined}
      ref={chatRef}
    >
      <header>
        <strong>Chat</strong>
        <ChatAgentPicker key={chatKey} records={chatModel.records} task={chatTask} />
        <button onClick={workflow.openAuto}>Auto mode</button>
        <Menu label="•••" triggerLabel="Chat menu" caret={false} align="right" portal>
          {(workTeam || s.auto) && (
            <>
              <MenuItem
                disabled={workBlocked}
                title={
                  workflow.selected('pause').team || workflow.selected('pause').auto
                    ? undefined
                    : unavailableWork('pause', workTarget)
                }
                onClick={() => void workflow.work('pause')}
              >
                Pause work
              </MenuItem>
              <MenuItem
                disabled={workBlocked}
                title={
                  workflow.selected('continue').team || workflow.selected('continue').auto
                    ? undefined
                    : unavailableWork('continue', workTarget)
                }
                onClick={() => void workflow.work('continue')}
              >
                Continue work
              </MenuItem>
              <MenuItem
                disabled={workBlocked}
                title={
                  stopSelection.team || stopSelection.auto
                    ? undefined
                    : unavailableWork('stop', workTarget)
                }
                onClick={() => {
                  if (!stopSelection.team && !stopSelection.auto) void workflow.work('stop')
                  else
                    setConfirm({
                      kind: 'stop',
                      key,
                      selection: stopSelection,
                      tree: workflow.tree,
                      branch: source?.branch,
                    })
                }}
              >
                Stop work
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {chatTeam && (
            <MenuItem
              disabled={!!chatTeam.reset || !!chatUi.pendingAction || !!chatUi.pendingWorkflow}
              title="Reset the lead’s provider context. Sub-builders and a concise work handoff are retained."
              onClick={() => setConfirm({ kind: 'fresh', key: chatKey })}
            >
              Clear lead context
            </MenuItem>
          )}
          {recipient &&
            s.sessions[recipient.id]?.running &&
            (chatTeam || !chatAutoActive(chatAuto?.status)) && (
              <MenuItem
                disabled={!!chatUi.pendingAction}
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
            disabled={!!chatUi.pendingWorkflow || !!chatUi.pendingAction}
            onClick={() => setConfirm({ kind: 'clear', key: chatKey })}
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
                disabled={!!chatUi.pendingWorkflow || !!chatUi.pendingAction}
                onClick={async () => {
                  if (await workflow.clearHistory(confirm.key)) closeConfirm()
                }}
              >
                Clear
              </button>
            </>
          }
        >
          <p>Clear the project’s chat history? Agents keep their context.</p>
          <p>Provider transcripts and terminal history remain available.</p>
        </Dialog>
      )}
      {chatTeam && confirm?.kind === 'fresh' && (
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
                disabled={
                  !!chatTeam.reset ||
                  !!pending ||
                  !!chatUi.pendingAction ||
                  !!chatUi.pendingWorkflow
                }
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
            a concise handoff. Sub-builders and results are retained.
          </p>
        </Dialog>
      )}
      {confirm?.kind === 'stop' && (
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
                disabled={workBlocked || source?.branch !== confirm.branch}
                onClick={() => {
                  closeConfirm()
                  void workflow.work('stop', confirm.selection, confirm.tree)
                }}
              >
                Stop work
              </button>
            </>
          }
        >
          <p>Stop work in {worktreeLabel(workTarget)}?</p>
          <ul>
            {confirm.selection.team && <li>Chat coordination and its Sub-builder sessions</li>}
            {confirm.selection.auto && (
              <li>Auto run “{confirm.selection.auto.goal}” and agents it launched</li>
            )}
          </ul>
          {source?.branch !== confirm.branch && (
            <p role="alert">
              The branch changed. Close this confirmation and choose Stop work again.
            </p>
          )}
        </Dialog>
      )}
      {workflow.autoPrompt && (
        <Dialog
          title="Hand off to Auto"
          subtitle={worktreeLabel(workTarget)}
          className="centered confirm-dialog"
          onClose={workflow.closeAutoPrompt}
          footer={
            <>
              <button autoFocus onClick={workflow.closeAutoPrompt}>
                Close
              </button>
              {blockedHandoff?.queued && (
                <button className="primary" onClick={workflow.cancelAutoQueue}>
                  Cancel queued message
                </button>
              )}
              {blockedHandoff?.terminal && (
                <button
                  className="primary"
                  onClick={() => {
                    const record = s.sessionRecords.find((r) => r.id === workflow.handoffAgent?.id)
                    if (record) {
                      workflow.closeAutoPrompt()
                      openWorkerTerminal(record)
                    }
                  }}
                >
                  Open terminal
                </button>
              )}
              {blockedHandoff?.composer && (
                <button
                  onClick={() => {
                    workflow.closeAutoPrompt()
                    requestAnimationFrame(() =>
                      chatRef.current
                        ?.querySelector<HTMLTextAreaElement>('.simple-composer textarea')
                        ?.focus(),
                    )
                  }}
                >
                  Go to composer
                </button>
              )}
              {blockedHandoff?.interrupt && (
                <button
                  onClick={() => void workflow.interruptAutoHandoff(blockedHandoff.interrupt)}
                >
                  Interrupt turn
                </button>
              )}
              {(!blockedHandoff ||
                (s.auto && s.auto.status !== 'done' && s.auto.status !== 'stopped')) && (
                <button className="primary" onClick={workflow.openAuto}>
                  Open Auto
                </button>
              )}
            </>
          }
        >
          <p role="status">
            {blockedHandoff?.message ?? 'Chat is ready. Open Auto to review the setup.'}
          </p>
          {failure && <WorkFeedback error={failure} />}
        </Dialog>
      )}
      {Object.hasOwn(WORK_PENDING, pending) && (
        <p className="chat-coordination" role="status">
          {WORK_PENDING[pending as WorkCommand]} in {worktreeLabel(workTarget)}…
        </p>
      )}
      {workflow.workOutcomes.length > 0 && (
        <div className="chat-coordination" aria-label="Work command results">
          {workflow.workOutcomes.map(({ target, result }) => (
            <div key={target}>
              {typeof result === 'string' ? (
                <p role="status">
                  {target ? `${target} ${result} in ${worktreeLabel(workTarget)}.` : result}
                </p>
              ) : (
                <WorkFeedback error={result} label={target} />
              )}
            </div>
          ))}
        </div>
      )}
      {stripShown && <StageStrip items={stepper} className="chat-stepper" />}
      {mergeGateError && (
        <div className="chat-coordination">
          <p className="auto-callout" data-tone="attention" role="status">
            Couldn’t check merge status: {mergeGateError}
          </p>
        </div>
      )}
      {chatTeam && (
        <ChatCoordinationAlerts
          key={chatTeam.id}
          team={chatTeam}
          openTerminal={openWorkerTerminal}
        />
      )}
      <ChatLimitNotice records={chatModel.records} task={chatTask} />
      <ActivityHooksNotice providers={hookProviders} reporting={reporting} />
      {error && <p role="alert">{error}</p>}
      <ChatModeTimeline
        scopeKey={chatKey}
        model={chatModel}
        items={items}
        chips={chips}
        questionLabel={questionLabel}
        busyAgent={
          // The focused worktree's flow doesn't know the lead, which runs in the project folder.
          focused &&
          recipient &&
          s.sessions[recipient.id]?.running &&
          s.sessions[recipient.id]?.status?.agent?.state === 'working'
            ? recipient.id
            : undefined
        }
        state={state}
        questions={questions}
        askers={askers}
        simple={chatSimple}
        revealed={s.revealed}
        terminal={chatUi.terminal}
        data={data}
        mergeStatus={mergeStatus?.text}
        retryMergeStatus={retryMergeStatus}
        source={source}
        findings={findings}
        failure={workflow.autoPrompt ? undefined : failure}
        openFile={openFile}
        openDiff={openDiff}
      />
      {drawerShown && drawerRecord && (
        <ChatTerminalPanel
          record={drawerRecord}
          maximized={!!chatUi.terminalMaximized}
          toggleMaximized={() =>
            useSimpleUi.getState().patch(chatKey, { terminalMaximized: !chatUi.terminalMaximized })
          }
          close={closeTerminal}
        />
      )}
      <SimpleComposer
        scopeKey={chatKey}
        task={chatTask}
        stage={chatModel.stage}
        records={chatModel.records}
        terminalRecord={drawerRecord}
        hidden={drawerShown}
        openTerminal={(record: SessionRecord) => {
          // A drawer whose session is gone shows nothing, so the toggle opens it in one click.
          const closing = drawerShown && drawerRecord?.id === record.id
          if (closing) return closeTerminal()
          useSimpleUi.getState().patch(chatKey, {
            terminal: 'user',
            terminalSession: {
              id: record.id,
              generation: s.sessions[record.id]?.generation,
              pinned: true,
            },
          })
          focusTerminal(record.id)
        }}
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
