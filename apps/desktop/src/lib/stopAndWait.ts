import { terminalSnapshot, terminalStop } from './ipc'

/** Stop a set of sessions, then wait for process exit without transferring terminal output.
 * A caller can cancel a handoff when its captured scope changes; guards may also throw.
 */
export async function stopAndWait(
  sessions: string | Iterable<string>,
  timeoutMessage: string,
  current: () => boolean = () => true,
): Promise<boolean> {
  const ids = typeof sessions === 'string' ? [sessions] : [...sessions]
  if (!current()) return false
  await Promise.all(ids.map((sid) => terminalStop(sid)))
  const deadline = Date.now() + 10000
  for (;;) {
    if (!current()) return false
    const snapshots = await Promise.all(ids.map((sid) => terminalSnapshot(sid, 0)))
    if (!current()) return false
    if (!snapshots.some((snapshot) => snapshot?.running)) return true
    if (Date.now() >= deadline) throw new Error(timeoutMessage)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
