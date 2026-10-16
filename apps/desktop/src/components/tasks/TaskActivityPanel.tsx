import { useEffect, useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { runGraphAction, stopGroup, stopValidation } from '../../lib/actions'
import { revealTerminal } from '../../lib/attention'
import { taskActivities } from '../../lib/ipc'
import { applyTaskActivity } from '../../lib/tasks'
import {
  hasValidator,
  hasValidatorSuggestions,
  validatorKey,
  validatorSetup,
  type ValidatorSuggestion,
} from '../../lib/validators'
import { useStore } from '../../store'
import { parseSessionId, TASK_ROOT_SCOPE, PLAN_SCOPE } from '../../types'

/** Start or stop an environment group, or validate what a component change may affect. */
export function RunSelect() {
  const groups = useStore((s) => s.groups)
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const declined = useStore((s) => s.validatorDeclined)
  const validated = nodes.filter(hasValidator)
  // Check terminals that could become validators, until the user marks or declines them.
  const setup = useMemo(() => hasValidatorSuggestions(nodes, declined), [nodes, declined])
  if (!groups.length && !validated.length && !setup) return null
  return (
    <select
      value=""
      aria-label="Run"
      onChange={(e) => {
        const [kind, id] = e.target.value.split(':')
        if (kind === 'setup') useStore.setState({ activityPanelOpen: true })
        else if (kind === 'start') void runGraphAction({ kind: 'startGroup', groupId: id })
        else if (kind === 'stop') void stopGroup(id)
        else void runGraphAction({ kind: 'validateAffected', componentId: id })
      }}
    >
      <option value="" disabled>
        Run…
      </option>
      {!!groups.length && (
        <optgroup label="Start environment">
          {groups.map((g) => (
            <option key={g.id} value={`start:${g.id}`} disabled={busy}>
              {g.name}
            </option>
          ))}
        </optgroup>
      )}
      {!!groups.length && (
        <optgroup label="Stop environment">
          {groups.map((g) => (
            <option key={g.id} value={`stop:${g.id}`}>
              {g.name}
            </option>
          ))}
        </optgroup>
      )}
      {!!validated.length && (
        <optgroup label="Validate affected">
          {nodes.map((n) => (
            <option key={n.id} value={`validate:${n.id}`} disabled={busy}>
              {n.data.name}
            </option>
          ))}
        </optgroup>
      )}
      {setup && <option value="setup">Set up validation…</option>}
    </select>
  )
}

/** Loads the project's activity log and opens it from the project bar. */
export function ActivityButton() {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const activities = useStore((s) => s.taskActivities)
  useEffect(() => {
    if (!projectId) return
    void taskActivities(projectId)
      .then((list) => {
        for (const activity of list) applyTaskActivity(activity)
      })
      .catch((e) => useStore.getState().setMessage(String(e)))
  }, [projectId])
  if (!projectId) return null
  const running = Object.values(activities).some(
    (a) => a.projectId === projectId && a.task === task && a.state === 'running',
  )
  return (
    <button onClick={() => useStore.setState({ activityPanelOpen: true })}>
      Activity{running ? ' · running' : ''}
    </button>
  )
}

/** What a running graph action is doing, with a way to stop checks. */
export function ActivityStatus() {
  const busy = useStore((s) => s.graphActionBusy)
  const action = useStore((s) => s.graphAction)
  if (!busy) return null
  return (
    <div className="row task-actions">
      <span role="status">
        {action?.kind === 'startGroup' ? 'Starting environment…' : 'Validating…'}
      </span>
      {(action?.kind === 'validateAffected' || action?.kind === 'validateChanged') && (
        <button onClick={() => void stopValidation()}>Stop checks</button>
      )}
    </div>
  )
}

/** Offers to mark detected check terminals as validators; detectors never assign the role. */
function ValidatorSetup() {
  const nodes = useStore((s) => s.nodes)
  const declined = useStore((s) => s.validatorDeclined)
  const absent = useStore(
    (s) => !!s.activeProjectId && s.projects[s.activeProjectId]?.fingerprint === 'absent',
  )
  const updateTerminal = useStore((s) => s.updateTerminal)
  const declineValidators = useStore((s) => s.declineValidators)
  const restoreValidators = useStore((s) => s.restoreValidators)
  // Rows the user ticked; none start checked, since only the user knows which ones exit.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const [marked, setMarked] = useState(0)
  const {
    suggestions,
    missing,
    declined: hidden,
  } = useMemo(() => validatorSetup(nodes, declined), [nodes, declined])
  const restore = !!hidden && (
    <button onClick={restoreValidators}>
      Show {hidden === 1 ? '1 dismissed check' : `${hidden} dismissed checks`}
    </button>
  )
  // Only dismissed suggestions left: a compact line to bring them back.
  if (!suggestions.length && !marked) return restore ? <div className="row">{restore}</div> : null
  const key = (s: ValidatorSuggestion) => validatorKey(s.componentId, s.terminalId)
  const checked = (s: ValidatorSuggestion) => ticked.has(key(s))
  const chosen = suggestions.filter(checked)
  return (
    <div className="task-action-result">
      <strong>Set up validation</strong>
      {!!suggestions.length && (
        <p className="hint">
          Tick checks that exit on their own: validation waits for them (also in{' '}
          <code>agent validate</code>), so never pick a watch mode or server.
        </p>
      )}
      {suggestions.map((s) => (
        <label key={key(s)} className="row">
          <input
            type="checkbox"
            checked={checked(s)}
            onChange={(e) => {
              const on = e.target.checked
              setTicked((prev) => {
                const next = new Set(prev)
                if (on) next.add(key(s))
                else next.delete(key(s))
                return next
              })
            }}
          />
          {s.componentName} › {s.terminalName} <span className="mono hint flush">{s.command}</span>
        </label>
      ))}
      {!!suggestions.length && !!missing.length && (
        <p className="hint">
          No check terminal: {missing.map((c) => c.data.name).join(', ')} (add one in the Inspector
          with Graph action Validation).
        </p>
      )}
      {!!marked && (
        <p className="hint" role="status">
          Marked {marked === 1 ? 'a terminal' : `${marked} terminals`} as Validation.{' '}
          {absent
            ? 'The map isn’t saved yet: choose Create map configuration in the map status menu to keep them.'
            : 'The change saves to patchbay.json with the map (see the map status).'}
        </p>
      )}
      <div className="row">
        {!!suggestions.length && (
          <>
            <button
              disabled={!chosen.length}
              onClick={() => {
                for (const s of chosen)
                  updateTerminal(s.componentId, s.terminalId, { action: 'validation' })
                setMarked((n) => n + chosen.length)
              }}
            >
              Mark as Validation
            </button>
            {/* Declined suggestions stay hidden, here and in the Run menu, for this project. */}
            <button onClick={() => declineValidators(suggestions.map(key))}>Dismiss</button>
          </>
        )}
        {restore}
      </div>
    </div>
  )
}

export default function TaskActivityPanel() {
  const open = useStore((s) => s.activityPanelOpen)
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const tasks = useStore((s) => s.tasks)
  const nodes = useStore((s) => s.nodes)
  const busy = useStore((s) => s.graphActionBusy)
  const activities = useStore((s) => s.taskActivities)
  const records = useStore((s) => s.sessionRecords)
  if (!open || !projectId) return null
  const close = () => useStore.setState({ activityPanelOpen: false })
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
  const worktree = tasks.find((t) => t.id === task)?.title ?? 'Main worktree'
  return (
    <div className="extension-overlay" onClick={close}>
      <div
        className="sessions-panel task-activity-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Worktree activity"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h2>Activity · {worktree}</h2>
          <span className="spacer" />
          <button onClick={close}>Close</button>
        </div>
        <p>Environments started or stopped and validations run in this worktree.</p>
        <ActivityStatus />
        <ValidatorSetup key={projectId} />
        {!own.length && <p>No activity in this worktree.</p>}
        <div className="task-activity">
          {own
            .slice()
            .reverse()
            .map((activity) => (
              <div key={activity.id} className={`task-action-result ${activity.state}`}>
                <div className="row">
                  <strong>
                    {['validate', 'validateChanged'].includes(activity.action.kind)
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
                                : activity.action.kind === 'validateChanged'
                                  ? {
                                      kind: 'validateChanged',
                                      componentIds: activity.action.componentIds!,
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
        </div>
      </div>
    </div>
  )
}
