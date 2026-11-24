import PanelSection, { PanelDetails } from '../PanelSection'
import { linkAutoStory } from '../../lib/stories'
import { logSimple } from '../../lib/simpleActions'
import { useContext, useEffect, useId, useMemo, useState } from 'react'
import ReviewerPicker from '../ReviewerPicker'
import MergeFields from './MergeFields'
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
  AutoHooksRequired,
  checkAutoHooks,
  EFFORT,
  inferStage,
  IN_PLACE_MERGE,
  type JudgedBase,
  reviewBaseMoved,
  runAgents as autoRunAgents,
  startAuto,
  STAGES,
  STAGE_LABELS,
  type AutoSnapshot,
} from '../../lib/auto'
import { ROLE_LABELS, roleDevice, roleDevices } from '../../lib/agentRoles'
import { agentDevices } from '../../lib/plan'
import { autoOverrides, defaultAutoEffort, integrated, MAX_ROUNDS } from '../../lib/autoSettings'
import { defaultMergeDestination, mergeDestinations } from '../../lib/reviewAgents'
import { SEVERITIES } from '../../types'
import {
  type AutoDraft,
  autoDraftKey,
  autoDrafts,
  emptyAutoDraft,
  savedAutoDraft,
} from '../../lib/autoDrafts'
import { seedAutoTask } from '../../lib/autoWorktree'
import { CloseMenu } from '../menuContext'
import type { HookProvider } from '../../lib/agentHooks'

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

export default function AutoDialog({
  onIntegrations,
  simple = false,
  focusGoal = false,
}: {
  onIntegrations: (provider?: HookProvider) => void
  simple?: boolean
  focusGoal?: boolean
}) {
  const projectId = useStore((s) => s.project?.id)
  const cleanup = useStore((s) => s.workspaceSettings.mergeCleanup)
  const task = useStore((s) => s.activeTask)
  const closeMenu = useContext(CloseMenu)
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const agents = useMemo(() => agentDevices(devices), [devices])
  // Closing the popover unmounts the dialog; what the user gave it waits for it to reopen.
  const draftKey = autoDraftKey(projectId, task)
  const [draft, setDraft] = useState<AutoDraft>(() => autoDrafts.get(draftKey) ?? emptyAutoDraft())
  // Only the user's changes are kept, so merely opening the dialog leaves no draft behind.
  const edit = (patch: Partial<AutoDraft>) =>
    changeDraft(draftKey, setDraft, (d) => ({ ...d, ...patch }), draft)
  // This run's choices; unpicked stages follow the global agent roles.
  const { picked, reviewers: pickedReviewers, overrides, mode, stage } = draft
  const effort = draft.replacementEffort ?? defaultAutoEffort(simple)
  const cleanupChoice =
    draft.cleanup ?? (cleanup === 'ask' || cleanup === 'delete' ? cleanup : 'keep')
  const [roundsEmpty, setRoundsEmpty] = useState(false)
  const reviewers = useMemo(() => {
    const kept = pickedReviewers && agents.filter((a) => pickedReviewers.includes(a.id))
    // Picks whose presets were all removed since give way to the role, as unpicked agents do.
    return (
      kept && (kept.length || !pickedReviewers.length)
        ? kept
        : roleDevices(devices, roles, 'review')
    ).map((a) => a.id)
  }, [agents, devices, pickedReviewers, roles])
  const scanners = useMemo(
    () =>
      (draft.scanners ?? roleDevices(devices, roles, 'scan').map((a) => a.id)).filter((id) =>
        agents.some((a) => a.id === id),
      ),
    [draft.scanners, devices, roles, agents],
  )
  const workers = useMemo(
    () =>
      (draft.workers ?? roleDevices(devices, roles, 'worker').map((a) => a.id)).filter((id) =>
        agents.some((a) => a.id === id),
      ),
    [draft.workers, devices, roles, agents],
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
  const distinct = useMemo(
    () => autoRunAgents({ device, agents: runAgents, reviewers, scanners, workers }),
    [device, runAgents, reviewers, scanners, workers],
  )
  // What the dialog fills in itself while the user hasn't: the inferred goal, withdrawn once a
  // load finds the branch merged, and the default destination branch.
  const [filled, setFilled] = useState({ goal: '', destination: '' })
  const goal = draft.goal ?? filled.goal
  const destination = draft.destination ?? filled.destination
  const [destinations, setDestinations] = useState<ReturnType<typeof mergeDestinations>>([])
  const [snapshot, setSnapshot] = useState<AutoSnapshot | null>(null)
  const [error, setError] = useState('')
  // A worktree with no branch to review against (the project folder on its default or only
  // branch) runs in place, with no merge.
  const inPlaceSnapshot = snapshot?.inPlace ? snapshot : null
  const judged = useMemo<JudgedBase | null>(
    () =>
      inPlaceSnapshot && {
        task,
        path: inPlaceSnapshot.source.path,
        inputs: inPlaceSnapshot.baseInputs,
        head: inPlaceSnapshot.base,
      },
    [inPlaceSnapshot, task],
  )
  // That form checks the base's inputs and HEAD on every Git refresh (focus, terminal exits, file
  // changes) and task list change, and loads again only once they changed, so a new commit shows
  // its sha, and a branch checked out or a worktree with a base attached offers a merge again.
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    if (!judged || !projectId) return
    // One check at a time; a refresh during one checks again after it.
    let checking = false
    let again = false
    let done = false
    const check = () => {
      checking = true
      again = false
      void reviewBaseMoved(projectId, judged)
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
  }, [judged, projectId])
  const [integrationCheck, setIntegrationCheck] = useState<{
    distinct: string[]
    devices: typeof devices
    installed: boolean
    provider?: HookProvider
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
      effort,
      merge: { mode: 'ask', destinationBranch: destination },
      device: '',
      round: 0,
      log: [],
    }
    // Inferring like Start does, so the preview shows the stage Start will pick.
    void autoSnapshot(projectId, task, run, true)
      .then((snapshot) => {
        if (cancelled) return
        const { source, worktrees, branches } = snapshot
        const destinations = mergeDestinations(source, worktrees, branches)
        setDestinations(destinations)
        // Merged work's plan is no goal for a new run.
        setFilled({
          goal: integrated(snapshot.outcome) ? '' : snapshot.goal,
          destination: defaultMergeDestination(source, worktrees, branches),
        })
        // A restored destination no longer offered gives way to the filled-in one, also when the
        // dialog reopens, so its first load doesn't preview the stale one again.
        changeDraft(draftKey, setDraft, (d) =>
          d.destination && !destinations.some(({ branch }) => branch === d.destination)
            ? { ...d, destination: undefined }
            : d,
        )
        setSnapshot(snapshot)
        setError('')
      })
      .catch((e) => {
        if (cancelled) return
        setSnapshot(null)
        setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, task, destination, draftKey, requestKey, recheck, effort])
  useEffect(() => {
    let cancelled = false
    void Promise.all(distinct.map(checkAutoHooks))
      .then(
        () => ({ installed: true }),
        (error: unknown) => ({
          installed: false,
          provider: error instanceof AutoHooksRequired ? error.provider : undefined,
        }),
      )
      .then((result) => {
        if (!cancelled) setIntegrationCheck({ distinct, devices, ...result })
      })
    return () => {
      cancelled = true
    }
  }, [distinct, devices])
  const merge: AutoRun['merge'] = inPlaceSnapshot
    ? IN_PLACE_MERGE
    : { mode, destinationBranch: destination, cleanup: cleanupChoice }
  const runOverrides = autoOverrides(simple, overrides)
  const settings = { ...EFFORT[effort], ...runOverrides }
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
        overrides: runOverrides,
        device,
        agents: runAgents,
        reviewers,
        scanners,
        workers,
        merge,
        baseCommit: inPlaceSnapshot?.base,
      },
      true,
    )
  const detectedId = useId()
  const detected = decision
    ? `${STAGE_LABELS[decision.stage]} (${decision.reason})`
    : 'Detecting current work…'

  return (
    <div className="auto-content">
      <div className="auto-goal-field">
        <label>
          Task goal
          <textarea
            autoFocus={focusGoal}
            value={goal}
            onChange={(e) => edit({ goal: e.target.value })}
            rows={4}
            aria-describedby={detectedId}
          />
        </label>
        {/* Described by, not part of the label, so the field's name stays "Task goal". */}
        <small id={detectedId} className="auto-hint" title={detected}>
          {decision ? (
            <>
              Starts at <strong>{STAGE_LABELS[decision.stage]}</strong> · {decision.reason}
            </>
          ) : (
            'Detecting current work…'
          )}
        </small>
      </div>
      <PanelSection title="Run">
        <div className="auto-fields">
          <label>
            Starting stage
            <select
              value={stage}
              onChange={(e) => edit({ stage: e.target.value as AutoStage | '' })}
            >
              <option value="">
                {decision ? `Detected (${STAGE_LABELS[decision.stage]})` : 'Use detected stage'}
              </option>
              {STAGES.filter(
                (s) => s !== 'done' && !(inPlaceSnapshot && (s === 'mergeGate' || s === 'merge')),
              ).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fix rounds
            <input
              type="number"
              min={0}
              max={MAX_ROUNDS}
              value={roundsEmpty ? '' : settings.maxRounds}
              onChange={(e) => {
                const rounds = e.target.valueAsNumber
                setRoundsEmpty(!Number.isFinite(rounds))
                if (!Number.isFinite(rounds)) return
                edit({
                  overrides: {
                    ...overrides,
                    maxRounds: Math.max(0, Math.min(MAX_ROUNDS, Math.round(rounds))),
                  },
                })
              }}
            />
          </label>
        </div>
        <div className="auto-toggles">
          <label className="auto-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={draft.autonomous === true}
              onChange={(e) => edit({ autonomous: e.target.checked })}
            />
            Autonomous execution
          </label>
          <label className="auto-toggle">
            <input
              type="checkbox"
              role="switch"
              disabled={draft.autonomous === true}
              checked={draft.autonomous === true || draft.background === true}
              onChange={(e) => edit({ background: e.target.checked })}
            />
            Keep going in background
          </label>
          <label className="auto-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={draft.resumeOnUsageReset === true}
              onChange={(e) => edit({ resumeOnUsageReset: e.target.checked })}
            />
            Resume when usage resets
          </label>
        </div>
      </PanelSection>
      <PanelSection title="Merge">
        <MergeFields
          inPlaceBase={
            inPlaceSnapshot && {
              branch: inPlaceSnapshot.source.branch ?? '',
              head: inPlaceSnapshot.base,
            }
          }
          mode={mode}
          onMode={(mode) => edit({ mode })}
          cleanup={cleanupChoice}
          destination={destination}
          destinations={destinations}
          onDestination={(destination) => edit({ destination })}
        />
        {inPlaceSnapshot && (
          <button
            className="auto-inline-action"
            onClick={() => {
              // Close the popover first, as the worktree picker does, so activating the new worktree
              // can't remount this dialog under the New worktree dialog before its draft moves.
              closeMenu()
              seedAutoTask(draftKey, goal, goal === filled.goal)
            }}
          >
            New worktree…
          </button>
        )}
      </PanelSection>
      <div className="auto-disclosures">
        <PanelDetails title="Agents">
          <fieldset className="auto-agents" aria-label="Agents">
            {AGENT_ROLES.map((stage) =>
              stage === 'scan' || stage === 'worker' ? (
                <div
                  key={stage}
                  className="auto-reviewers"
                  role="group"
                  aria-label={ROLE_LABELS[stage]}
                >
                  {ROLE_LABELS[stage]}
                  <ReviewerPicker
                    label={ROLE_LABELS[stage]}
                    agents={agents}
                    selected={stage === 'scan' ? scanners : workers}
                    dropdown
                    emptyLabel="Off"
                    onChange={(ids) =>
                      edit(stage === 'scan' ? { scanners: ids } : { workers: ids })
                    }
                  />
                </div>
              ) : stage === 'review' ? (
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
        </PanelDetails>
        {!simple && (
          <PanelDetails title="Advanced">
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
            <label className="auto-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={settings.validate}
                onChange={(e) => edit({ overrides: { ...overrides, validate: e.target.checked } })}
              />
              Validate after implementation and fixes
            </label>
          </PanelDetails>
        )}
      </div>
      {!integration && (
        <p className="auto-callout" data-tone="attention">
          Auto needs authoritative agent status.{' '}
          <button onClick={() => onIntegrations(integrationCheck?.provider)}>
            Agent status integration
          </button>
        </p>
      )}
      {error && (
        <p className="auto-callout" data-tone="bad" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary auto-start"
        disabled={
          loading ||
          starting ||
          roundsEmpty ||
          !integration ||
          (!inPlaceSnapshot && !destinations.some(({ branch }) => branch === destination)) ||
          !goal.trim() ||
          !reviewers.length
        }
        onClick={() => {
          if (!projectId) return
          const pendingStory = autoDrafts.get(draftKey)?.story
          setStarting(true)
          void startAuto(projectId, task, {
            goal,
            autonomous: draft.autonomous === true,
            background: draft.background === true,
            resumeOnUsageReset: draft.resumeOnUsageReset === true,
            effort,
            overrides: runOverrides,
            merge,
            device,
            agents: runAgents,
            reviewers: reviewers.length > 1 ? reviewers : undefined,
            scanners,
            workers,
            stage: stage || undefined,
          })
            .then(async () => {
              await linkAutoStory(projectId, task, pendingStory)
              autoDrafts.delete(draftKey)
              if (simple)
                logSimple(projectId, task, { kind: 'action', action: 'autopilot', stage: 'plan' })
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
