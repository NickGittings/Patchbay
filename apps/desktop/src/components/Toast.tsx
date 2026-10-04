import { useEffect, useRef } from 'react'
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
  const toast = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!transient) return
    // Checked when due rather than tracked, so a toast that appears under the pointer counts.
    let timer: ReturnType<typeof setTimeout>
    const hide = () => {
      if (toast.current?.matches(':hover')) timer = setTimeout(hide, 1000)
      else useStore.getState().setMessage('')
    }
    timer = setTimeout(hide, HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [id, transient])

  return (
    <div className="toast-region" aria-live="polite">
      {message && (
        <div className="toast" ref={toast}>
          <span className="toast-text">{message}</span>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => useStore.getState().setMessage('')}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
