import { useStore } from '../store'
import type { AutoRun, SessionState } from '../types'
import { autoRun, pauseAuto, resumeAuto, stopAuto } from './auto'
import { sameAutoRun } from './autoState'
import { controlTeam, readChatTeams, teamFor, useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'
import {
  autoBlocker,
  WorkBlocker,
  workError,
  worktreeLabel,
  worktreeIdentity,
  type WorkTarget,
} from './workBlocker'

export type WorkCommand = 'pause' | 'continue' | 'stop'

export function workSelection(command: WorkCommand, team?: ChatTeam, auto?: AutoRun | null) {
  return {
    team:
      team &&
      (command === 'pause'
        ? team.state === 'running'
        : command === 'continue'
          ? ['paused', 'stopped'].includes(team.state)
          : ['running', 'paused'].includes(team.state))
        ? team
        : undefined,
    auto:
      auto &&
      (command === 'pause'
        ? ['running', 'waitingOnYou'].includes(auto.status)
        : command === 'continue'
          ? auto.status === 'paused'
          : !['done', 'stopped'].includes(auto.status))
        ? auto
        : undefined,
  }
}

export function teamResumeBlocker(team: ChatTeam, runs: ProviderRun[], session?: SessionState) {
  const refresh = { kind: 'refreshLead' as const, projectId: team.projectId }
  if (session?.generation !== undefined && session.generation !== team.lead.generation)
    return new WorkBlocker(
      'The lead’s session changed. Refresh lead state before continuing.',
      refresh,
    )
  if (team.reset?.phase === 'launching')
    return new WorkBlocker(
      'The lead replacement is still starting. Refresh lead state once it settles.',
      refresh,
    )
  const failed = runs
    .filter((r) => r.chatTeam === team.id && r.state === 'paused')
    .flatMap((r) => r.jobs)
    .find((j) => j.state === 'failed')
  if (failed)
    return new WorkBlocker(`Retry ${failed.terminal.name} before continuing Chat coordination.`, {
      kind: 'failedWorker',
      assignment: failed.id,
      name: failed.terminal.name,
      target: { projectId: team.projectId, task: team.task },
    })
}

export function sameTeam(expected: ChatTeam, current?: ChatTeam) {
  return (
    current?.id === expected.id &&
    current.state === expected.state &&
    current.target === expected.target &&
    current.lead.sessionId === expected.lead.sessionId &&
    current.lead.generation === expected.lead.generation &&
    current.reset?.id === expected.reset?.id &&
    current.reset?.phase === expected.reset?.phase
  )
}

type Selection = ReturnType<typeof workSelection>
export type WorkOutcome = { target: string; result: string | Error }

const SUCCESS = { pause: 'paused', continue: 'continued', stop: 'stopped' }

/** Run only the captured targets. Every target reports independently, including a stale one. */
export async function applyWorkSelection(
  command: WorkCommand,
  selected: Selection,
  operations: { team: (team: ChatTeam) => Promise<void>; auto: (auto: AutoRun) => Promise<void> },
): Promise<WorkOutcome[]> {
  const outcomes: WorkOutcome[] = []
  const apply = async (target: string, action: () => Promise<void>) => {
    try {
      await action()
      outcomes.push({ target, result: SUCCESS[command] })
    } catch (error) {
      outcomes.push({ target, result: workError(error) })
    }
  }
  // For Pause and Stop, settle Auto first. A subsequent Chat continuation can then take ownership.
  // For Continue, attempt Chat before Auto reacquires the worktree.
  const auto = selected.auto && (() => apply('Auto', () => operations.auto(selected.auto!)))
  if (command !== 'continue' && auto) await auto()
  if (selected.team) await apply('Chat coordination', () => operations.team(selected.team!))
  if (command === 'continue' && auto) await auto()
  return outcomes
}

export async function controlWork(
  command: WorkCommand,
  target: WorkTarget,
  tree: string | undefined,
  selection: Selection,
) {
  const { projectId, task } = target
  const checkWorktree = () => {
    const current = useStore.getState()
    if (
      !tree ||
      current.project?.id !== projectId ||
      current.activeTask !== task ||
      worktreeIdentity(target) !== tree
    )
      throw new Error('The worktree changed. Open the intended worktree and try again.')
    return current
  }
  return applyWorkSelection(command, selection, {
    team: async (expected) => {
      checkWorktree()
      const changed = () =>
        new WorkBlocker('Chat coordination changed. Refresh lead state and try again.', {
          kind: 'refreshLead',
          projectId,
        })
      const live = (await readChatTeams(projectId)).find((team) => team.task === task)
      const current = checkWorktree()
      if (!live || !sameTeam(expected, live) || !sameTeam(expected, teamFor(projectId, task)))
        throw changed()
      if (command === 'continue') {
        const blocker = teamResumeBlocker(
          live,
          useChatTeams.getState().runs[projectId] ?? [],
          current.sessions[live.lead.sessionId],
        )
        if (blocker) throw blocker
      }
      try {
        await controlTeam(live, { kind: command === 'continue' ? 'resume' : command })
      } catch (error) {
        if (command !== 'continue') throw error
        const held = autoBlocker(projectId, task)
        if (held)
          throw new WorkBlocker(`${workError(error).message}\n${held.message}`, held.recovery)
        throw new WorkBlocker(
          `${workError(error).message} Refresh lead state and retry Continue work.`,
          {
            kind: 'refreshLead',
            projectId,
          },
        )
      }
    },
    auto: async (expected) => {
      checkWorktree()
      const current = autoRun(projectId, task)
      const open = { kind: 'auto' as const, target }
      if (!sameAutoRun(expected, current))
        throw new WorkBlocker('The Auto run changed. Review its current state.', open)
      try {
        if (command === 'stop') await stopAuto(projectId, task, expected)
        else if (command === 'pause') await pauseAuto(projectId, task, undefined, undefined, true)
        else {
          await resumeAuto(projectId, task)
          const next = autoRun(projectId, task)
          if (!next || !['running', 'waitingOnYou', 'done'].includes(next.status))
            throw Error(next?.reason ?? 'Auto has not resumed. Check the run and try again.')
        }
      } catch (error) {
        throw new WorkBlocker(workError(error).message, open)
      }
    },
  })
}

export function unavailableWork(command: WorkCommand, target: WorkTarget) {
  const activity = { pause: 'is running', continue: 'can continue', stop: 'can be stopped' }
  return `No Chat coordination or Auto run ${activity[command]} in ${worktreeLabel(target)}.`
}
