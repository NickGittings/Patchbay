import type { SessionState } from '../types'
import { foldedStatus, terminalStatus } from '../lib/display'
import { useClockTick } from '../lib/clock'
import StatusLabel from './status/StatusLabel'

/**
 * An agent's status, or a folded stage's summary of its agents. Only this leaf ticks the clock:
 * the chat shares the same health for filtering and disclosures, which no age changes, and the
 * label recomputes the relative times here.
 */
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
  return status ? <StatusLabel status={status} alwaysShow={folded} /> : null
}
