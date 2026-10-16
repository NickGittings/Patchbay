import { useEffect, useState } from 'react'
import { isPermissionGranted } from '@tauri-apps/plugin-notification'
import { sendTestNotification } from '../lib/notifications'
import { useStore } from '../store'

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.notifications)
  const setNotifications = useStore((s) => s.setNotifications)
  const [permission, setPermission] = useState('Checking…')
  const [testing, setTesting] = useState(false)
  useEffect(() => {
    let disposed = false
    void isPermissionGranted().then(
      (granted) => {
        if (!disposed) setPermission(granted ? 'Granted' : 'Not granted')
      },
      () => {
        if (!disposed) setPermission('Unavailable')
      },
    )
    return () => {
      disposed = true
    }
  }, [])
  return (
    <div className="extension-overlay" onClick={onClose}>
      <div
        className="extensions-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="row">
          <h2>Notifications</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p>Agent alerts from every project and worktree. These settings apply to all projects.</p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setNotifications({ ...settings, enabled: e.target.checked })}
            />{' '}
            Enable notifications
          </label>
        </p>
        <fieldset disabled={!settings.enabled}>
          <legend>Notify when an agent</legend>
          {(
            [
              ['finished', 'Finished a turn'],
              ['needsInput', 'Needs input'],
              ['failed', 'Failed'],
            ] as const
          ).map(([key, label]) => (
            <p key={key}>
              <label>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) => setNotifications({ ...settings, [key]: e.target.checked })}
                />{' '}
                {label}
              </label>
            </p>
          ))}
        </fieldset>
        <p className="hint">
          Turn ends rely on Agent status integration. Agents without status hooks only notify when
          they fail. While Auto mode drives a worktree, its agents' turn ends don't notify; Auto
          notifies when it waits on you (under Needs input) or fails.
        </p>
        <p className="hint">
          When Patchbay is focused, background sessions show a toast. Otherwise, alerts use native
          notifications. Alerts also wait here until you return, with links to their sessions.
        </p>
        <p>Native notification permission: {permission}</p>
        <button
          disabled={testing}
          onClick={async () => {
            setTesting(true)
            try {
              const result = await sendTestNotification()
              setPermission(
                result.status === 'granted'
                  ? 'Granted'
                  : result.status === 'denied'
                    ? 'Not granted'
                    : result.granted
                      ? `Granted, but sending failed: ${result.error}`
                      : `Unavailable: ${result.error}`,
              )
            } catch (e) {
              setPermission('Unavailable')
              useStore.getState().setMessage(String(e))
            } finally {
              setTesting(false)
            }
          }}
        >
          Send test notification
        </button>
      </div>
    </div>
  )
}
