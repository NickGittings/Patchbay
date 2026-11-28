import { useContext } from 'react'
import { useStore } from '../store'
import { WorktreeReaderContext } from './useStageModel'
import { chatAgentCards } from './chatAgents'
import { LEAD_HOME_TASK, useChatTeams } from './chatTeams'
import type { SimpleWorktree } from './simple'
import { useTeamWork, useWorkSessions } from './useTeamWork'
import { worktreeChip } from './worktreeLabel'

/**
 * The project's agents and the lead's assignments for the Agents tab. The project has one lead,
 * which works in every worktree, so the canvas shows all of them, each card saying where its agent
 * works. `worktree` is the focus: its agents stand out.
 */
export function useChatAgents(worktree: SimpleWorktree | undefined) {
  const records = useStore((s) => s.sessionRecords)
  const sessions = useWorkSessions()
  const simple = useStore((s) => s.simple)
  const tasks = useStore((s) => s.tasks)
  const teams = useChatTeams((s) => (worktree ? s.teams[worktree.projectId] : undefined))
  const runs = useChatTeams((s) => (worktree ? s.runs[worktree.projectId] : undefined))
  const team = teams?.find((t) => t.task === LEAD_HOME_TASK)
  const work = useTeamWork(team)
  // The project folder is git's main worktree.
  const projectBranch = useContext(WorktreeReaderContext)?.worktrees.find((w) => w.main)?.branch
  const focus = worktree?.task ?? null
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
        project: true,
        placeOf: (task) => worktreeChip(tasks, task, projectBranch).label,
      }).map((card) => ({ ...card, focused: card.worktree === focus }))
    : []
  return { cards, team, work }
}
