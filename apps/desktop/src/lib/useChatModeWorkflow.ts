import { useState } from 'react'
import { useStore } from '../store'
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
import type { useSimpleData } from './useSimpleData'
import { simpleKey, useSimpleUi } from './simpleUi'
import { clearSimpleChat } from './simpleActions'
import { autoRun } from './auto'
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
  auto,
  simple,
  changed,
  team,
  focusComposer,
}: WorkflowContext) {
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
  // Keep each worktree's controls serialized even if Chat remounts.
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
    work,
    selected,
    tree,
    workOutcomes: workResult?.key === key ? workResult.outcomes : [],
    autoPrompt: autoPrompt === key,
    closeAutoPrompt,
    handoffBlock: handoffBlock(),
    handoffAgent: handoffAgent(),
    cancelAutoQueue,
    interruptAutoHandoff,
    clearHistory,
    startFresh,
    openAuto,
  }
}
