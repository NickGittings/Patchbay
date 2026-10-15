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
    laneSessions: [{ sessionId: 'lane', startedMs: 5 }, { sessionId: 7 }, { sessionId: 'x' }],
  })
  expect(restored?.reviewers).toEqual(['claude', 'codex'])
  expect(restored?.laneSessions).toEqual([
    { sessionId: 'lane', startedMs: 5 },
    { sessionId: 'x', startedMs: undefined },
  ])
})
