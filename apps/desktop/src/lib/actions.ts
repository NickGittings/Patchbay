import { useStore } from '../store'
import type { ActionRequest } from '../types'
import { graphActionRun, graphGroupStop, graphValidationCancel } from './ipc'
import { refreshSession, listenForTerminals } from './sessions'

/** Runs in the active task's worktree, like every other terminal list. */
export async function runGraphAction(request: ActionRequest) {
  const s = useStore.getState()
  if (s.graphActionBusy || !s.project) return
  const projectEpoch = s.projectEpoch
  const project = s.toProject()
  const task = s.activeTask ?? undefined
  useStore.setState({ graphActionBusy: true, graphAction: request, graphActionReport: null })
  s.setMessage(
    request.kind === 'startGroup' ? 'Starting environment…' : 'Validating affected components…',
  )
  try {
    await listenForTerminals()
    if (useStore.getState().projectEpoch !== projectEpoch) return
    const report = await graphActionRun(project, request, task)
    if (useStore.getState().projectEpoch !== projectEpoch) return
    useStore.setState({ graphActionReport: report })
    // Already-running terminals may predate this window's listener.
    await Promise.all(report.results.map((r) => refreshSession(r.sessionId)))
    if (useStore.getState().projectEpoch !== projectEpoch) return
    const count = (outcome: string) => report.results.filter((r) => r.outcome === outcome).length
    const failed = count('failed')
    const stopped = count('stopped') + count('cancelled')
    s.setMessage(
      `${report.results.length} task(s), ${failed} failed${stopped ? `, ${stopped} stopped or not run` : ''}, ${report.plan.skipped.length} component(s) without configured tasks`,
    )
  } catch (e) {
    if (useStore.getState().projectEpoch === projectEpoch) s.setMessage(String(e))
  } finally {
    if (useStore.getState().projectEpoch === projectEpoch)
      useStore.setState({ graphActionBusy: false, graphAction: null })
  }
}

/**
 * Stops the group's environment in the active task's worktree, or with `everywhere`
 * in the open worktree and every task's (before deleting the group).
 */
export async function stopGroup(groupId: string, everywhere = false) {
  const { projectEpoch, activeTask, tasks } = useStore.getState()
  const targets = everywhere ? [null, ...tasks.map((t) => t.id)] : [activeTask]
  try {
    for (const task of targets) await graphGroupStop(groupId, task ?? undefined)
    if (useStore.getState().projectEpoch !== projectEpoch) return false
    useStore.getState().setMessage('Environment stopped')
    return true
  } catch (e) {
    if (useStore.getState().projectEpoch === projectEpoch) useStore.getState().setMessage(String(e))
    return false
  }
}

/** Stops the running validation; its report keeps the validators that already ran. */
export async function stopValidation() {
  try {
    await graphValidationCancel()
  } catch (e) {
    useStore.getState().setMessage(String(e))
  }
}
