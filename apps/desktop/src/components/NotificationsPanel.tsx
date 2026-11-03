import SettingsDialog, { SettingsFeedback, SettingsSection } from './SettingsDialog'
import { useEffect, useState } from 'react'
import { isPermissionGranted } from '@tauri-apps/plugin-notification'
import { sendTestNotification } from '../lib/notifications'
import { useStore } from '../store'

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.notifications)
  const setNotifications = useStore((s) => s.setNotifications)
  const [permission, setPermission] = useState('Checking…')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
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
    <SettingsDialog
      title="Notifications"
      subtitle="Agent alerts across all projects"
      behavior="Changes apply immediately."
      onClose={onClose}
    >
      <p>
        <label className="notifications-toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => setNotifications({ ...settings, enabled: e.target.checked })}
          />{' '}
          Enable notifications
        </label>
      </p>
      <fieldset disabled={!settings.enabled} className="settings-section">
        <legend>Notify about</legend>
        <p className="hint">
          Finished-turn alerts require Agent status integration. Background alerts appear as a toast
          while Patchbay is focused, otherwise as a native notification.
        </p>
        {(
          [
            ['finished', 'Finished turns'],
            ['needsInput', 'Input requests'],
            ['failed', 'Agent failures'],
            ['usageLimits', 'Subscription usage limits'],
          ] as const
        ).map(([key, label]) => (
          <p key={key}>
            <label className="notifications-toggle">
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
      <SettingsSection title="Notification delivery">
        <div className="settings-actions">
          <span className="settings-feedback" role="status" title="Native notification permission">
            Native permission: {permission}
          </span>
          <button
            disabled={testing}
            onClick={async () => {
              setTesting(true)
              setError('')
              try {
                const result = await sendTestNotification()
                setPermission(
                  result.status === 'granted'
                    ? 'Granted'
                    : result.status === 'denied'
                      ? 'Not granted'
                      : result.granted
                        ? 'Granted'
                        : 'Unavailable',
                )
                if (result.status === 'failed') setError(result.error)
              } catch (e) {
                setPermission('Unavailable')
                setError(String(e))
              } finally {
                setTesting(false)
              }
            }}
          >
            {testing ? 'Sending…' : 'Send test notification'}
          </button>
        </div>
        {error && <SettingsFeedback error>{error}</SettingsFeedback>}
      </SettingsSection>
    </SettingsDialog>
  )
}
