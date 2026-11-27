import { terminalStop, worktreeReservations } from './ipc'
import { useStore } from '../store'

/**
 * A person's launch or resume beside a running merge agent, which still refuses automated work
 * there: say so, and offer to stop the agent. The service decides the overlap on canonical paths.
 * Only a courtesy, so a failed lookup says nothing.
 */
export async function warnReservedFolder(projectId: string, sid: string, folder: string) {
  let holders: { id: string; name: string }[] | undefined
  try {
    holders = await worktreeReservations(folder)
  } catch {
    return
  }
  const holder = holders?.find((r) => r.id !== sid)
  if (!holder) return
  useStore.getState().setMessage(
    `“${holder.name}” is still running in this worktree. It may change files while you work here.`,
    false,
    {
      label: 'Stop merge agent',
      run: () =>
        void terminalStop(holder.id).catch((e) =>
          useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
        ),
      projectId,
    },
    'warning',
    'Merge agent still running',
  )
}

/** `warnReservedFolder` for a session the person just resumed, in its recorded folder. */
export async function warnAfterResume(sid: string) {
  const record = useStore.getState().sessionRecords.find((r) => r.id === sid)
  if (record?.spec?.cwd) await warnReservedFolder(record.metadata.projectId, sid, record.spec.cwd)
}
