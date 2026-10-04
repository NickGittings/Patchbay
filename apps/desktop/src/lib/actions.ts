import { useStore } from '../store'
import type { ActionRequest } from '../types'
import { graphActionRun, graphGroupStop } from './ipc'
import { refreshSession, listenForTerminals } from './sessions'

export async function runGraphAction(request: ActionRequest) {
  const s = useStore.getState()
  if (s.graphActionBusy || !s.project) return
  const projectEpoch = s.projectEpoch
  const project = s.toProject()
  useStore.setState({ graphActionBusy: true, graphActionReport: null })
  s.setMessage(
    request.kind === 'startGroup' ? 'Starting environment…' : 'Validating affected components…',
  )
  try {
    await listenForTerminals()
    if (useStore.getState().projectEpoch !== projectEpoch) return
    const report = await graphActionRun(project, request)
    if (useStore.getState().projectEpoch !== projectEpoch) return
    useStore.setState({ graphActionReport: report })
    // Already-running terminals may predate this window's listener.
    await Promise.all(report.results.map((r) => refreshSession(r.sessionId)))
    if (useStore.getState().projectEpoch !== projectEpoch) return
    const failed = report.results.filter((r) => r.outcome === 'failed').length
    s.setMessage(
      `${report.results.length} task(s), ${failed} failed, ${report.plan.skipped.length} component(s) without configured tasks`,
    )
  } catch (e) {
    if (useStore.getState().projectEpoch === projectEpoch) s.setMessage(String(e))
  } finally {
    if (useStore.getState().projectEpoch === projectEpoch)
      useStore.setState({ graphActionBusy: false })
  }
}

export async function stopGroup(groupId: string) {
  const projectEpoch = useStore.getState().projectEpoch
  try {
    await graphGroupStop(groupId)
    if (useStore.getState().projectEpoch !== projectEpoch) return false
    useStore.getState().setMessage('Environment stopped')
    return true
  } catch (e) {
    if (useStore.getState().projectEpoch === projectEpoch) useStore.getState().setMessage(String(e))
    return false
  }
}
