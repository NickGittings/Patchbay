import { expect, test } from 'vitest'
import { restoredAuto } from './autoRestore'

const saved = {
  runId: 'r',
  status: 'running',
  stage: 'fix',
  goal: 'Goal',
  effort: 'standard',
  merge: { mode: 'ask', destinationBranch: 'main' },
  device: 'claude',
  round: 1,
  log: [],
  sessionId: 's',
  sessionOwned: true,
  sessionStartedMs: 1000,
  sessionBrief: {
    sessionId: 's',
    auto: { goal: 'Goal', fixFloor: 'medium', effortNote: 'Note', commit: true },
  },
}

test('a restored run keeps a complete brief and owns only a session with a start time', () => {
  expect(restoredAuto(saved)).toMatchObject({
    status: 'paused',
    sessionOwned: true,
    sessionBrief: saved.sessionBrief,
  })
  expect(restoredAuto({ ...saved, sessionStartedMs: undefined })?.sessionOwned).toBe(false)
})

test('a brief the backend could not read is dropped', () => {
  const { effortNote: _, ...partial } = saved.sessionBrief.auto
  for (const auto of [
    partial,
    { ...saved.sessionBrief.auto, commit: 'yes' },
    { ...partial, fixFloor: 'odd' },
  ])
    expect(
      restoredAuto({ ...saved, sessionBrief: { sessionId: 's', auto } })?.sessionBrief,
    ).toBeUndefined()
  expect(
    restoredAuto({ ...saved, sessionBrief: { ...saved.sessionBrief, kickoff: { kind: 'other' } } })
      ?.sessionBrief,
  ).toBeUndefined()
})

test('a restored budget wait remains explicit while failed fixes cannot accept findings', () => {
  expect(restoredAuto({ ...saved, waitingFor: 'fixBudget' })?.waitingFor).toBe('fixBudget')
  expect(restoredAuto({ ...saved, waitingFor: 'unknown' })?.waitingFor).toBeUndefined()
  expect(restoredAuto({ ...saved, status: 'failed' })?.waitingFor).toBeUndefined()
})

test('per-stage agents survive a restore, and older runs keep their single preset', () => {
  expect(restoredAuto(saved)?.agents).toBeUndefined()
  expect(
    restoredAuto({
      ...saved,
      agents: { plan: 'claude', implement: 'codex', fix: '', merge: 7, other: 'x' },
    })?.agents,
  ).toEqual({ plan: 'claude', implement: 'codex' })
  expect(restoredAuto({ ...saved, agents: ['codex'] })?.agents).toBeUndefined()
})

test('parallel reviewers and their sessions survive a restore', () => {
  const restored = restoredAuto({
    ...saved,
    reviewers: ['claude', 'codex', 'codex', 3],
    laneSessions: [
      { sessionId: 'lane', startedMs: 5, turnSince: 8, observedWorking: true },
      { sessionId: 7 },
      { sessionId: 'x', requestId: 'r' },
      { sessionId: 'y', requestId: 9 },
    ],
  })
  expect(restored?.reviewers).toEqual(['claude', 'codex'])
  expect(restored?.laneSessions).toEqual([
    { sessionId: 'lane', startedMs: 5, turnSince: 8, observedWorking: true },
    { sessionId: 'x', startedMs: undefined, requestId: 'r' },
    { sessionId: 'y', startedMs: undefined },
  ])
})

test('background permission survives restore and only literal true enables it', () => {
  expect(restoredAuto({ ...saved, background: true })).toMatchObject({
    background: true,
    status: 'paused',
    pauseKind: 'restored',
    pausedMs: expect.any(Number),
  })
  for (const background of [undefined, false, 'true', 1])
    expect(restoredAuto({ ...saved, background })?.background).toBe(false)
})

test.each(['user', 'needsUser'] as const)(
  'restore preserves a %s pause and its reason',
  (pauseKind) => {
    expect(
      restoredAuto({ ...saved, status: 'paused', pauseKind, pausedMs: 1, reason: 'Wait for me' }),
    ).toMatchObject({
      status: 'paused',
      pauseKind,
      pausedMs: 1,
      reason: 'Wait for me',
    })
  },
)

test.each(['restored', 'inactive', 'interrupted'] as const)(
  'restore preserves the pause timestamp after a %s pause',
  (pauseKind) => {
    expect(restoredAuto({ ...saved, status: 'paused', pauseKind, pausedMs: 1 })).toMatchObject({
      status: 'paused',
      pauseKind: 'restored',
      pausedMs: 1,
    })
  },
)

test('legacy pauses and pending user input cannot become auto-resumable on restart', () => {
  for (const pauseKind of [undefined, 'unknown'])
    expect(restoredAuto({ ...saved, status: 'paused', pauseKind })?.pauseKind).toBe('user')
  expect(restoredAuto({ ...saved, status: 'waitingOnYou' })?.pauseKind).toBe('needsUser')
})

test.each(['done', 'stopped', 'failed'] as const)(
  'finished %s runs keep no pause state',
  (status) => {
    expect(restoredAuto({ ...saved, status, pauseKind: 'interrupted', pausedMs: 1 })).toMatchObject(
      {
        status,
        pauseKind: undefined,
        pausedMs: undefined,
      },
    )
  },
)

test('restore gives new and legacy pauses a timestamp and ignores invalid saved timestamps', () => {
  const before = Date.now()
  for (const pausedMs of [undefined, NaN, Infinity, 'old']) {
    const result = restoredAuto({ ...saved, status: 'paused', pausedMs })
    expect(result?.pausedMs).toBeGreaterThanOrEqual(before)
  }
  // A running run's leftover pause fields do not date its new restoration pause.
  expect(restoredAuto({ ...saved, pausedMs: 1 })?.pausedMs).toBeGreaterThanOrEqual(before)
})

test.each([true, false, undefined])('restore preserves planner ownership (%s)', (plannerTurn) => {
  expect(restoredAuto({ ...saved, stage: 'implement', plannerTurn })?.plannerTurn).toBe(plannerTurn)
})

test('a coordinated launch identity survives restart before its result is confirmed', () => {
  expect(
    restoredAuto({ ...saved, stage: 'implement', implementationLaunch: 'reserved' }),
  ).toMatchObject({ stage: 'implement', status: 'paused', implementationLaunch: 'reserved' })
  expect(restoredAuto({ ...saved, implementationLaunch: 42 })?.implementationLaunch).toBeUndefined()
})

test('explicit schedules survive restart only with compatible pause metadata', () => {
  const scheduled = {
    ...saved,
    status: 'paused',
    pauseKind: 'scheduled',
    resumeTrigger: { kind: 'time', atMs: 1000 },
  }
  expect(restoredAuto(scheduled)).toMatchObject({
    pauseKind: 'scheduled',
    resumeTrigger: scheduled.resumeTrigger,
  })
  for (const patch of [
    { status: 'running' },
    { pauseKind: 'needsUser' },
    { pauseKind: 'user' },
    { status: 'stopped' },
    { resumeTrigger: { kind: 'time', atMs: NaN } },
  ])
    expect(restoredAuto({ ...scheduled, ...patch })?.resumeTrigger).toBeUndefined()
  const usage = {
    ...saved,
    status: 'paused',
    pauseKind: 'usage',
    resumeOnUsageReset: true,
    usageWait: { providers: ['codex'], atMs: 1000 },
    resumeTrigger: { kind: 'usage', atMs: 1000 },
  }
  expect(restoredAuto(usage)).toMatchObject({
    pauseKind: 'usage',
    resumeTrigger: usage.resumeTrigger,
  })
  expect(restoredAuto({ ...usage, resumeOnUsageReset: false })?.resumeTrigger).toBeUndefined()
  expect(
    restoredAuto({ ...usage, usageWait: { providers: ['invalid'], atMs: 1000 } })?.resumeTrigger,
  ).toBeUndefined()
})

test('only active autonomous runs request startup continuation', () => {
  expect(restoredAuto({ ...saved, autonomous: true })).toMatchObject({
    status: 'paused',
    pauseKind: 'restored',
    restartPending: true,
    autonomous: true,
  })
  for (const status of ['paused', 'waitingOnYou', 'failed', 'done', 'stopped'])
    expect(restoredAuto({ ...saved, autonomous: true, status })?.restartPending).toBe(false)
  for (const autonomous of [undefined, false, 'true', 1])
    expect(restoredAuto({ ...saved, autonomous })?.restartPending).toBe(false)
  expect(
    restoredAuto({
      ...saved,
      autonomous: true,
      status: 'paused',
      pauseKind: 'restored',
      restartPending: true,
    })?.restartPending,
  ).toBe(true)
})

test('recovery reservations, validation identity and autonomous briefs survive restart', () => {
  const recovery = {
    stage: 'plan',
    mark: 'artifact',
    attempts: 2,
    action: 'relaunch',
    atMs: 123,
    pending: true,
    reason: 'No plan',
  }
  expect(
    restoredAuto({
      ...saved,
      autonomous: true,
      recovery,
      validationHead: 'validated',
      sessionBrief: {
        ...saved.sessionBrief,
        auto: { ...saved.sessionBrief.auto, autonomous: true },
      },
    }),
  ).toMatchObject({
    recovery,
    validationHead: 'validated',
    sessionBrief: { auto: { autonomous: true } },
  })
  for (const patch of [{ attempts: -1 }, { attempts: 4 }, { stage: 'other' }, { mark: 7 }])
    expect(
      restoredAuto({ ...saved, recovery: { ...recovery, ...patch } })?.recovery,
    ).toBeUndefined()
})

test('an autonomous run with a future schedule waits for that schedule after restart', () => {
  const trigger = { kind: 'time', atMs: Date.now() + 3600000 }
  expect(
    restoredAuto({
      ...saved,
      autonomous: true,
      status: 'paused',
      pauseKind: 'scheduled',
      resumeTrigger: trigger,
    }),
  ).toMatchObject({
    restartPending: false,
    resumeTrigger: trigger,
    pauseKind: 'scheduled',
  })
})

test('cleanup choices survive restoration and older runs default to Keep', () => {
  expect(restoredAuto(saved)?.merge.cleanup).toBe('keep')
  for (const cleanup of ['ask', 'keep', 'delete']) {
    expect(restoredAuto({ ...saved, merge: { ...saved.merge, cleanup } })?.merge.cleanup).toBe(
      cleanup,
    )
  }
  expect(
    restoredAuto({ ...saved, merge: { ...saved.merge, cleanup: 'invalid' } })?.merge.cleanup,
  ).toBe('keep')
})
