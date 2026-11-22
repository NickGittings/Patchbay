import { useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, REVIEW_SCOPE, type MergeRequest } from '../types'
import type { thread, SimpleAction, SimpleStage } from './simple'
import type { FlowAction } from './simpleFlow'
import type { useSimpleData } from './useSimpleData'
import { simpleKey, useSimpleUi } from './simpleUi'
import { clearSimpleChat, logLaunch, logSimple } from './simpleActions'
import { logStageLaunch } from './stageLog'
import { implementPlannerPlan } from './planHandoff'
import { fixReviewFindings } from './reviewHandoff'
import { roleDevice, roleDevices } from './agentRoles'
import { startMerge } from './reviewAgents'
import { simpleReviewRequest, startSimpleReview, type StartedReviewer } from './simpleReview'
import { gitBranches, gitWorktrees } from './ipc'
import { mergeNow, resumeAuto, pauseAuto, stopAuto } from './auto'
import { controlTeam, noteLead, resetLead, type ChatTeam } from './chatTeams'
import { chatAutoActive, chatHandoff } from './chat'
import { autoDrafts, autoDraftKey, emptyAutoDraft } from './autoDrafts'
import { retireStageAgents } from './stageRetire'

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
  const [failureResult, setFailureResult] = useState({ key: '', text: '' })
  const failure = failureResult.key === key ? failureResult.text : ''
  const setFailure = (text: string) => setFailureResult({ key, text })
  const [dialog, setDialog] = useState<'review' | 'merge'>()
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const planner =
    model.records
      .filter((r) => r.metadata.componentId === PLAN_SCOPE && !model.foreign.has(r.id))
      .at(-1)?.metadata.terminalId ?? roleDevice(devices, agentRoles, 'plan')?.id
  // A launch's entry claims only the run its request started, dated at its start (`logLaunch`).
  const log = (
    action: SimpleAction,
    stage: SimpleStage,
    launched: { sessionId: string; requestId?: string },
    destinationTask = task,
  ) => logStageLaunch(projectId, destinationTask, action, stage, launched)
  // A started stage replaces the agents before it. These also serve the Review and Merge dialogs.
  const retire = (launched: string[]) => retireStageAgents(projectId, task, launched, model.foreign)
  const logReviewers = async (reviewers: StartedReviewer[]) => {
    await Promise.all(reviewers.map((r) => log('review', 'review', r)))
    if (reviewers.length) await retire(reviewers.map((r) => r.sessionId))
  }
  const logMerge = async (request: MergeRequest, sid: string, requestId: string) => {
    // Only a started merge settles the conflicts; a canceled dialog or failed launch keeps them.
    useSimpleUi.getState().patch(key, { mergeCheck: undefined })
    await logLaunch(
      projectId,
      task,
      { kind: 'action', action: 'merge', stage: 'merge', request, sessionId: sid },
      requestId,
    )
    await retire([sid])
    await noteLead(
      team,
      `a merge of ${request.sourceBranch} into ${request.destinationBranch}`,
      [sid],
      requestId,
    )
  }
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
  // While this chat's team owns the worktree, its stages launch on the team's behalf.
  const teamTarget = (stageTask = task) =>
    team && team.task === stageTask && ['running', 'paused'].includes(team.state)
      ? { projectId, task: stageTask, chatTeam: team.id }
      : undefined
  const build = async (destinationTask = task) => {
    const current = useStore.getState()
    if (current.project?.id !== projectId || current.activeTask !== destinationTask)
      throw new Error('The worktree changed. Choose Build in the intended chat.')
    const launched = await implementPlannerPlan(
      planner,
      undefined,
      undefined,
      'stay',
      teamTarget(destinationTask),
    )
    await log('implement', 'build', launched, destinationTask)
    await noteLead(team, 'a build of the saved plan', [launched.sessionId], launched.requestId)
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
        const { started, errors } = await startSimpleReview(
          current.toProject(),
          request,
          roleDevices(devices, agentRoles, 'review'),
        )
        await logReviewers(started)
        if (started.length)
          await noteLead(
            team,
            `a review of ${source?.branch ?? 'this worktree'}`,
            started.map((r) => r.sessionId),
            started[0].requestId,
          )
        if (errors.length) setFailure(errors.join('\n'))
      } else if (action === 'fix' && reviewer) {
        const fixing = await fixReviewFindings(reviewer, undefined, undefined, 'stay', teamTarget())
        await log('fix', 'build', fixing)
        await retire([fixing.sessionId])
        await noteLead(team, 'fixes for the review findings', [fixing.sessionId], fixing.requestId)
      } else if (action === 'checkMerge' || action === 'merge') {
        if (!target?.branch || !source?.branch) {
          setDialog('merge')
          return
        }
        const from = (await gitWorktrees(projectId)).find((w) => w.path === source.path)
        if (!from) throw new Error('The merge worktrees changed. Choose a destination again.')
        // Merge checks for conflicts first and stops to show them; Merge with agent goes ahead.
        // Uncommitted source changes open the dialog, which asks whether the agent commits them.
        const started = await startMerge({
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
        // Also retires stage agents and tells the lead.
        await logMerge(started.request, started.sessionId, started.requestId)
      } else if (action === 'resumeAuto') {
        await resumeAuto(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'resumeAuto', stage: stage })
      } else if (action === 'mergeApproval') {
        mergeNow(projectId, task)
        logSimple(projectId, task, { kind: 'action', action: 'mergeApproval', stage: 'merge' })
      }
    })

  const pauseWork = () =>
    run('pause', async () => {
      if (!team) return
      await controlTeam(team, { kind: 'pause' })
      if (chatAutoActive(auto?.status)) pauseAuto(projectId, task)
    })
  const continueWork = () =>
    run('continue', async () => {
      if (!team) return
      await controlTeam(team, { kind: 'resume' })
      if (auto?.status === 'paused') await resumeAuto(projectId, task)
    })
  const stopWork = () =>
    run('stop', async () => {
      if (!team) return
      await controlTeam(team, { kind: 'stop' })
      if (auto && !['done', 'stopped'].includes(auto.status)) stopAuto(projectId, task)
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
      setFailure(String(error))
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
  const openAuto = () => {
    if (auto && ['running', 'waitingOnYou', 'paused'].includes(auto.status)) {
      useStore.getState().showAutoPanel()
      return
    }
    const draftKey = autoDraftKey(projectId, task)
    autoDrafts.set(draftKey, {
      ...(autoDrafts.get(draftKey) ?? emptyAutoDraft()),
      goal: chatHandoff(
        simple,
        source?.branch ?? 'Project folder',
        changed.map((f) => f.path),
      ),
      autonomous: true,
    })
    useStore.setState((s) => ({ autoDraftVersion: s.autoDraftVersion + 1 }))
    useStore.getState().showAutoPanel()
  }
  return {
    pending,
    failure,
    dialog,
    setDialog,
    act,
    logReviewers,
    logMerge,
    pauseWork,
    continueWork,
    stopWork,
    clearHistory,
    startFresh,
    openAuto,
    pauseAuto: () => pauseAuto(projectId, task),
  }
}
