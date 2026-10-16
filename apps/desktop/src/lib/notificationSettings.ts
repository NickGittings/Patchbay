import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '../types'

const KEYS = Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationSettings)[]

/** Saved settings with every boolean field kept and anything else defaulted. */
export function restoredNotifications(value: unknown): NotificationSettings {
  const settings = { ...DEFAULT_NOTIFICATIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings
  for (const key of KEYS) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field === 'boolean') settings[key] = field
  }
  return settings
}

export const sameNotifications = (a: NotificationSettings, b: NotificationSettings) =>
  KEYS.every((key) => a[key] === b[key])

/**
 * Restored settings, keeping each field the user changed while the workspace was restoring
 * (`current` differs from the `initial` value the store started with).
 */
export function mergeRestoredNotifications(
  saved: unknown,
  current: NotificationSettings,
  initial: NotificationSettings,
): NotificationSettings {
  const settings = restoredNotifications(saved)
  for (const key of KEYS) if (current[key] !== initial[key]) settings[key] = current[key]
  return settings
}
