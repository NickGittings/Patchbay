import {
  MERGE_SCOPE,
  type DeviceManifest,
  type MergeRequest,
  type Project,
  type SessionRecord,
  type SessionState,
  type Worktree,
} from '../types'
import { mergeAgentStart } from './ipc'
import { listenForTerminals, reconcileFreshSessions } from './sessions'
import { sessionLive, sessionTimeMs } from './sessionList'

export function mergeDestinations(source: Worktree, worktrees: Worktree[]) {
  return worktrees.filter((w) => w.branch && w.path !== source.path && w.branch !== source.branch)
}

/** Only the project's open worktree is an automatic default. */
export function defaultMergeDestination(source: Worktree, worktrees: Worktree[]) {
  return mergeDestinations(source, worktrees).find((w) => w.current)?.path ?? ''
}

/** Live events take precedence over an older session-list snapshot after Stop. */
export function mergeDestinationRunning(
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  destination: string,
) {
  return records.some(
    (r) =>
      r.metadata.componentId === MERGE_SCOPE &&
      r.spec.cwd === destination &&
      (sessions[r.id]?.running ?? sessionLive(r)),
  )
}

/** Recover merge terminals from the session service, even after Review unmounts. */
export function mergeRecords(records: SessionRecord[], projectId: string | undefined) {
  return records
    .filter((r) => r.metadata.projectId === projectId && r.metadata.componentId === MERGE_SCOPE)
    .sort((a, b) => (sessionTimeMs(b) ?? 0) - (sessionTimeMs(a) ?? 0))
}

export function currentMergeRecord(
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  selected: string | undefined,
) {
  return (
    records.find((r) => r.id === selected) ??
    records.find((r) => sessions[r.id]?.running ?? sessionLive(r))
  )
}

export async function startMergeAgent(
  project: Project,
  request: MergeRequest,
  device: DeviceManifest,
  requestId: string,
) {
  await listenForTerminals()
  const sid = await mergeAgentStart(
    project,
    request,
    {
      id: device.id,
      name: device.name,
      command: device.command,
      adapter: device.adapter,
      kind: 'agent',
    },
    requestId,
  )
  await reconcileFreshSessions()
  return sid
}
