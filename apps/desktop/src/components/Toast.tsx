import { useEffect } from 'react'
import { useStore } from '../store'

const HIDE_AFTER_MS = 6000

/**
 * The latest app message, shown in full below the toolbar. Errors and hints stay until dismissed
 * or replaced; transient confirmations hide on their own.
 */
export default function Toast() {
  const message = useStore((s) => s.message)
  const id = useStore((s) => s.messageId)
  const transient = useStore((s) => s.messageTransient)

  useEffect(() => {
    if (!transient) return
    const timer = setTimeout(() => useStore.getState().setMessage(''), HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [id, transient])

  if (!message) return null
  return (
    <div className="toast" role={transient ? 'status' : 'alert'}>
      <span className="toast-text">{message}</span>
      <button
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => useStore.getState().setMessage('')}
      >
        ×
      </button>
    </div>
  )
}
