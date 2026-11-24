import { useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, REVIEW_SCOPE } from '../types'
import type { thread } from './simple'
import { chatAutoHandoff } from './chatAutoHandoff'
import { cancelQueued } from './simpleQueue'
import { interruptSession } from './simpleComposer'
import {
  controlWork,
  unavailableWork,
  workSelection,
  type WorkCommand,
  type WorkOutcome,
} from './chatWork'
import { openWorktreeAuto, workError, worktreeIdentity } from './workBlocker'
import type { FlowAction } from './simpleFlow'
import type { useSimpleData } from './useSimpleData'
import { simpleKey, useSimpleUi } from './simpleUi'
import { clearSimpleChat, logSimple } from './simpleActions'
import { roleDevice, roleDevices } from './agentRoles'
import { simpleReviewRequest } from './simpleReview'
import { launchBuild, launchFix, launchMerge, launchReview } from './launchStage'
import { gitBranches, gitWorktrees } from './ipc'
import { mergeNow, resumeAuto, pauseAuto, autoRun } from './auto'
import { controlTeam, resetLead, type ChatTeam } from './chatTeams'
import { chatRecipient, chatHandoff } from './chat'
import { unfinished } from './autoSettings'
import { autoDrafts, autoDraftKey, emptyAutoDraft } from './autoDrafts'

type Store = ReturnType<typeof useStore.getState>
type Reader = ReturnType<typeof useSimpleData>
interface WorkflowContext {
  key: string
  projectId: string
  task: Store['activeTask']
  model: ReturnType<typeof thread>
  source: Reader['source']
  target: Reader['source']
  reviewBase: string | null | undefined
  devices: Store['devices']
  agentRoles: Store['agentRoles']
  auto: Store['auto']
  simple: Store['simple']
  changed: Reader['files']
  team: ChatTeam | undefined
  focusComposer: () => void
}

// Shared across mounts so a second chat cannot launch work for the same scope concurrently.
const pendingActions = new Set<string>()
export function useChatModeWorkflow({
  key,
  projectId,
  task,
  model,
  source,
  target,
  reviewBase,
  devices,
  agentRoles,
  auto,
  simple,
  changed,
  team,
  focusComposer,
}: WorkflowContext) {
  const stage = model.stage
  const [pendingResult, setPendingResult] = useState({ key: '', action: '' })
  const pending = pendingResult.key === key ? pendingResult.action : ''
  const [failureResult, setFailureResult] = useState<{ key: string; error?: Error }>()
  const failure = failureResult?.key === key ? failureResult.error : undefined
  const setFailure = (error?: unknown) =>
    setFailureResult({ key, error: error === undefined ? undefined : workError(error) })
  const [workResult, setWorkResult] = useState<{ key: string; outcomes: WorkOutcome[] }>()
  const [autoPrompt, setAutoPrompt] = useState<string>()
  const targetWorktree = { projectId, task }
  const tree = worktreeIdentity(targetWorktree)
  const selected = (command: WorkCommand) => workSelection(command, team, auto)
  const currentScope = () => {
    const state = useStore.getState()
    return (
      !!tree &&
      state.project?.id === projectId &&
      state.activeTask === task &&
      worktreeIdentity(targetWorktree) === tree
    )
  }
  const [dialogState, setDialogState] = useState<{ key: string; kind: 'review' | 'merge' }>()
  const dialog = dialogState?.key === key ? dialogState.kind : undefined
  const setDialog = (kind?: 'review' | 'merge') => setDialogState(kind ? { key, kind } : undefined)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const planner =
    model.records
      .filter((r) => r.metadata.componentId === PLAN_SCOPE && !model.foreign.has(r.id))
      .at(-1)?.metadata.terminalId ?? roleDevice(devices, agentRoles, 'plan')?.id
  // Only a started merge settles the conflicts; a canceled dialog or failed launch keeps them.
  const mergeStarted = () => useSimpleUi.getState().patch(key, { mergeCheck: undefined })
  // Every launch records itself in its worktree's chat, retires the stage before and tells the
  // lead (`launchStage`), as the dialogs and the Plan and Review views do.
  const run = async (action: string, fn: () => Promise<void>) => {
    const lock = key
    if (pendingActions.has(lock)) return
    pendingActions.add(lock)
    useSimpleUi.getState().patch(key, { pendingWorkflow: true })
    setPendingResult({ key, action })
    setFailure()
    try {
      await fn()
    } catch (e) {
      setFailure(e)
    } finally {
      pendingActions.delete(lock)
      useSimpleUi.getState().patch(key, { pendingWorkflow: false })
      setPendingResult((current) => (current.key === key ? { key, action: '' } : current))
    }
  }
  // While this chat's team owns the worktree, its stages launch on the team's behalf.
  const teamTarget = (stageTask = task) =>
    team && team.task === stageTask && ['running', 'paused'].includes(team.state)
      ? { projectId, task: stageTask, chatTeam: team.id }
      : undefined
  const build = async (destinationTask = task) => {
    const current = useStore.getState()
    if (current.project?.id !== projectId || current.activeTask !== destinationTask)
      throw new Error('The worktree changed. Choose Build in the intended chat.')
    await launchBuild(
      'chat',
      planner,
      projectId,
      destinationTask,
      'stay',
      teamTarget(destinationTask),
    )
  }
  const act = (action: FlowAction) =>
    void run(action, async () => {
      if (action === 'build') {
        await build()
      } else if (action === 'plan') {
        focusComposer()
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
        const { errors } = await launchReview(
          'chat',
          current.toProject(),
          task,
          request,
          roleDevices(devices, agentRoles, 'review'),
        )
        if (errors.length) setFailure(errors.join('\n'))
      } else if (action === 'fix' && reviewer) {
        await launchFix('chat', reviewer, 'stay', teamTarget())
      } else if (action === 'checkMerge' || action === 'merge') {
        if (!target?.branch || !source?.branch) {
          setDialog('merge')
          return
        }
        const from = (await gitWorktrees(projectId)).find((w) => w.path === source.path)
        if (!currentScope() || !from || from.branch !== source.branch)
          throw new Error('The merge worktrees changed. Choose a destination again.')
        // Merge checks for conflicts first and stops to show them; Merge with agent goes ahead.
        // Uncommitted source changes open the dialog, which asks whether the agent commits them.
        const started = await launchMerge('chat', task, {
          project: useStore.getState().toProject(),
          source: from,
          destinationBranch: target.branch,
          device: roleDevice(devices, agentRoles, 'merge'),
          checkConflicts: action === 'checkMerge',
          commitSource: 'report',
        })
        if (started.kind === 'conflicts') {
          useSimpleUi.getState().patch(key, {
            mergeCheck: {
              key: JSON.stringify([key, started.sourceHead, started.destinationHead]),
              paths: started.paths,
            },
          })
          return
        }
        if (started.kind === 'uncommitted') {
          setDialog('merge')
          return
        }
        mergeStarted()
      } else if (action === 'resumeAuto') {
        await resumeAuto(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'resumeAuto', stage: stage })
      } else if (action === 'mergeApproval') {
        mergeNow(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'mergeApproval', stage: 'merge' })
      }
    })

  const work = (command: WorkCommand, selection = selected(command), confirmedTree = tree) =>
    run(command, async () => {
      if (!selection.team && !selection.auto) {
        setWorkResult({
          key,
          outcomes: [{ target: '', result: unavailableWork(command, targetWorktree) }],
        })
        return
      }
      setWorkResult({ key, outcomes: [] })
      const outcomes = await controlWork(command, targetWorktree, confirmedTree, selection)
      setWorkResult({ key, outcomes })
    })
  const canConfirm = (confirmationKey: string | undefined) => {
    const current = useStore.getState()
    return (
      simpleKey(current.project?.id, current.activeTask) === confirmationKey &&
      !pendingActions.has(key) &&
      !useSimpleUi.getState().worktrees[key]?.pendingAction
    )
  }
  const clearHistory = async (confirmationKey: string | undefined) => {
    if (!canConfirm(confirmationKey)) return false
    try {
      if (team) await controlTeam(team, { kind: 'historyBoundary' })
      return clearSimpleChat(projectId, task)
    } catch (error) {
      setFailure(error)
      return false
    }
  }
  const startFresh = async (confirmationKey: string | undefined, completed: () => void) => {
    if (!team || !canConfirm(confirmationKey)) return
    await run('reset', async () => {
      await resetLead(team)
      completed()
    })
  }
  const handoffAgent = () => {
    const state = useStore.getState()
    const selected = chatRecipient(model.records, state.simple?.selectedAgent)
    const lead = team && state.sessionRecords.find((record) => record.id === team.lead.sessionId)
    const record = selected ?? lead
    if (!record) return
    return { id: record.id, name: record.metadata.name, session: state.sessions[record.id] }
  }
  const handoffBlock = (duringInterrupt = false) => {
    const ui = useSimpleUi.getState().worktrees[key]
    return chatAutoHandoff(
      duringInterrupt ? { ...ui, pendingWorkflow: false } : (ui ?? {}),
      handoffAgent(),
      useStore.getState().serviceConnected,
    )
  }
  const closeAutoPrompt = () => setAutoPrompt(undefined)
  const openAuto = () => {
    if (!currentScope()) return
    const current = autoRun(projectId, task)
    if (current && ['running', 'waitingOnYou', 'paused', 'failed'].includes(current.status)) {
      closeAutoPrompt()
      openWorktreeAuto(targetWorktree)
      return
    }
    if (handoffBlock()) {
      setAutoPrompt(key)
      return
    }
    const draftKey = autoDraftKey(projectId, task)
    const existing = autoDrafts.get(draftKey)
    // Keep a goal the user typed or a replacement run's goal; refresh one Chat wrote earlier.
    const kept =
      existing?.goal !== undefined && existing.goal !== existing.chatGoal
        ? existing.goal
        : undefined
    const chatGoal = kept
      ? existing?.chatGoal
      : chatHandoff(
          simple,
          source?.branch ?? 'Project folder',
          changed.map((f) => f.path),
        )
    autoDrafts.set(draftKey, {
      ...(existing ?? emptyAutoDraft()),
      goal: kept ?? chatGoal,
      chatGoal,
      autonomous: existing?.autonomous ?? true,
    })
    useStore.setState((s) => ({ autoDraftVersion: s.autoDraftVersion + 1 }))
    closeAutoPrompt()
    openWorktreeAuto(targetWorktree)
  }
  const cancelAutoQueue = () => {
    if (!currentScope() || !handoffBlock()?.queued) return
    cancelQueued(key)
    closeAutoPrompt()
    requestAnimationFrame(focusComposer)
  }
  const interruptAutoHandoff = (
    expected: NonNullable<ReturnType<typeof handoffBlock>>['interrupt'],
  ) =>
    run('interrupt', async () => {
      const checkTurn = () => {
        const auto = autoRun(projectId, task)
        const live = currentScope() && !unfinished(auto?.status) && handoffBlock(true)?.interrupt
        if (
          !expected ||
          !live ||
          expected.id !== live.id ||
          expected.generation !== live.generation ||
          expected.turn !== live.turn ||
          expected.since !== live.since
        )
          throw new Error('The agent’s turn changed. Check its current state before interrupting.')
        return live
      }
      const live = checkTurn()
      await interruptSession(live.id, live.generation, checkTurn)
    })
  return {
    pending,
    failure,
    dialog,
    setDialog,
    act,
    mergeStarted,
    work,
    selected,
    tree,
    workOutcomes: workResult?.key === key ? workResult.outcomes : [],
    setFailure,
    autoPrompt: autoPrompt === key,
    closeAutoPrompt,
    handoffBlock: handoffBlock(),
    handoffAgent: handoffAgent(),
    cancelAutoQueue,
    interruptAutoHandoff,
    clearHistory,
    startFresh,
    openAuto,
    pauseAuto: () => pauseAuto(projectId, task),
  }
}
