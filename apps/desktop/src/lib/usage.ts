import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useStore } from '../store'
import type { SessionState, Usage, UsageSettings, UsageWindow } from '../types'
import { usageRead } from './ipc'
import { sendUsageNotification } from './notifications'
export { restoredUsage, mergeRestoredUsage, parseThreshold } from './usageSettings'

export type UsageLevel = 'ok' | 'warn' | 'limit'
export const USAGE_PROVIDERS = ['claude', 'codex'] as const
export const USAGE_WINDOWS = ['fiveHour', 'weekly'] as const
export const providerName = (provider: 'claude' | 'codex') =>
  provider === 'claude' ? 'Claude' : 'Codex'
export const windowName = (window: 'fiveHour' | 'weekly') =>
  window === 'fiveHour' ? '5-hour' : 'weekly'

export function usageLevel(window: UsageWindow, settings: UsageSettings): UsageLevel {
  if (window.usedPercent >= settings.pausePercent) return 'limit'
  return window.usedPercent >= settings.warnPercent ? 'warn' : 'ok'
}

/** Active windows at a warning or limit threshold, shared by badges, alerts and Auto. */
export function usageWarnings(usage: Usage | null, settings: UsageSettings, now: number) {
  return USAGE_PROVIDERS.flatMap((provider) =>
    USAGE_WINDOWS.flatMap((key) => {
      const window = usage?.[provider]?.[key]
      if (!window || window.resetsAtMs <= now) return []
      const level = usageLevel(window, settings)
      return level === 'ok' ? [] : [{ provider, key, window, level }]
    }),
  )
}

/** A reset later than today names its day, and a week or more away its date. */
export function resetLabel(resetsAtMs: number, now: number): string {
  const reset = new Date(resetsAtMs)
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  if (reset.toDateString() === new Date(now).toDateString())
    return reset.toLocaleTimeString([], time)
  const far = resetsAtMs - now >= 6 * 86_400_000
  return reset.toLocaleString([], {
    weekday: 'short',
    ...(far ? { month: 'short', day: 'numeric' } : {}),
    ...time,
  })
}

function limitMessage(
  provider: 'claude' | 'codex',
  key: 'fiveHour' | 'weekly',
  w: UsageWindow,
  now: number,
) {
  return `${providerName(provider)} ${windowName(key)} limit is ${Math.round(w.usedPercent)}% used; resets ${resetLabel(w.resetsAtMs, now)}`
}

export function usageBlock(
  usage: Usage | null,
  provider: 'claude' | 'codex' | null,
  settings: UsageSettings,
  now: number,
): string | null {
  if (!settings.gateAuto || !provider) return null
  for (const warning of usageWarnings(usage, settings, now))
    if (warning.provider === provider && warning.level === 'limit')
      return limitMessage(provider, warning.key, warning.window, now)
  return null
}

/** Time until a reset: minutes, then hours, then days. */
export function resetsIn(resetsAtMs: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((resetsAtMs - now) / 60_000))
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) {
    const rest = minutes % 60
    return `${Math.floor(minutes / 60)} hr${rest ? ` ${rest} min` : ''}`
  }
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return `${days} ${days === 1 ? 'day' : 'days'}${hours ? ` ${hours} hr` : ''}`
}

/** Snapshot age is explicit because Claude refreshes only while an interactive session runs. */
export function usageAge(observedMs: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - observedMs) / 60_000))
  if (minutes < 1) return 'as of just now'
  if (minutes < 60) return `as of ${minutes} min ago`
  if (minutes < 1440) return `as of ${Math.floor(minutes / 60)} hr ago`
  const days = Math.floor(minutes / 1440)
  return `as of ${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** Resets a provider reports relative to each event drift between reports; within this they
 * are the same window. */
const RESET_TOLERANCE_MS = 120_000

/** The seen id of this window and level, reusing one recorded for a slightly different reset. */
function alertId(seen: Set<string>, prefix: string, resetsAtMs: number, level: UsageLevel) {
  for (const id of seen) {
    const [provider, key, reset, seenLevel] = id.split(':')
    if (
      `${provider}:${key}:` === prefix &&
      seenLevel === level &&
      Math.abs(Number(reset) - resetsAtMs) <= RESET_TOLERANCE_MS
    )
      return id
  }
  return `${prefix}${resetsAtMs}:${level}`
}

/** One alert per provider/window/reset/level, even after usage falls and rises again. */
export function usageAlerts(
  usage: Usage | null,
  settings: UsageSettings,
  now: number,
  seen: Set<string>,
): string[] {
  const alerts: string[] = []
  for (const { provider, key, window: w, level } of usageWarnings(usage, settings, now)) {
    const prefix = `${provider}:${key}:`
    const id = alertId(seen, prefix, w.resetsAtMs, level)
    if (!seen.has(id)) alerts.push(limitMessage(provider, key, w, now))
    seen.add(id)
    // Jumping straight to the pause threshold also passes the warning threshold.
    if (level === 'limit' && w.usedPercent >= settings.warnPercent)
      seen.add(alertId(seen, prefix, w.resetsAtMs, 'warn'))
  }
  // A temporarily absent window must not re-alert when the same reset reappears.
  for (const id of seen) if (Number(id.split(':')[2]) <= now) seen.delete(id)
  return alerts
}

/** A run exited or an agent finished its turn: the moments usage may have moved. */
export function usageMoved(prev: SessionState | undefined, next: SessionState): boolean {
  if (!prev || prev === next) return false
  if (prev.running && !next.running) return true
  const agent = next.status?.agent
  if (!next.running || agent?.state !== 'review') return false
  const before = prev.status?.agent
  return before?.state !== 'review' || before.sinceMs !== agent.sinceMs
}

type UsageState = {
  usage: Usage | null
  error: string | null
}

export const useUsage = create(
  subscribeWithSelector<UsageState>(() => ({
    usage: null,
    error: null,
  })),
)
let reading: Promise<Usage | null> | undefined
/** Share pending reads, unless a mutation needs a fresh snapshot. Superseded reads cannot
 * overwrite the newer result or clear its pending promise. */
export function refreshUsage({ fresh = false } = {}): Promise<Usage | null> {
  if (reading && !fresh) return reading
  const pending = Promise.resolve()
    .then(usageRead)
    .then((usage) => {
      if (reading === pending) useUsage.setState({ usage, error: null })
      return usage
    })
    .catch((error) => {
      if (reading === pending) useUsage.setState({ error: String(error) })
      return useUsage.getState().usage
    })
    .finally(() => {
      if (reading === pending) reading = undefined
    })
  reading = pending
  return pending
}

/** Main-window observer; subscriptions and timers are disposed with App. */
export function followUsage() {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const seen = new Set<string>()
  const warn = () => {
    const s = useStore.getState()
    if (disposed || s.restoring) return
    // Consume thresholds even while delivery is disabled, so re-enabling doesn't replay them.
    const messages = usageAlerts(useUsage.getState().usage, s.usageSettings, Date.now(), seen)
    if (!s.notifications.enabled || !s.notifications.usageLimits || !messages.length) return
    const body = messages.join('\n')
    // Keep a toast even when native delivery succeeds, so it is available on return.
    s.setNotificationToast({ message: body, sessions: [] })
    if (!document.hasFocus())
      void sendUsageNotification(body, () => {
        const s = useStore.getState()
        return (
          !disposed &&
          !document.hasFocus() &&
          s.notifications.enabled &&
          s.notifications.usageLimits
        )
      })
  }
  const refresh = () => void refreshUsage()
  const stopUsage = useUsage.subscribe((s) => s.usage, warn)
  const stopStore = useStore.subscribe((s, prev) => {
    if (
      s.usageSettings !== prev.usageSettings ||
      s.notifications !== prev.notifications ||
      s.restoring !== prev.restoring
    )
      warn()
    // Compares only the run and turn fields, so a replaced map of unchanged sessions stays cheap.
    if (
      s.sessions !== prev.sessions &&
      Object.entries(s.sessions).some(([id, next]) => usageMoved(prev.sessions[id], next))
    ) {
      clearTimeout(timer)
      // Claude debounces its own capture; let the last response reach disk first.
      timer = setTimeout(refresh, 700)
    }
  })
  const interval = setInterval(refresh, 60_000)
  window.addEventListener('focus', refresh)
  refresh()
  return () => {
    disposed = true
    stopUsage()
    stopStore()
    clearTimeout(timer)
    clearInterval(interval)
    window.removeEventListener('focus', refresh)
  }
}
