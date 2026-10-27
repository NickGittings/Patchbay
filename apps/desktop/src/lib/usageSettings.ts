import { DEFAULT_USAGE, type UsageSettings } from '../types'

export function restoredUsage(value: unknown): UsageSettings {
  const settings = { ...DEFAULT_USAGE }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings
  const fields = value as Record<string, unknown>
  for (const key of ['warnPercent', 'pausePercent'] as const) {
    const percent = fields[key]
    if (typeof percent === 'number' && Number.isFinite(percent) && percent > 0 && percent <= 100)
      settings[key] = percent
  }
  if (typeof fields.gateAuto === 'boolean') settings.gateAuto = fields.gateAuto
  return settings
}

export function mergeRestoredUsage(
  saved: unknown,
  current: UsageSettings,
  initial: UsageSettings,
): UsageSettings {
  const settings = restoredUsage(saved)
  for (const key of ['warnPercent', 'pausePercent'] as const)
    if (current[key] !== initial[key]) settings[key] = current[key]
  if (current.gateAuto !== initial.gateAuto) settings.gateAuto = current.gateAuto
  return settings
}

/** A typed threshold, or null for anything but a percentage from 1 to 100. */
export function parseThreshold(text: string): number | null {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return null
  const value = Number(text)
  return value >= 1 && value <= 100 ? value : null
}
