import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useStore } from '../store'

const report = (error: unknown) => useStore.getState().setMessage(String(error))

/** Mounted only in the Windows/Linux main-window toolbar. */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const current = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    const refresh = () => {
      void current
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value)
        })
        .catch(report)
    }
    void current
      .onResized(refresh)
      .then((stop) => {
        if (disposed) stop()
        else {
          unlisten = stop
          refresh()
        }
      })
      .catch(report)
    // Refresh on focus too, including restores from the taskbar/window manager.
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const toggle = maximized ? 'Restore' : 'Maximize'
  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void getCurrentWindow().minimize().catch(report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6h10" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={toggle}
        title={toggle}
        onClick={() => void getCurrentWindow().toggleMaximize().catch(report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {maximized ? (
            <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" />
          ) : (
            <rect x="1.5" y="1.5" width="9" height="9" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="window-close"
        aria-label="Close"
        title="Close"
        onClick={() => void getCurrentWindow().close().catch(report)}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m1.5 1.5 9 9m0-9-9 9" />
        </svg>
      </button>
    </div>
  )
}
