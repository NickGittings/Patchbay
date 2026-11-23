import { useStore } from '../store'
import { chatAgentCards } from './chatAgents'
import { useChatTeams } from './chatTeams'
import type { SimpleWorktree } from './simple'
import { useTeamWork, useWorkSessions } from './useTeamWork'

/** The active worktree's agents and team assignments for the Agents tab. */
export function useChatAgents(worktree: SimpleWorktree | undefined) {
  const records = useStore((s) => s.sessionRecords)
  const sessions = useWorkSessions()
  const simple = useStore((s) => s.simple)
  const simpleMode = useStore((s) => s.simpleMode)
  const teams = useChatTeams((s) => (worktree ? s.teams[worktree.projectId] : undefined))
  const runs = useChatTeams((s) => (worktree ? s.runs[worktree.projectId] : undefined))
  const team = teams?.find((t) => t.task === worktree?.task)
  const work = useTeamWork(team)
  const cards = worktree
    ? chatAgentCards({
        records,
        sessions,
        simple,
        worktree,
        team,
        teams,
        runs,
        jobs: work.jobs,
        allJobs: work.allJobs,
        includeSharedPlanners: !simpleMode,
      })
    : []
  return { cards, team, work }
}
