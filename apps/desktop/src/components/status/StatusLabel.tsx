import { openUrl } from '@tauri-apps/plugin-opener'
import type { TerminalStatus } from '../../lib/display'
import { useStore } from '../../store'

/** A terminal's status in words, with the service's URL when it printed one. */
export default function StatusLabel({ status }: { status: TerminalStatus }) {
  return (
    <span className={`status-label health-${status.health}`} title={status.detail}>
      {status.label}
      {status.url && (
        <button
          className="status-url"
          title={`Open ${status.url}`}
          onClick={(e) => {
            e.stopPropagation()
            openUrl(status.url!).catch((err) => useStore.getState().setMessage(String(err)))
          }}
        >
          {status.url.replace(/^https?:\/\//, '')}
        </button>
      )}
    </span>
  )
}
