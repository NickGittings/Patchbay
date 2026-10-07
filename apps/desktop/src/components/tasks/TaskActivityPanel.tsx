import { useEffect } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { runGraphAction, stopGroup, stopValidation } from '../../lib/actions'
import { revealTerminal } from '../../lib/attention'
import { taskActivities } from '../../lib/ipc'
import { applyTaskActivity } from '../../lib/tasks'
import { useStore } from '../../store'
import { parseSessionId, TASK_ROOT_SCOPE, PLAN_SCOPE } from '../../types'

export default function TaskActivityPanel() {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const groups = useStore((s) => s.groups)
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const action = useStore((s) => s.graphAction)
  const activities = useStore((s) => s.taskActivities)
  const savedReport = useStore((s) => s.graphActionReport)
  const records = useStore((s) => s.sessionRecords)
  useEffect(() => {
    if (!projectId) return
    void taskActivities(projectId)
      .then((list) => {
        for (const activity of list) applyTaskActivity(activity)
      })
      .catch((e) => useStore.getState().setMessage(String(e)))
  }, [projectId])
  const own = Object.values(activities).filter((a) => a.projectId === projectId && a.task === task)
  const initiatorLabel = (id: string) => {
    if (id === 'User') return id
    const record = records.find((r) => r.id === id)
    const component = parseSessionId(id).componentId
    const location =
      component === TASK_ROOT_SCOPE
        ? 'Task root'
        : component === PLAN_SCOPE
          ? 'Planner'
          : (nodes.find((n) => n.id === component)?.data.name ?? component)
    return `${location} · ${record?.metadata.name ?? 'Agent'}`
  }
  return (
    <div className="task-activity-panel">
      <div className="row task-actions">
        <select
          value=""
          disabled={busy || !groups.length}
          aria-label="Start environment"
          onChange={(e) => void runGraphAction({ kind: 'startGroup', groupId: e.target.value })}
        >
          <option value="" disabled>
            Start environment…
          </option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          value=""
          disabled={!groups.length}
          aria-label="Stop environment"
          onChange={(e) => void stopGroup(e.target.value)}
        >
          <option value="" disabled>
            Stop environment…
          </option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          value=""
          disabled={busy}
          aria-label="Validate affected components"
          onChange={(e) =>
            void runGraphAction({ kind: 'validateAffected', componentId: e.target.value })
          }
        >
          <option value="" disabled>
            Validate affected…
          </option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.data.name}
            </option>
          ))}
        </select>
        {busy && (
          <span role="status">
            {action?.kind === 'startGroup' ? 'Starting environment…' : 'Validating…'}
          </span>
        )}
        {busy && action?.kind === 'validateAffected' && (
          <button onClick={() => void stopValidation()}>Stop checks</button>
        )}
      </div>
      {!own.length && savedReport && (
        <details className="task-activity">
          <summary>Saved action report</summary>
          {!!savedReport.plan.skipped.length && (
            <p>Missing configured validators/tasks: {savedReport.plan.skipped.join(', ')}</p>
          )}
          {savedReport.results.map((result) => (
            <button
              key={result.sessionId}
              className="chip"
              onClick={() =>
                revealTerminal({
                  sid: result.sessionId,
                  componentId: parseSessionId(result.sessionId).componentId,
                })
              }
            >
              {parseSessionId(result.sessionId).terminalId}: {result.outcome}
            </button>
          ))}
        </details>
      )}
      {!!own.length && (
        <details className="task-activity">
          <summary>Activity · {own.length} actions</summary>
          {own
            .slice()
            .reverse()
            .map((activity) => (
              <div key={activity.id} className={`task-action-result ${activity.state}`}>
                <div className="row">
                  <strong>
                    {activity.action.kind === 'validate'
                      ? 'Validation'
                      : activity.action.kind === 'environmentStop'
                        ? 'Stop environment'
                        : 'Start environment'}{' '}
                    · {activity.state}
                  </strong>
                  <span className="hint flush" title={activity.initiator}>
                    {initiatorLabel(activity.initiator)}
                  </span>
                  {activity.state !== 'running' && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        activity.action.kind === 'environmentStop'
                          ? void stopGroup(activity.action.groupId!)
                          : void runGraphAction(
                              activity.action.kind === 'validate'
                                ? {
                                    kind: 'validateAffected',
                                    componentId: activity.action.componentId!,
                                  }
                                : { kind: 'startGroup', groupId: activity.action.groupId! },
                            )
                      }
                    >
                      Rerun
                    </button>
                  )}
                </div>
                {activity.error && <p className="hint file-tree-error">{activity.error}</p>}
                {!!activity.report?.plan.skipped.length && (
                  <p className="hint">
                    Missing configured validators/tasks:{' '}
                    {activity.report.plan.skipped
                      .map((id) => nodes.find((n) => n.id === id)?.data.name ?? id)
                      .join(', ')}
                  </p>
                )}
                <div className="scope-chips">
                  {activity.report?.results.map((result) => (
                    <button
                      key={result.sessionId}
                      className="chip"
                      onClick={() =>
                        revealTerminal({
                          sid: result.sessionId,
                          componentId: parseSessionId(result.sessionId).componentId,
                        })
                      }
                    >
                      {records.find((r) => r.id === result.sessionId)?.metadata.name ??
                        parseSessionId(result.sessionId).terminalId}
                      : {result.outcome}
                    </button>
                  ))}
                  {activity.previewUrls.map((url) => (
                    <button
                      key={url}
                      className="chip"
                      onClick={() =>
                        void openUrl(url).catch((e) => useStore.getState().setMessage(String(e)))
                      }
                    >
                      Open {url}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </details>
      )}
    </div>
  )
}
