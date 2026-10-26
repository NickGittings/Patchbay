import { openUrl } from '@tauri-apps/plugin-opener'
import { statusTitle, type TerminalStatus } from '../../lib/display'
import { useStore } from '../../store'

/**
 * A terminal's status in words when it wants the user, with the service's URL when it printed
 * one; otherwise just the URL, or nothing.
 */
export default function StatusLabel({
  status,
  alwaysShow = false,
}: {
  status: TerminalStatus
  /** Group summaries also name quiet work in progress. */
  alwaysShow?: boolean
}) {
  const loud = alwaysShow || status.attention > 0 || status.health === 'fail'
  if (!loud && !status.url) return null
  return (
    <span
      className={`status-label health-${status.health}`}
      title={alwaysShow ? statusTitle(status) : status.detail}
    >
      {loud && status.label}
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
