import { projectOf, projectStateOf, useStore } from '../store'
import { MERGE_SCOPE } from '../types'
import { autoWorkspace } from './autoState'
import { integrated } from './autoSettings'
import { gitWorktrees, mergeOutcome } from './ipc'
import { refreshStories } from './stories'

/** Poll the small board store; read Git only after its inputs or live Git status change. */
export function storyProgressPoll(projectId: string) {
  let disposed = false
  let pending = false
  let revision = 0
  let checked = ''
  const unsubscribe = useStore.subscribe((s, prev) => {
    const state = projectStateOf(projectId, s)
    const before = projectStateOf(projectId, prev)
    if (state?.gitChanges !== before?.gitChanges || state?.repos !== before?.repos) revision++
  })
  return {
    dispose() {
      disposed = true
      unsubscribe()
    },
    async poll() {
      if (disposed || pending) return
      pending = true
      try {
        await refreshStories(projectId)
        if (disposed) return
        const state = projectStateOf(projectId)
        const project = projectOf(projectId)
        if (!state || !project) return
        const linked = state.tasks
          .filter((t) => !t.missing)
          .flatMap((task) => {
            const stories = state.stories.filter((s) => s.task === task.id && s.status !== 'done')
            if (!stories.length) return []
            const run = autoWorkspace(state, task.id)?.auto
            const record = [...useStore.getState().sessionRecords]
              .reverse()
              .find(
                (r) =>
                  r.metadata.projectId === projectId &&
                  r.metadata.componentId === MERGE_SCOPE &&
                  r.spec.merge_source === task.worktree,
              )
            return [{ task, stories, run, record }]
          })
        const key = JSON.stringify([
          revision,
          linked.map(({ task, stories, run, record }) => [
            task.id,
            task.worktree,
            task.branch,
            stories.map((s) => [s.id, s.taskHead]),
            run && [run.runId, run.stage, run.status, run.merge.destinationBranch],
            record && [
              record.id,
              record.spec.cwd,
              record.snapshot?.generation,
              record.snapshot?.running,
              useStore.getState().sessions[record.id]?.status?.agent?.sinceMs,
              useStore.getState().sessions[record.id]?.status?.agent?.state,
            ],
          ]),
        ])
        if (key === checked || !linked.length) return
        const worktrees = await gitWorktrees(projectId)
        if (disposed) return
        await Promise.all(
          linked.map(async ({ task, run, record }) => {
            const destination = worktrees.find((w) =>
              record
                ? w.path === record.spec.cwd
                : run &&
                  ['mergeGate', 'merge', 'done'].includes(run.stage) &&
                  w.branch === run.merge.destinationBranch,
            )
            if (!task.branch || !destination?.branch || destination.path === task.worktree) return
            const outcome = await mergeOutcome(project, {
              source: task.worktree,
              sourceBranch: task.branch,
              destination: destination.path,
              destinationBranch: destination.branch,
            })
            if (integrated(outcome) && !disposed) await refreshStories(projectId)
          }),
        )
        if (!disposed) checked = key
      } catch {
        // Retry failed reads; missing branches and unreadable Git are not completion evidence.
      } finally {
        pending = false
      }
    },
  }
}
