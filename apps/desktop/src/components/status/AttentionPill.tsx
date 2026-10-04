import type { TerminalStatus } from '../../lib/display'

/** A component's most urgent terminal status, when one wants the user. */
export default function AttentionPill({ status }: { status: TerminalStatus | null }) {
  if (!status) return null
  return (
    <span className={`attention-pill health-${status.health}`} title={status.detail}>
      {status.label}
    </span>
  )
}
