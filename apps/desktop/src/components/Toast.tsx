import { useEffect, useState } from 'react'
import { useStore } from '../store'

const HIDE_AFTER_MS = 6000

/**
 * The latest app message, shown in full below the toolbar. Errors and hints stay until dismissed
 * or replaced; transient confirmations hide on their own unless hovered. The live region stays
 * mounted so screen readers announce each new message.
 */
export default function Toast() {
  const message = useStore((s) => s.message)
  const id = useStore((s) => s.messageId)
  const transient = useStore((s) => s.messageTransient)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (!transient || hovered) return
    const timer = setTimeout(() => useStore.getState().setMessage(''), HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [id, transient, hovered])

  return (
    <div className="toast-region" aria-live="polite">
      {message && (
        <div
          className="toast"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <span className="toast-text">{message}</span>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => {
              setHovered(false)
              useStore.getState().setMessage('')
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
