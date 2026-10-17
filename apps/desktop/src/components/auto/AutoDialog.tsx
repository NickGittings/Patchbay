import { useContext, useEffect, useMemo, useState } from 'react'
import ReviewerPicker from '../ReviewerPicker'
import { useStore } from '../../store'
import {
  AGENT_ROLES,
  type AgentRole,
  type AutoRun,
  type AutoStage,
  type Severity,
} from '../../types'
import {
  autoSnapshot,
  checkAutoHooks,
  EFFORT,
  inferStage,
  NoReviewBase,
  reviewBaseMoved,
  startAuto,
  STAGES,
  STAGE_LABELS,
  type AutoSnapshot,
  wantsNewWorktree,
} from '../../lib/auto'
import { ROLE_LABELS, roleDevice, roleDevices } from '../../lib/agentRoles'
import { agentDevices } from '../../lib/plan'
import { integrated, MAX_ROUNDS, SEVERITIES } from '../../lib/autoSettings'
import {
  type AutoDraft,
  autoDraftKey,
  autoDrafts,
  emptyAutoDraft,
  savedAutoDraft,
} from '../../lib/autoDrafts'
import { seedAutoTask } from '../../lib/autoWorktree'
import { CloseMenu } from '../menuContext'

/**
 * Apply one change to the draft shown and the one kept under `key`: to a kept draft, else, for the
 * user's own edit, to the `shown` one.
 */
function changeDraft(
  key: string,
  setDraft: (change: (d: AutoDraft) => AutoDraft) => void,
  change: (d: AutoDraft) => AutoDraft,
  shown?: AutoDraft,
) {
  setDraft(change)
  const kept = autoDrafts.get(key) ?? shown
  if (kept) autoDrafts.set(key, savedAutoDraft(change(kept)))
}

export default function AutoDialog({ onIntegrations }: { onIntegrations: () => void }) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const closeMenu = useContext(CloseMenu)
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const agents = useMemo(() => agentDevices(devices), [devices])
  // Closing the popover unmounts the dialog; what the user gave it waits for it to reopen.
  const draftKey = autoDraftKey(projectId, task)
  const [draft, setDraft] = useState(() => autoDrafts.get(draftKey) ?? emptyAutoDraft())
  // Only the user's changes are kept, so merely opening the dialog leaves no draft behind.
  const edit = (patch: Partial<AutoDraft>) =>
    changeDraft(draftKey, setDraft, (d) => ({ ...d, ...patch }), draft)
  // This run's choices; unpicked stages follow the project's agent roles.
  const { picked, reviewers: pickedReviewers, effort, overrides, mode, stage } = draft
  const reviewers = useMemo(() => {
    const kept = pickedReviewers && agents.filter((a) => pickedReviewers.includes(a.id))
    // Picks whose presets were all removed since give way to the role, as unpicked agents do.
    return (
      kept && (kept.length || !pickedReviewers.length)
        ? kept
        : roleDevices(devices, roles, 'review')
    ).map((a) => a.id)
  }, [agents, devices, pickedReviewers, roles])
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
  const distinct = useMemo(
    () => [...new Set([...Object.values(runAgents), ...reviewers])],
    [runAgents, reviewers],
  )
  // What the dialog fills in itself while the user hasn't: the inferred goal, withdrawn once a
  // load finds the branch merged, and the current worktree's branch as the destination.
  const [filled, setFilled] = useState({ goal: '', destination: '' })
  const goal = draft.goal ?? filled.goal
  const destination = draft.destination ?? filled.destination
  const [destinations, setDestinations] = useState<string[]>([])
  const [snapshot, setSnapshot] = useState<AutoSnapshot | null>(null)
  const [error, setError] = useState('')
  // The worktree's branch can't be reviewed or merged into itself, so the run needs a new one.
  const [needsWorktree, setNeedsWorktree] = useState<NoReviewBase | null>(null)
  // That view checks the base's inputs on every Git refresh (focus, terminal exits, file changes)
  // and task list change, and loads again only once they changed, so a branch checked out or a
  // worktree with a base attached meanwhile leaves it.
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    if (!needsWorktree || !projectId) return
    // One check at a time; a refresh during one checks again after it.
    let checking = false
    let again = false
    let done = false
    const check = () => {
      checking = true
      again = false
      void reviewBaseMoved(projectId, needsWorktree)
        .then((moved) => {
          if (moved && !done) setRecheck((n) => n + 1)
          return moved
        })
        .catch(() => false)
        .then((moved) => {
          checking = false
          if (again && !moved && !done) check()
        })
    }
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.gitChanges === prev.gitChanges && s.tasks === prev.tasks) return
      if (checking) again = true
      else check()
    })
    return () => {
      done = true
      unsubscribe()
    }
  }, [needsWorktree, projectId])
  const [integrationCheck, setIntegrationCheck] = useState<{
    distinct: string[]
    devices: typeof devices
    installed: boolean
  } | null>(null)
  const integration =
    integrationCheck?.distinct === distinct &&
    integrationCheck.devices === devices &&
    integrationCheck.installed
  const requestKey = JSON.stringify([draftKey, destination])
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
        const branches = snapshot.worktrees
          .filter((w) => w.branch && w.path !== snapshot.source.path)
          .map((w) => w.branch!)
        setDestinations(branches)
        // Merged work's plan is no goal for a new run. Without a destination the outcome is
        // unknown, so a goal filled in then is withdrawn once a later load finds it merged.
        setFilled({
          goal: integrated(snapshot.outcome) ? '' : snapshot.goal,
          destination:
            snapshot.worktrees.find((w) => w.current && w.path !== snapshot.source.path)?.branch ||
            '',
        })
        // A restored destination no longer offered gives way to the filled-in one, also when the
        // dialog reopens, so its first load doesn't preview the stale one again.
        changeDraft(draftKey, setDraft, (d) =>
          d.destination && !branches.includes(d.destination) ? { ...d, destination: undefined } : d,
        )
        setSnapshot(snapshot)
        setError('')
        setNeedsWorktree(null)
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof NoReviewBase && wantsNewWorktree(e)) {
          setNeedsWorktree(e)
          setError('')
        } else {
          setNeedsWorktree(null)
          setError(String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, task, destination, draftKey, requestKey, recheck])
  useEffect(() => {
    let cancelled = false
    void Promise.all(distinct.map(checkAutoHooks))
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

  if (needsWorktree)
    return (
      <div className="auto-content">
        <strong>Auto mode</strong>
        <p>
          Auto needs a branch other than {needsWorktree.branch}; create a worktree for this task.
        </p>
        <label>
          Task goal
          <textarea value={goal} onChange={(e) => edit({ goal: e.target.value })} rows={4} />
        </label>
        {/* The goal shown titles the worktree; only a typed one moves, since the copied project
            plan fills in the same goal there. */}
        <button
          onClick={() => {
            // Close the popover first, as the worktree picker does, so activating the new worktree
            // can't remount this dialog under the New worktree dialog before its draft moves.
            closeMenu()
            seedAutoTask(draftKey, goal, goal === filled.goal)
          }}
        >
          New worktree…
        </button>
      </div>
    )
  return (
    <div className="auto-content">
      <strong>Auto mode</strong>
      <label>
        Task goal
        <textarea value={goal} onChange={(e) => edit({ goal: e.target.value })} rows={4} />
      </label>
      <p>Starting at: {detected}</p>
      <label>
        Starting stage
        <select value={stage} onChange={(e) => edit({ stage: e.target.value as AutoStage | '' })}>
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
          onChange={(e) => edit({ effort: e.target.value as AutoRun['effort'], overrides: {} })}
        >
          <option value="light">Light (1 fix round)</option>
          <option value="standard">Standard (3 fix rounds)</option>
          <option value="thorough">Thorough (5 fix rounds)</option>
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
              edit({
                overrides: {
                  ...overrides,
                  maxRounds: Math.max(
                    0,
                    Math.min(MAX_ROUNDS, Math.round(Number(e.target.value) || 0)),
                  ),
                },
              })
            }
          />
        </label>
        <label>
          Lowest severity to fix
          <select
            value={settings.severityFloor}
            onChange={(e) =>
              edit({ overrides: { ...overrides, severityFloor: e.target.value as Severity } })
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
            onChange={(e) => edit({ overrides: { ...overrides, validate: e.target.checked } })}
          />
          Validate after implementation and fixes
        </label>
      </details>
      <label>
        Merge
        <select value={mode} onChange={(e) => edit({ mode: e.target.value as 'ask' | 'auto' })}>
          <option value="ask">Ask before merging</option>
          <option value="auto">Merge automatically</option>
        </select>
      </label>
      <label>
        Destination branch
        <select value={destination} onChange={(e) => edit({ destination: e.target.value })}>
          <option value="">Choose a destination worktree</option>
          {destinations.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <fieldset className="auto-agents">
        <legend>Agents</legend>
        {AGENT_ROLES.map((stage) =>
          stage === 'review' ? (
            <div key={stage} className="auto-reviewers" role="group" aria-label="Reviewers">
              {ROLE_LABELS[stage]}
              <ReviewerPicker
                agents={agents}
                selected={reviewers}
                onChange={(reviewers) => edit({ reviewers })}
                dropdown
              />
            </div>
          ) : (
            <label key={stage}>
              {ROLE_LABELS[stage]}
              <select
                value={runAgents[stage]}
                onChange={(e) => edit({ picked: { ...picked, [stage]: e.target.value } })}
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
          <button onClick={onIntegrations}>Agent status integration</button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={
          loading ||
          starting ||
          !integration ||
          !destinations.includes(destination) ||
          !goal.trim() ||
          !reviewers.length
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
            .then(() => autoDrafts.delete(draftKey))
            .catch((e) => setError(String(e)))
            .finally(() => setStarting(false))
        }}
      >
        Start
      </button>
    </div>
  )
}
