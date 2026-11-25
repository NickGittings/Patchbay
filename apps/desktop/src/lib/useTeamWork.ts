import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { SessionState } from '../types'
import { controlTeam, RESTART_NOTICE, useChatTeams, type ChatTeam } from './chatTeams'
import { failedJob, teamJobs, workerStatus } from './chatProgress'
import type { ProviderJob } from './orchestration'
import { simpleKey, useSimpleUi } from './simpleUi'

/** A job's current result: a retry or a new failure is a new result, so it shows again. */
const dismissalKey = (job: ProviderJob) => JSON.stringify([job.requestId, job.state, job.error])

/** The parts of each session that decide who is listed and what state their work is in. */
const workKey = (sessions: Record<string, SessionState>) =>
  Object.entries(sessions)
    .map(([id, s]) => [id, s.running, s.generation, s.startedMs, s.status?.agent?.state].join(':'))
    .join('|')

/**
 * The session map, replaced only when `workKey` changes. Agent lists and counts stay mounted
 * through Chat, and terminal output and activity updates must not rebuild them.
 */
export function useWorkSessions() {
  const key = useStore((s) => workKey(s.sessions))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is what invalidates this read.
  return useMemo(() => useStore.getState().sessions, [key])
}

/** The team's assignments, split by whether the user dismissed their current result. */
export function useTeamWork(team: ChatTeam | undefined) {
  const runs = useChatTeams((s) => (team ? s.runs[team.projectId] : undefined))
  const sessions = useWorkSessions()
  const key = simpleKey(team?.projectId, team?.task ?? null)
  const dismissedKeys = useSimpleUi((s) => s.worktrees[key]?.dismissedAssignments)
  const teamId = team?.id
  const allJobs = useMemo(() => (teamId ? teamJobs(runs ?? [], teamId) : []), [runs, teamId])
  const isDismissed = (job: ProviderJob) => !!dismissedKeys?.includes(dismissalKey(job))
  const jobs = allJobs.filter((job) => !isDismissed(job))
  const restartNotice = team?.error === RESTART_NOTICE
  const issues = {
    teamError: !!team?.error && !restartNotice,
    // A failed request's result goes to the lead, which reports it; only an unconfirmed one needs
    // the user to check what happened.
    requests: (team?.requests ?? []).filter((r) => r.state === 'uncertain'),
    messages: (team?.messages ?? []).filter((m) => m.state === 'uncertain'),
  }
  // Reads the store at click time, so quick successive dismissals never overwrite each other,
  // and keeps only keys for current results, so the persisted list cannot grow without bound.
  const setDismissed = useCallback(
    (job: ProviderJob, dismissed: boolean) => {
      const ui = useSimpleUi.getState()
      const live = new Set(allJobs.map(dismissalKey))
      const id = dismissalKey(job)
      const kept = (ui.worktrees[key]?.dismissedAssignments ?? []).filter(
        (k) => live.has(k) && k !== id,
      )
      ui.patch(key, { dismissedAssignments: dismissed ? [...kept, id] : kept })
    },
    [allJobs, key],
  )
  return {
    sessions,
    allJobs,
    jobs,
    dismissed: allJobs.filter(isDismissed),
    failures: jobs.filter(failedJob),
    asking: jobs.filter((job) => workerStatus(job, sessions) === 'awaiting input'),
    restartNotice,
    issues,
    setDismissed,
  }
}
export type TeamWork = ReturnType<typeof useTeamWork>

/** How many items need the user, and what they are in words. */
export function teamFlags(work: TeamWork, team: ChatTeam | undefined) {
  const { teamError, requests, messages } = work.issues
  const coordination =
    Number(teamError) + Number(!!team?.reset?.error) + requests.length + messages.length
  return {
    flagged: work.failures.length + work.asking.length + coordination,
    details: [
      work.failures.length && `${work.failures.length} failed`,
      work.asking.length && `${work.asking.length} awaiting input`,
      coordination && `${coordination} coordination ${coordination === 1 ? 'issue' : 'issues'}`,
    ].filter((detail): detail is string => !!detail),
  }
}

export function useTeamAction(team: ChatTeam) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const act = (control: Parameters<typeof controlTeam>[1]) => run(() => controlTeam(team, control))
  return { act, run, busy, error }
}
