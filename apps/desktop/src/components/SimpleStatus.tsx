import type { SessionState } from '../types'
import { foldedStatus, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import StatusLabel from './status/StatusLabel'

/** Agent health in a chat header; only this leaf subscribes to the clock. */
export default function SimpleStatus({
  sessions,
  folded = false,
}: {
  sessions: (SessionState | undefined)[]
  folded?: boolean
}) {
  useClockTick()
  const statuses = sessions.map((session) => terminalStatus('agent', session))
  const status = folded ? foldedStatus(statuses) : statuses[0]
  return status ? <StatusLabel status={status} alwaysShow /> : null
}
