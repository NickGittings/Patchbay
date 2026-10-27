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
