import { projectStateOf } from '../store'
import { worktreeSetup } from './ipc'

/** Wait for an explicit outcome. Never starts or retries on task switch or reconnect. */
export async function waitForSetup(
  projectId: string,
  task: string | null | undefined,
  isCancelled: () => boolean = () => false,
) {
  if (!task || !projectStateOf(projectId)?.tasks.find((t) => t.id === task)?.setup) return
  while (!isCancelled()) {
    const setup = await worktreeSetup(projectId, task)
    if (isCancelled() || !setup || setup.status === 'ready' || setup.status === 'skipped') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
