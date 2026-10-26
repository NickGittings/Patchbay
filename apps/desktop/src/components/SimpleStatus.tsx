import type { SessionState } from '../types'
import { useClockTick } from '../lib/clock'
import { foldedStatus, terminalStatus } from '../lib/display'
import StatusLabel from './status/StatusLabel'

/** Keep tooltip ages current without re-rendering the chat or its terminal cards. */
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
