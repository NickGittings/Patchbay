import { confirmAction } from '../lib/confirm'
import { retireOlderService } from '../lib/sessions'
import { useStore } from '../store'

/**
 * A previous Patchbay's session service still runs work: an older protocol keeps this version
 * from starting its own, while a previous build after an update still serves with the old code.
 * Offer to end it so this version's service takes over.
 */
export default function OutdatedServiceNotice({ updated = false }: { updated?: boolean }) {
  const retirement = useStore((s) => s.serviceRetirement)
  const error = useStore((s) => s.serviceRetirementError)
  const stop = async () => {
    if (useStore.getState().serviceRetirement !== 'idle') return
    if (
      !(await confirmAction(
        updated
          ? {
              title: 'Restart sessions',
              message:
                'Restart the session service on the updated version? Running terminals and agents stop.',
              detail: 'Their history is kept, and agents can resume their conversations.',
              confirmLabel: 'Restart sessions',
            }
          : {
              title: 'Stop older sessions',
              message:
                'Stop the sessions still running from an older Patchbay version? Their running work ends.',
              detail: 'Their history is kept.',
              confirmLabel: 'Stop sessions',
            },
      )) ||
      useStore.getState().serviceRetirement !== 'idle'
    )
      return
    void retireOlderService()
  }
  return (
    <>
      <span>
        {updated
          ? 'Patchbay was updated, but running sessions still use the previous version’s session service. Restart it to finish updating.'
          : "Sessions from an older Patchbay version are still running, so this version can't start its session service yet. They were left running."}
        {error && ` Stopping them failed: ${error}`}
      </span>
      <button disabled={retirement !== 'idle'} onClick={() => void stop()}>
        {retirement === 'stopping'
          ? 'Stopping…'
          : retirement === 'reconnecting'
            ? 'Reconnecting…'
            : updated
              ? 'Restart sessions'
              : 'Stop older sessions'}
      </button>
    </>
  )
}
