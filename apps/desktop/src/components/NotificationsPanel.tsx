import Dialog from './Dialog'
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
    <Dialog title="Notifications" subtitle="Agent alerts across all projects" onClose={onClose}>
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
        <legend title="Turn ends require Agent status integration. Auto notifies when waiting on you or failing. Background alerts use a toast while Patchbay is focused, otherwise native notifications.">
          Notify when an agent
        </legend>
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
      <span className="worktree-tag" role="status" title="Native notification permission">
        {permission}
      </span>
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
    </Dialog>
  )
}
