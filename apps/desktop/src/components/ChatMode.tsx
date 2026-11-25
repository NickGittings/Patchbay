import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import type { SessionRecord } from '../types'
import { useChatTeams } from '../lib/chatTeams'
import { changedFileRef } from '../lib/review'
import { profileHookProvider } from '../lib/agentProfiles'
import { leadStageSessions } from '../lib/leadStageRun'
import { useStageModel } from '../lib/useStageModel'
import type { useSimpleData } from '../lib/useSimpleData'
import { pinChatTerminal, useSimpleUi } from '../lib/simpleUi'
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
  if (confirm && confirm.key !== key) setConfirm(undefined)
  const closeConfirm = () => setConfirm(undefined)
  const projectId = s.project?.id ?? '',
    task = s.activeTask
  const chatRef = useRef<HTMLDivElement>(null)
  const workflow = useChatModeWorkflow({
    key,
    projectId,
    task,
    model,
    source,
    auto: s.auto,
    simple: s.simple,
    changed,
    team,
    focusComposer: () =>
      chatRef.current?.querySelector<HTMLTextAreaElement>('.simple-composer textarea')?.focus(),
  })
  const { pending, failure } = workflow
  const blockedHandoff = workflow.handoffBlock
  const workTarget = { projectId, task }
  const stopSelection = workflow.selected('stop')
  const workBlocked = !!pending || !!ui.pendingWorkflow || !!ui.pendingAction
  const recipient = chatRecipient(model.records, s.simple?.selectedAgent)
  const identity = useChatIdentity(recipient)
  const { state, stepper, autoActive, autoHalt } = stage
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
  if (!s.project) return null
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
  const openWorkerTerminal = (record: SessionRecord) => {
    pinChatTerminal(key, record.id, s.sessions[record.id]?.generation)
    focusTerminal(record.id)
  }
  const closeTerminal = () => {
    useSimpleUi
      .getState()
      .patch(key, { terminal: 'closed', terminalSession: undefined, terminalMaximized: false })
    requestAnimationFrame(() =>
      chatRef.current?.querySelector<HTMLTextAreaElement>('.simple-composer textarea')?.focus(),
    )
  }
  return (
    <div
      className="simple-chat"
      data-terminal-maximized={(drawerShown && ui.terminalMaximized) || undefined}
      ref={chatRef}
    >
      <header>
        <strong>Chat</strong>
        <ChatAgentPicker key={key} records={model.records} />
        <button onClick={workflow.openAuto}>Auto mode</button>
        <Menu label="•••" triggerLabel="Chat menu" caret={false} align="right" portal>
          {(team || s.auto) && (
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
          {team && (
            <MenuItem
              disabled={!!team.reset || !!ui.pendingAction || !!ui.pendingWorkflow}
              title="Reset the lead’s provider context. Sub-builders and a concise work handoff are retained."
              onClick={() => setConfirm({ kind: 'fresh', key })}
            >
              Clear lead context
            </MenuItem>
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
      {(state.step !== 'idle' || autoActive || autoHalt) && (
        <StageStrip items={stepper} className="chat-stepper" />
      )}
      {mergeGateError && (
        <div className="chat-coordination">
          <p className="auto-callout" data-tone="attention" role="status">
            Couldn’t check merge status: {mergeGateError}
          </p>
        </div>
      )}
      {team && (
        <ChatCoordinationAlerts key={team.id} team={team} openTerminal={openWorkerTerminal} />
      )}
      <ChatLimitNotice records={model.records} />
      <ActivityHooksNotice providers={hookProviders} reporting={reporting} />
      {error && <p role="alert">{error}</p>}
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
        mergeStatus={mergeStatus?.text}
        retryMergeStatus={retryMergeStatus}
        source={source}
        findings={findings}
        failure={workflow.autoPrompt ? undefined : failure}
        openFile={openFile}
        openDiff={(file) => useSimpleUi.getState().patch(key, { changes: true, diff: file })}
      />
      {drawerShown && drawerRecord && (
        <ChatTerminalPanel
          record={drawerRecord}
          maximized={!!ui.terminalMaximized}
          toggleMaximized={() =>
            useSimpleUi.getState().patch(key, { terminalMaximized: !ui.terminalMaximized })
          }
          close={closeTerminal}
        />
      )}
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        terminalRecord={drawerRecord}
        hidden={drawerShown}
        openTerminal={(record: SessionRecord) => {
          // A drawer whose session is gone shows nothing, so the toggle opens it in one click.
          const closing = drawerShown && drawerRecord?.id === record.id
          if (closing) return closeTerminal()
          useSimpleUi.getState().patch(key, {
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
