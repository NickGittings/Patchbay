import { useEffect } from 'react'
import { useStore } from '../store'

const HIDE_AFTER_MS = 8000

/** Hints that ask the user to act stay until dismissed or replaced. */
const sticky = (message: string) => /^(Detected|Locked)\b/.test(message)

/** The latest app message, shown in full below the toolbar. */
export default function Toast() {
  const message = useStore((s) => s.message)

  useEffect(() => {
    if (!message || sticky(message)) return
    const timer = setTimeout(() => {
      if (useStore.getState().message === message) useStore.getState().setMessage('')
    }, HIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [message])

  if (!message) return null
  return (
    <div className="toast" role="status">
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
