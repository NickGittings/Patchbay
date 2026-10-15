import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import {
  AGENT_ROLES,
  type AgentRole,
  type AutoRun,
  type AutoStage,
  type EffortSettings,
  type Severity,
} from '../../types'
import {
  autoSnapshot,
  checkAutoHooks,
  EFFORT,
  inferStage,
  startAuto,
  STAGES,
  STAGE_LABELS,
  type AutoSnapshot,
} from '../../lib/auto'
import { ROLE_LABELS, roleDevice, roleDevices } from '../../lib/agentRoles'
import { agentDevices } from '../../lib/plan'
import { integrated, MAX_ROUNDS, SEVERITIES } from '../../lib/autoSettings'

export default function AutoDialog({ onIntegrations }: { onIntegrations: () => void }) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const agents = useMemo(() => agentDevices(devices), [devices])
  // This run's choices; unpicked stages follow the project's agent roles.
  const [picked, setPicked] = useState<Partial<Record<AgentRole, string>>>({})
  const [pickedReviewers, setReviewers] = useState<string[]>()
  const reviewers = useMemo(
    () =>
      (pickedReviewers
        ? agents.filter((a) => pickedReviewers.includes(a.id))
        : roleDevices(devices, roles, 'review')
      ).map((a) => a.id),
    [agents, devices, pickedReviewers, roles],
  )
  const runAgents = useMemo(() => {
    const out = {} as Record<AgentRole, string>
    const fallback = { implement: 'plan', fix: 'review' } as Partial<Record<AgentRole, AgentRole>>
    for (const stage of AGENT_ROLES) {
      const choice = agents.find((a) =>
        stage === 'review' ? a.id === reviewers[0] : a.id === picked[stage],
      )
      const after = fallback[stage]
      out[stage] = (
        choice ??
        roleDevice(devices, roles, stage, after && agents.find((a) => a.id === out[after]))
      ).id
    }
    return out
  }, [agents, devices, picked, reviewers, roles])
  const device = runAgents.plan
  const distinct = [...new Set([...Object.values(runAgents), ...reviewers])].join(',')
  const [goal, setGoal] = useState('')
  // The goal this dialog filled in itself, withdrawn once a load finds the branch merged.
  const filledGoal = useRef('')
  const [effort, setEffort] = useState<AutoRun['effort']>('standard')
  const [overrides, setOverrides] = useState<Partial<EffortSettings>>({})
  const [mode, setMode] = useState<'ask' | 'auto'>('ask')
  const [destination, setDestination] = useState('')
  const [destinations, setDestinations] = useState<string[]>([])
  const [snapshot, setSnapshot] = useState<AutoSnapshot | null>(null)
  const [stage, setStage] = useState<AutoStage | ''>('')
  const [error, setError] = useState('')
  const [integrationCheck, setIntegrationCheck] = useState<{
    distinct: string
    devices: typeof devices
    installed: boolean
  } | null>(null)
  const integration =
    integrationCheck?.distinct === distinct &&
    integrationCheck.devices === devices &&
    integrationCheck.installed
  const requestKey = JSON.stringify([projectId, task, destination])
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
      effort: 'standard',
      merge: { mode: 'ask', destinationBranch: destination },
      device: '',
      round: 0,
      log: [],
    }
    // Inferring like Start does, so the preview shows the stage Start will pick.
    void autoSnapshot(projectId, task, run, true)
      .then((snapshot) => {
        if (cancelled) return
        // Merged work's plan is no goal for a new run. Without a destination the outcome is
        // unknown, so a goal filled in then is withdrawn once a later load finds it merged.
        if (!integrated(snapshot.outcome)) {
          filledGoal.current ||= snapshot.goal
          setGoal((old) => old || snapshot.goal)
        } else {
          const filled = filledGoal.current
          filledGoal.current = ''
          setGoal((old) => (filled && old === filled ? '' : old))
        }
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
        setSnapshot(snapshot)
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
  }, [projectId, task, destination, requestKey])
  useEffect(() => {
    let cancelled = false
    void Promise.all(distinct.split(',').map((id) => checkAutoHooks(id)))
      .then(
        () => true,
        () => false,
      )
      .then((installed) => {
        if (!cancelled) setIntegrationCheck({ distinct, devices, installed })
      })
    return () => {
      cancelled = true
    }
  }, [distinct, devices])
  const settings = { ...EFFORT[effort], ...overrides }
  const decision =
    snapshot &&
    inferStage(
      snapshot,
      {
        runId: '',
        stage: 'plan',
        status: 'running',
        round: 0,
        log: [],
        goal,
        effort,
        overrides,
        device,
        agents: runAgents,
        reviewers,
        merge: { mode, destinationBranch: destination },
      },
      true,
    )
  const detected = decision
    ? `${STAGE_LABELS[decision.stage]} (${decision.reason})`
    : 'Detecting current work…'

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
            max={MAX_ROUNDS}
            value={settings.maxRounds}
            onChange={(e) =>
              setOverrides({
                ...overrides,
                maxRounds: Math.max(
                  0,
                  Math.min(MAX_ROUNDS, Math.round(Number(e.target.value) || 0)),
                ),
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
            {SEVERITIES.map((s) => (
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
      <fieldset className="auto-agents">
        <legend>Agents</legend>
        {AGENT_ROLES.map((stage) =>
          stage === 'review' && agents.length > 1 ? (
            <div key={stage} className="auto-reviewers" role="group" aria-label="Reviewers">
              {ROLE_LABELS[stage]}
              {agents.map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={reviewers.includes(a.id)}
                    onChange={(e) =>
                      setReviewers(
                        agents
                          .filter((r) => (r === a ? e.target.checked : reviewers.includes(r.id)))
                          .map((r) => r.id),
                      )
                    }
                  />{' '}
                  {a.name}
                </label>
              ))}
            </div>
          ) : (
            <label key={stage}>
              {ROLE_LABELS[stage]}
              <select
                value={runAgents[stage]}
                onChange={(e) => setPicked({ ...picked, [stage]: e.target.value })}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ),
        )}
      </fieldset>
      {!integration && (
        <p>
          Auto needs authoritative agent status.{' '}
          <button onClick={onIntegrations}>Agent status integration…</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={
          loading || starting || !integration || !destination || !goal.trim() || !reviewers.length
        }
        onClick={() => {
          if (!projectId) return
          setStarting(true)
          void startAuto(projectId, task, {
            goal,
            effort,
            overrides,
            merge: { mode, destinationBranch: destination },
            device,
            agents: runAgents,
            reviewers: reviewers.length > 1 ? reviewers : undefined,
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
