import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import {
  DEFAULT_USAGE,
  DEFAULT_NOTIFICATIONS,
  type SessionState,
  type Usage,
  type UsageWindow,
} from '../types'
import {
  usageAlerts,
  usageBlock,
  usageLevel,
  usageWarnings,
  usageAge,
  usageMoved,
  resetLabel,
  resetsIn,
  parseThreshold,
  restoredUsage,
  mergeRestoredUsage,
  followUsage,
  refreshUsage,
  useUsage,
} from './usage'
import { useStore } from '../store'
import { usageRead } from './ipc'

vi.mock('./ipc', () => ({ usageRead: vi.fn() }))
vi.mock('./notifications', () => ({ sendUsageNotification: vi.fn() }))
vi.mock('../store', async () => {
  const { create } = await import('zustand')
  const { DEFAULT_USAGE, DEFAULT_NOTIFICATIONS } = await import('../types')
  return {
    useStore: create(() => ({
      restoring: false,
      sessions: {},
      usageSettings: { ...DEFAULT_USAGE },
      notifications: { ...DEFAULT_NOTIFICATIONS },
      setNotificationToast: vi.fn(),
    })),
  }
})

const now = 1_000_000
const window = (usedPercent: number, resetsAtMs = now + 300_000): UsageWindow => ({
  usedPercent,
  resetsAtMs,
  windowMinutes: 300,
})
function usage(percent: number, reset = now + 300_000): Usage {
  return {
    claude: { provider: 'claude', fiveHour: window(percent, reset), weekly: null, observedMs: now },
    codex: null,
    claudeCapture: { installed: false, chained: null, source: '/settings.json' },
    claudeError: null,
    codexError: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useUsage.setState({ usage: null, error: null })
  useStore.setState({
    notifications: { ...DEFAULT_NOTIFICATIONS },
    usageSettings: { ...DEFAULT_USAGE },
    restoring: false,
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test.each([false, true])(
  'refresh shares a pending read and permits another read after error=%s',
  async (fail) => {
    let resolve!: (value: Usage) => void
    let reject!: (error: Error) => void
    vi.mocked(usageRead).mockReturnValueOnce(
      new Promise<Usage>((yes, no) => {
        resolve = yes
        reject = no
      }),
    )
    const first = refreshUsage()
    expect(refreshUsage()).toBe(first)
    await Promise.resolve()
    expect(usageRead).toHaveBeenCalledTimes(1)
    if (fail) reject(new Error('Read failed'))
    else resolve(usage(50))
    await first
    expect(useUsage.getState().error).toBe(fail ? 'Error: Read failed' : null)

    vi.mocked(usageRead).mockResolvedValueOnce(usage(60))
    await refreshUsage()
    expect(usageRead).toHaveBeenCalledTimes(2)
    expect(useUsage.getState()).toMatchObject({ error: null, usage: usage(60) })
  },
)

test.each([false, true])(
  'capture mutation supersedes a pending read with error=%s',
  async (fail) => {
    let finish!: (value: Usage) => void
    let reject!: (error: Error) => void
    let finishFresh!: (value: Usage) => void
    vi.mocked(usageRead)
      .mockReturnValueOnce(
        new Promise<Usage>((yes, no) => {
          finish = yes
          reject = no
        }),
      )
      .mockReturnValueOnce(new Promise<Usage>((resolve) => (finishFresh = resolve)))
    const older = refreshUsage()
    await Promise.resolve()
    const installed = usage(50)
    installed.claudeCapture = { installed: true, chained: null, source: '/settings.json' }
    useUsage.setState({ usage: installed })
    const fresh = refreshUsage({ fresh: true })
    expect(fresh).not.toBe(older)
    await Promise.resolve()
    expect(usageRead).toHaveBeenCalledTimes(2)
    if (fail) reject(new Error('Stale read failed'))
    else finish(usage(40))
    await older
    expect(useUsage.getState()).toMatchObject({ usage: installed, error: null })
    expect(refreshUsage()).toBe(fresh)
    finishFresh(installed)
    await fresh
    expect(useUsage.getState()).toMatchObject({ usage: installed, error: null })
  },
)

test('a stale result arriving after a fresh read cannot overwrite it or release a later read', async () => {
  let finishOld!: (value: Usage) => void
  let finishNext!: (value: Usage) => void
  vi.mocked(usageRead)
    .mockReturnValueOnce(new Promise<Usage>((resolve) => (finishOld = resolve)))
    .mockResolvedValueOnce(usage(60))
    .mockReturnValueOnce(new Promise<Usage>((resolve) => (finishNext = resolve)))
  const older = refreshUsage()
  await Promise.resolve()
  await refreshUsage({ fresh: true })
  const next = refreshUsage()
  finishOld(usage(40))
  await older
  expect(useUsage.getState()).toMatchObject({ usage: usage(60), error: null })
  expect(refreshUsage()).toBe(next)
  finishNext(usage(70))
  await next
  expect(useUsage.getState().usage).toEqual(usage(70))
})

test('synchronous read failures return the last snapshot and allow a retry', async () => {
  useUsage.setState({ usage: usage(50) })
  vi.mocked(usageRead).mockImplementationOnce(() => {
    throw new Error('Read failed synchronously')
  })
  await expect(refreshUsage()).resolves.toEqual(usage(50))
  expect(useUsage.getState().error).toBe('Error: Read failed synchronously')
  vi.mocked(usageRead).mockResolvedValueOnce(usage(60))
  await expect(refreshUsage()).resolves.toEqual(usage(60))
  expect(useUsage.getState().error).toBeNull()
})

test('levels include exact thresholds and allow independently adjusted percentages', () => {
  expect(usageLevel(window(79.9), DEFAULT_USAGE)).toBe('ok')
  expect(usageLevel(window(80), DEFAULT_USAGE)).toBe('warn')
  expect(usageLevel(window(95), DEFAULT_USAGE)).toBe('limit')
  expect(usageLevel(window(70), { ...DEFAULT_USAGE, pausePercent: 60 })).toBe('limit')
})

test('Auto names the provider and window, and allows missing or expired data and disabled gating', () => {
  expect(usageBlock(usage(96), 'claude', DEFAULT_USAGE, now)).toMatch(
    /^Claude 5-hour limit is 96% used; resets /,
  )
  const weekly = usage(50)
  weekly.codex = {
    provider: 'codex',
    fiveHour: null,
    weekly: { ...window(98), windowMinutes: 10080 },
    observedMs: now,
  }
  expect(usageBlock(weekly, 'codex', DEFAULT_USAGE, now)).toMatch(/^Codex weekly limit is 98% used/)
  expect(usageBlock(usage(94), 'claude', DEFAULT_USAGE, now)).toBeNull()
  expect(usageBlock(usage(99, now), 'claude', DEFAULT_USAGE, now)).toBeNull()
  expect(usageBlock(null, 'claude', DEFAULT_USAGE, now)).toBeNull()
  expect(usageBlock(usage(99), 'codex', DEFAULT_USAGE, now)).toBeNull()
  expect(usageBlock(usage(99), null, DEFAULT_USAGE, now)).toBeNull()
  expect(usageBlock(usage(99), 'claude', { ...DEFAULT_USAGE, gateAuto: false }, now)).toBeNull()
  expect(usageBlock(usage(96), 'claude', { ...DEFAULT_USAGE, pausePercent: 100 }, now)).toBeNull()
})

test('alerts dedupe each threshold until the reset changes', () => {
  const seen = new Set<string>()
  expect(usageAlerts(usage(79), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(usageAlerts(usage(80), DEFAULT_USAGE, now, seen)).toHaveLength(1)
  expect(usageAlerts(usage(90), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(usageAlerts(usage(95), DEFAULT_USAGE, now, seen)).toHaveLength(1)
  expect(usageAlerts(usage(96), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(usageAlerts(usage(81), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(usageAlerts(usage(96, now + 600_000), DEFAULT_USAGE, now, seen)).toHaveLength(1)
  expect(seen.size).toBe(4)
  expect(usageAlerts(null, DEFAULT_USAGE, now, seen)).toEqual([])
  expect(usageAlerts(usage(96), DEFAULT_USAGE, now, seen)).toEqual([])
  expect(usageAlerts(usage(99, now), DEFAULT_USAGE, now + 600_000, seen)).toEqual([])
  expect(seen.size).toBe(0)
})

test('a reset that drifts between reports is the same window for alerts', () => {
  const seen = new Set<string>()
  expect(usageAlerts(usage(96), DEFAULT_USAGE, now, seen)).toHaveLength(1)
  expect(usageAlerts(usage(97, now + 360_000), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(usageAlerts(usage(97, now + 240_000), DEFAULT_USAGE, now, seen)).toHaveLength(0)
  expect(seen.size).toBe(2)
  // A reset well apart is a new window.
  expect(usageAlerts(usage(97, now + 3_600_000), DEFAULT_USAGE, now, seen)).toHaveLength(1)
})

test('time until a reset reads in minutes, then hours, then days', () => {
  expect(resetsIn(now + 1, now)).toBe('1 min')
  expect(resetsIn(now + 59 * 60_000, now)).toBe('59 min')
  expect(resetsIn(now + 60 * 60_000, now)).toBe('1 hr')
  expect(resetsIn(now + 270 * 60_000, now)).toBe('4 hr 30 min')
  expect(resetsIn(now + 1440 * 60_000, now)).toBe('1 day')
  expect(resetsIn(now + 8640 * 60_000 - 1, now)).toBe('6 days')
  expect(resetsIn(now + (2 * 1440 + 180) * 60_000, now)).toBe('2 days 3 hr')
})

test('first snapshot at the limit gives one alert and weekly/provider identities remain independent', () => {
  const seen = new Set<string>()
  const data = usage(96)
  data.codex = {
    provider: 'codex',
    fiveHour: window(96),
    weekly: { ...window(85), windowMinutes: 10080 },
    observedMs: now,
  }
  expect(usageAlerts(data, DEFAULT_USAGE, now, seen)).toHaveLength(3)
  expect(usageAlerts(data, DEFAULT_USAGE, now, seen)).toHaveLength(0)
})

test('restore validates thresholds and merge preserves edits made during workspace restore', () => {
  for (const value of [null, undefined, [], 1, 'bad'])
    expect(restoredUsage(value)).toEqual(DEFAULT_USAGE)
  expect(restoredUsage({ warnPercent: NaN, pausePercent: 101, gateAuto: 'yes' })).toEqual(
    DEFAULT_USAGE,
  )
  expect(restoredUsage({ warnPercent: 0, pausePercent: -1 })).toEqual(DEFAULT_USAGE)
  expect(restoredUsage({ warnPercent: 25, pausePercent: 100, gateAuto: false })).toEqual({
    warnPercent: 25,
    pausePercent: 100,
    gateAuto: false,
  })
  expect(
    mergeRestoredUsage(
      { warnPercent: 70, pausePercent: 90, gateAuto: false },
      { ...DEFAULT_USAGE, pausePercent: 99 },
      DEFAULT_USAGE,
    ),
  ).toEqual({ warnPercent: 70, pausePercent: 99, gateAuto: false })
})

test('resets later than today name the day, and a week or more away the date', () => {
  const today = new Date(2026, 9, 27, 9, 0).getTime()
  const later = new Date(2026, 9, 27, 18, 30).getTime()
  const time = { hour: '2-digit', minute: '2-digit' } as const
  expect(resetLabel(later, today)).toBe(new Date(later).toLocaleTimeString([], time))
  const friday = new Date(2026, 9, 30, 18, 30).getTime()
  expect(resetLabel(friday, today)).toBe(
    new Date(friday).toLocaleString([], { weekday: 'short', ...time }),
  )
  const next = new Date(2026, 10, 3, 9, 0).getTime()
  expect(resetLabel(next, today)).toBe(
    new Date(next).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...time,
    }),
  )
  expect(usageBlock(usage(96, friday), 'claude', DEFAULT_USAGE, today)).toContain(
    resetLabel(friday, today),
  )
})

test('thresholds accept only whole or decimal percentages from 1 to 100', () => {
  expect(parseThreshold('70')).toBe(70)
  expect(parseThreshold(' 92.5 ')).toBe(92.5)
  for (const text of ['', '0', '101', '-5', '7e1', 'abc', '1.'])
    expect(parseThreshold(text)).toBeNull()
})

test('usage refreshes only on exits and turn ends, not on unrelated session updates', () => {
  const agent = (state: 'working' | 'review', sinceMs = 1): SessionState => ({
    running: true,
    status: { agent: { state, sinceMs } } as SessionState['status'],
  })
  const working = agent('working')
  expect(usageMoved(undefined, working)).toBe(false)
  expect(usageMoved(working, working)).toBe(false)
  expect(usageMoved(working, { ...working })).toBe(false)
  expect(usageMoved(working, agent('review'))).toBe(true)
  expect(usageMoved(agent('review'), agent('review'))).toBe(false)
  expect(usageMoved(agent('review'), agent('review', 2))).toBe(true)
  expect(usageMoved(working, { running: false, exitCode: 0 })).toBe(true)
})

test('age explicitly shows stale provider observations', () => {
  expect(usageAge(now, now)).toBe('as of just now')
  expect(usageAge(now, now + 720_000)).toBe('as of 12 min ago')
  expect(usageAge(now, now + 7_200_000)).toBe('as of 2 hr ago')
  expect(usageAge(now, now + 86_400_000)).toBe('as of 1 day ago')
  expect(usageAge(now, now + 172_800_000)).toBe('as of 2 days ago')
})

test('poller always toasts once, respects preferences, refreshes on focus, and cleans up', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const target = new EventTarget()
  vi.stubGlobal('window', target)
  vi.stubGlobal('document', { hasFocus: () => true })
  vi.mocked(usageRead).mockResolvedValue(usage(96))
  const stop = followUsage()
  await refreshUsage()
  expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(usageRead).toHaveBeenCalledTimes(2)
  expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
  target.dispatchEvent(new Event('focus'))
  await refreshUsage()
  expect(usageRead).toHaveBeenCalledTimes(3)
  useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS, usageLimits: false } })
  vi.mocked(usageRead).mockResolvedValue(usage(96, now + 600_000))
  await refreshUsage()
  expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
  stop()
  await vi.advanceTimersByTimeAsync(60_000)
  target.dispatchEvent(new Event('focus'))
  expect(usageRead).toHaveBeenCalledTimes(4)
})

test('poller checks warnings only when the usage snapshot changes', async () => {
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', { hasFocus: () => true })
  vi.mocked(usageRead).mockResolvedValueOnce(usage(50))
  const getState = vi.spyOn(useStore, 'getState')
  const stop = followUsage()
  try {
    await refreshUsage()
    expect(getState).toHaveBeenCalledTimes(1)
    useUsage.setState({ error: 'Read failed' })
    useUsage.setState({ error: null })
    expect(getState).toHaveBeenCalledTimes(1)
    useUsage.setState({ usage: usage(60) })
    expect(getState).toHaveBeenCalledTimes(2)
  } finally {
    stop()
    getState.mockRestore()
  }
})

test('background warnings keep a toast and native delivery rechecks focus and preferences', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubGlobal('window', new EventTarget())
  let focused = false
  vi.stubGlobal('document', { hasFocus: () => focused })
  vi.mocked(usageRead).mockResolvedValue(usage(96))
  const { sendUsageNotification } = await import('./notifications')
  const stop = followUsage()
  try {
    await refreshUsage()
    expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
    expect(sendUsageNotification).toHaveBeenCalledTimes(1)
    const [body, stillNeeded] = vi.mocked(sendUsageNotification).mock.calls[0]
    expect(body).toContain('Claude 5-hour limit is 96% used')
    expect(stillNeeded()).toBe(true)
    focused = true
    expect(stillNeeded()).toBe(false)
    focused = false
    useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS, usageLimits: false } })
    expect(stillNeeded()).toBe(false)
  } finally {
    stop()
  }
})

test('warnings share live window and threshold rules for the rail, alerts and Auto', () => {
  expect(usageWarnings(null, DEFAULT_USAGE, now)).toEqual([])
  expect(usageWarnings(usage(79), DEFAULT_USAGE, now)).toEqual([])
  expect(usageWarnings(usage(96, now), DEFAULT_USAGE, now)).toEqual([])
  expect(usageWarnings(usage(80), DEFAULT_USAGE, now)).toMatchObject([
    { provider: 'claude', key: 'fiveHour', level: 'warn' },
  ])
  expect(usageWarnings(usage(95), DEFAULT_USAGE, now)).toMatchObject([
    { provider: 'claude', key: 'fiveHour', level: 'limit' },
  ])
})

test.each(['enabled', 'usageLimits'] as const)(
  're-enabling %s consumes old crossings but still alerts on new levels and resets',
  async (preference) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('document', { hasFocus: () => true })
    useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS, [preference]: false } })
    vi.mocked(usageRead).mockResolvedValue(usage(85))
    const stop = followUsage()
    try {
      await refreshUsage()
      expect(useStore.getState().setNotificationToast).not.toHaveBeenCalled()
      useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS } })
      expect(useStore.getState().setNotificationToast).not.toHaveBeenCalled()
      vi.mocked(usageRead).mockResolvedValue(usage(96))
      await refreshUsage()
      expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
      useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS, [preference]: false } })
      vi.mocked(usageRead).mockResolvedValue(usage(96, now + 3_600_000))
      await refreshUsage()
      useStore.setState({ notifications: { ...DEFAULT_NOTIFICATIONS } })
      expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(1)
      vi.mocked(usageRead).mockResolvedValue(usage(96, now + 7_200_000))
      await refreshUsage()
      expect(useStore.getState().setNotificationToast).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  },
)
