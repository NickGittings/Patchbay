import './provider-runs.css'
import { useEffect, useState } from 'react'
import { projectOf, useStore } from '../store'
import { PLAN_SCOPE, plannerSessionId } from '../types'
import { roleDevice, roleDevices } from '../lib/agentRoles'
import { unfinished } from '../lib/autoSettings'
import {
  controlProviderRun,
  createProviderRun,
  driveProviderRuns,
  providerRuns,
  type ProviderRun,
} from '../lib/orchestration'
import { startTerminal } from '../lib/sessions'
import TerminalPane from './TerminalPane'

/** Scan reports stay in Plan; assignment and integration results stay in Build. */
export default function ProviderRunsPanel({ kind }: { kind: ProviderRun['kind'] }) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const roles = useStore((s) => s.agentRoles)
  const devices = useStore((s) => s.devices)
  const highlighted = useStore((s) => s.highlighted)
  const auto = useStore((s) => s.auto)
  const records = useStore((s) => s.sessionRecords)
  const [runs, setRuns] = useState<ProviderRun[]>([])
  const [goal, setGoal] = useState('')
  const [editedGoal, setEditedGoal] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>()
  useEffect(() => {
    if (!projectId) return
    let disposed = false
    const load = () =>
      void providerRuns(projectId)
        .then((runs) => {
          if (!disposed) setRuns(runs.filter((r) => r.task === task && r.kind === kind))
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
    load()
    const timer = setInterval(load, 1500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [projectId, task, kind])
  const run = runs.at(-1)
  const shownGoal = editedGoal ? goal : (run?.goal ?? goal)
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const record = records.find((r) => r.id === selected)
  const scanners = roleDevices(devices, roles, 'scan')
  if (!run && (kind !== 'scan' || !scanners.length)) return null
  const active = run && !['stopped', 'complete'].includes(run.state)
  const autoActive = unfinished(auto?.status)
  return (
    <section
      className="provider-runs"
      aria-label={kind === 'scan' ? 'Scan findings' : 'Implementation assignments'}
    >
      {kind === 'scan' && !autoActive && !active && (
        <div className="row">
          <input
            aria-label="Scan goal"
            placeholder="Goal to investigate before planning"
            value={shownGoal}
            onChange={(e) => {
              setGoal(e.target.value)
              setEditedGoal(true)
            }}
          />
          <button
            disabled={busy || !shownGoal.trim() || !scanners.length}
            onClick={() =>
              void action(async () => {
                const project = projectId && projectOf(projectId)
                if (!project) return
                await createProviderRun(project, 'scan', shownGoal, highlighted, task, scanners)
                await driveProviderRuns(projectId!)
              })
            }
          >
            Scan and plan
          </button>
        </div>
      )}
      {run && (
        <>
          <div className="row">
            <strong>
              {kind === 'scan' ? 'Scans' : 'Assignments'} · {run.state}
            </strong>
            {active && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    controlProviderRun(projectId!, run.id, {
                      kind: run.state === 'paused' ? 'resume' : 'pause',
                    }),
                  )
                }
              >
                {run.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
            )}
            {active && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() => controlProviderRun(projectId!, run.id, { kind: 'stop' }))
                }
              >
                Stop
              </button>
            )}
            {kind === 'scan' && run.state === 'paused' && run.jobs.some((j) => j.report) && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    controlProviderRun(projectId!, run.id, { kind: 'continueScan' }),
                  )
                }
              >
                Continue with available findings
              </button>
            )}
            {kind === 'scan' && run.state === 'complete' && !autoActive && (
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const planner = roleDevice(devices, roles, 'plan')
                    const sid = plannerSessionId(planner.id, projectId)
                    if (useStore.getState().sessions[sid]?.running)
                      throw new Error(
                        'Close the current planner before starting with scan findings',
                      )
                    // The backend validates goal, scope and source again when the planner starts.
                    if (
                      JSON.stringify([...highlighted].sort()) !==
                        JSON.stringify([...run.components].sort()) ||
                      shownGoal !== run.goal
                    )
                      throw new Error('Goal or scope changed; start a new scan round')
                    await startTerminal(PLAN_SCOPE, planner.id, task, projectId, {
                      kickoff: { kind: 'plan' },
                      scanRound: run.id,
                      auto: {
                        goal: run.goal,
                        fixFloor: null,
                        effortNote: 'Resolve the independent scan findings before planning.',
                        commit: false,
                      },
                    })
                  })
                }
              >
                Start planner with findings
              </button>
            )}
          </div>
          {run.error && <p role="status">{run.error}</p>}
          <table>
            <thead>
              <tr>
                <th>Assignment</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Integration</th>
                <th>Terminal</th>
              </tr>
            </thead>
            <tbody>
              {[...(run.coordinator ? [run.coordinator] : []), ...run.jobs].map((job) => (
                <tr key={job.id}>
                  <td title={job.instructions}>
                    {job.id === run.coordinator?.id ? 'Coordinator' : job.instructions || 'Scan'}
                    {job.summary && <p>{job.summary}</p>}
                    {job.report && (
                      <details>
                        <summary>Report</summary>
                        <pre>{JSON.stringify(job.report, null, 2)}</pre>
                      </details>
                    )}
                    {job.error && <p>{job.error}</p>}
                  </td>
                  <td>
                    {job.terminal.name} ({job.preset})
                  </td>
                  <td>
                    {job.state}
                    {(job.state === 'failed' ||
                      (job.state === 'launching' && run.state === 'paused')) &&
                      run.state !== 'stopped' && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              controlProviderRun(projectId!, run.id, {
                                kind: 'retry',
                                job: job.id,
                              }),
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                  </td>
                  <td>{job.integratedHead ?? job.commit ?? '—'}</td>
                  <td>
                    {job.sessionId && (
                      <button
                        onClick={() =>
                          setSelected(selected === job.sessionId ? undefined : job.sessionId!)
                        }
                      >
                        Terminal
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {record && (
        <div style={{ height: 300 }}>
          <TerminalPane
            componentId={record.metadata.componentId}
            terminal={{
              id: record.metadata.terminalId,
              name: record.metadata.name,
              kind: 'agent',
              command: record.spec.command,
            }}
            existingSessionId={record.id}
            task={record.metadata.task ?? null}
          />
        </div>
      )}
    </section>
  )
}
