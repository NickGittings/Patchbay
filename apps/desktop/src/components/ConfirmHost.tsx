import { useSyncExternalStore } from 'react'
import Dialog from './Dialog'
import { pendingConfirm, settleConfirm, subscribeConfirm } from '../lib/confirm'

/** Renders the window's pending `confirmAction` request: Cancel first and focused, the verb last. */
export default function ConfirmHost() {
  const request = useSyncExternalStore(subscribeConfirm, pendingConfirm)
  if (!request) return null
  const cancel = () => settleConfirm(request.id, false)
  return (
    <Dialog
      key={request.id}
      title={request.title}
      role="alertdialog"
      returnFocus={request.returnFocus}
      className="centered confirm-dialog"
      onClose={cancel}
      footer={
        <>
          <button autoFocus onClick={cancel}>
            Cancel
          </button>
          <button
            className={request.destructive === false ? 'primary' : 'danger'}
            onClick={() => settleConfirm(request.id, true)}
          >
            {request.confirmLabel}
          </button>
        </>
      }
    >
      <p>{request.message}</p>
      {request.detail && <p className="confirm-detail">{request.detail}</p>}
    </Dialog>
  )
}
