import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import type { AutoRun, AutoStage, EffortSettings, Severity } from '../../types'
import { autoSnapshot, EFFORT, inferStage, startAuto, STAGES, STAGE_LABELS } from '../../lib/auto'
import { agentDevices } from '../../lib/plan'
import { agentHooksCheck, agentProvider } from '../../lib/ipc'

export default function AutoDialog({ onIntegrations }: { onIntegrations: () => void }) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const devices = useStore((s) => s.devices)
  const agents = useMemo(() => agentDevices(devices), [devices])
  const [device, setDevice] = useState(agents[0]?.id ?? '')
  const [goal, setGoal] = useState('')
  const [effort, setEffort] = useState<AutoRun['effort']>('standard')
  const [overrides, setOverrides] = useState<Partial<EffortSettings>>({})
  const [mode, setMode] = useState<'ask' | 'auto'>('ask')
  const [destination, setDestination] = useState('')
  const [destinations, setDestinations] = useState<string[]>([])
  const [detected, setDetected] = useState('Detecting current work…')
  const [stage, setStage] = useState<AutoStage | ''>('')
  const [error, setError] = useState('')
  const [integrationCheck, setIntegrationCheck] = useState<{
    device: string
    devices: typeof devices
    installed: boolean
  } | null>(null)
  const integration =
    integrationCheck?.device === device &&
    integrationCheck.devices === devices &&
    integrationCheck.installed
  const requestKey = JSON.stringify([projectId, task, device, effort, overrides, mode, destination])
  const [loadedKey, setLoadedKey] = useState('')
  const loading = loadedKey !== requestKey
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    const run: AutoRun = {
      runId: '',
      status: 'running',
      stage: 'plan',
      goal: '',
      effort,
      overrides,
      merge: { mode, destinationBranch: destination },
      device,
      round: 0,
      log: [],
    }
    void autoSnapshot(projectId, task, run)
      .then((snapshot) => {
        if (cancelled) return
        setGoal((old) => old || snapshot.goal)
        const branches = snapshot.worktrees
          .filter((w) => w.branch && w.path !== snapshot.source.path)
          .map((w) => w.branch!)
        setDestinations(branches)
        setDestination(
          (old) =>
            old ||
            snapshot.worktrees.find((w) => w.current && w.path !== snapshot.source.path)?.branch ||
            '',
        )
        const decision = inferStage(snapshot, run)
        setDetected(`${STAGE_LABELS[decision.stage]} (${decision.reason})`)
        setError('')
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, task, device, effort, overrides, mode, destination, requestKey])
  useEffect(() => {
    const agent = agents.find((a) => a.id === device)
    let cancelled = false
    void (agent ? agentProvider(agent) : Promise.resolve(null))
      .then((provider) => (provider ? agentHooksCheck(provider) : null))
      .then((h) => {
        if (!cancelled)
          setIntegrationCheck({
            device,
            devices,
            installed: !!h && h.installed && !h.disabled && h.reporterAvailable,
          })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [device, devices, agents])
  const settings = { ...EFFORT[effort], ...overrides }
  return (
    <div className="auto-content">
      <strong>Auto mode</strong>
      <label>
        Task goal
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} />
      </label>
      <p>Starting at: {detected}</p>
      <label>
        Starting stage
        <select value={stage} onChange={(e) => setStage(e.target.value as AutoStage | '')}>
          <option value="">Use detected stage</option>
          {STAGES.filter((s) => s !== 'done').map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Fix effort
        <select
          value={effort}
          onChange={(e) => {
            setEffort(e.target.value as AutoRun['effort'])
            setOverrides({})
          }}
        >
          <option value="light">Light · 1 fix round</option>
          <option value="standard">Standard · 3 fix rounds</option>
          <option value="thorough">Thorough · 5 fix rounds</option>
        </select>
      </label>
      <details>
        <summary>Advanced</summary>
        <label>
          Maximum fix rounds
          <input
            type="number"
            min={0}
            max={100}
            value={settings.maxRounds}
            onChange={(e) =>
              setOverrides({
                ...overrides,
                maxRounds: Math.max(0, Math.min(100, Number(e.target.value))),
              })
            }
          />
        </label>
        <label>
          Lowest severity to fix
          <select
            value={settings.severityFloor}
            onChange={(e) =>
              setOverrides({ ...overrides, severityFloor: e.target.value as Severity })
            }
          >
            {['critical', 'high', 'medium', 'low'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.validate}
            onChange={(e) => setOverrides({ ...overrides, validate: e.target.checked })}
          />
          Validate after implementation and fixes
        </label>
      </details>
      <label>
        Merge
        <select value={mode} onChange={(e) => setMode(e.target.value as 'ask' | 'auto')}>
          <option value="ask">Ask before merging</option>
          <option value="auto">Merge automatically</option>
        </select>
      </label>
      <label>
        Destination branch
        <select value={destination} onChange={(e) => setDestination(e.target.value)}>
          <option value="">Choose a destination worktree</option>
          {destinations.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <label>
        Agent preset
        <select value={device} onChange={(e) => setDevice(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {!integration && (
        <p>
          Auto needs authoritative agent status.{' '}
          <button onClick={onIntegrations}>Agent status integration…</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={loading || starting || !integration || !destination || !goal.trim()}
        onClick={() => {
          if (!projectId) return
          setStarting(true)
          void startAuto(projectId, task, {
            goal,
            effort,
            overrides,
            merge: { mode, destinationBranch: destination },
            device,
            stage: stage || undefined,
          })
            .catch((e) => setError(String(e)))
            .finally(() => setStarting(false))
        }}
      >
        Start
      </button>
    </div>
  )
}
