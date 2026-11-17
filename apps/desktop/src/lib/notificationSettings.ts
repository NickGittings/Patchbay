import {
  DEFAULT_NOTIFICATIONS,
  TOAST_POSITIONS,
  type NotificationSettings,
  type ToastPosition,
} from '../types'

const KEYS = Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationSettings)[]

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** One check per field; a new setting must add its own before this compiles. */
const VALID: {
  [K in keyof NotificationSettings]: (value: unknown) => value is NotificationSettings[K]
} = {
  enabled: isBoolean,
  finished: isBoolean,
  needsInput: isBoolean,
  failed: isBoolean,
  usageLimits: isBoolean,
  toastPosition: (value): value is ToastPosition =>
    TOAST_POSITIONS.some((position) => position === value),
}

function restoreField<K extends keyof NotificationSettings>(
  settings: NotificationSettings,
  saved: Record<string, unknown>,
  key: K,
) {
  const field = saved[key]
  if (VALID[key](field)) settings[key] = field
}

function copyField<K extends keyof NotificationSettings>(
  to: NotificationSettings,
  from: NotificationSettings,
  key: K,
) {
  to[key] = from[key]
}

/** Saved settings with every valid field kept and anything else defaulted. */
export function restoredNotifications(value: unknown): NotificationSettings {
  const settings = { ...DEFAULT_NOTIFICATIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings
  for (const key of KEYS) restoreField(settings, value as Record<string, unknown>, key)
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
  for (const key of KEYS) if (current[key] !== initial[key]) copyField(settings, current, key)
  return settings
}
