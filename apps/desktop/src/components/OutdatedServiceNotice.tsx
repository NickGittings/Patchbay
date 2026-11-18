import { confirmAction } from '../lib/confirm'
import { retireOlderService } from '../lib/sessions'
import { useStore } from '../store'

/** An older Patchbay version's service still runs work; offer to end it so this one can start. */
export default function OutdatedServiceNotice() {
  const retirement = useStore((s) => s.serviceRetirement)
  const error = useStore((s) => s.serviceRetirementError)
  const stop = async () => {
    if (useStore.getState().serviceRetirement !== 'idle') return
    if (
      !(await confirmAction({
        title: 'Stop older sessions',
        message:
          'Stop the sessions still running from an older Patchbay version? Their running work ends.',
        detail: 'Their history is kept.',
        confirmLabel: 'Stop sessions',
      })) ||
      useStore.getState().serviceRetirement !== 'idle'
    )
      return
    void retireOlderService()
  }
  return (
    <>
      <span>
        Sessions from an older Patchbay version are still running, so this version can't start its
        session service yet. They were left running.
        {error && ` Stopping them failed: ${error}`}
      </span>
      <button disabled={retirement !== 'idle'} onClick={() => void stop()}>
        {retirement === 'stopping'
          ? 'Stopping…'
          : retirement === 'reconnecting'
            ? 'Reconnecting…'
            : 'Stop older sessions'}
      </button>
    </>
  )
}
