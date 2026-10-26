import type { TerminalStatus } from '../lib/display'
import StatusLabel from './status/StatusLabel'

/** Use the same computed status for the label, disclosures and input visibility. */
export default function SimpleStatus({
  status,
  folded = false,
}: {
  status: TerminalStatus | undefined
  folded?: boolean
}) {
  return status ? <StatusLabel status={status} alwaysShow={folded} /> : null
}
