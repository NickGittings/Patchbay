import { describe, expect, test } from 'vitest'
import { LEAD_RECIPIENT, type AutoRun, type AutoStage, type SessionRecord } from '../types'
import type { ChatTeam } from './chatTeams'
import type { SimpleEntry, SimpleState } from './simple'
import type { FlowSnapshot } from './simpleFlow'
import { autoCurrent, autoStepper, stageModel } from './stageModel'

const STAGES: AutoStage[] = [
  'scan',
  'plan',
  'implement',
  'validate',
  'review',
  'fix',
  'mergeGate',
  'merge',
  'done',
]
const STATUSES: AutoRun['status'][] = [
  'running',
  'waitingOnYou',
  'paused',
  'failed',
  'stopped',
  'done',
]
const run = (patch: Partial<AutoRun> = {}) =>
  ({
    runId: 'run',
    status: 'running',
    stage: 'review',
    log: [{ atMs: 10, text: 'Started' }],
    merge: { destinationBranch: 'main' },
    ...patch,
  }) as AutoRun
const launch = (origin: 'auto' | 'manual' | 'chat', atMs = 20): SimpleEntry => ({
  id: `${origin}-${atMs}`,
  kind: 'action',
  action: 'review',
  stage: 'review',
  atMs,
  sessionId: 'reviewer',
  generation: 1,
  origin,
})
const simple = (...log: SimpleEntry[]): SimpleState => ({ startedMs: 1, log })

describe('autoCurrent', () => {
  test('a run in progress is always current', () => {
    for (const status of ['running', 'waitingOnYou', 'paused'] as const)
      expect(autoCurrent(run({ status }), simple(launch('manual')))).toBe(true)
  })
  test('an ended run stays current until work outside it starts', () => {
    for (const status of ['done', 'stopped', 'failed'] as const) {
      expect(autoCurrent(run({ status }), simple())).toBe(true)
      expect(autoCurrent(run({ status }), simple(launch('auto')))).toBe(true)
      expect(autoCurrent(run({ status }), simple(launch('manual', 5)))).toBe(true)
      expect(autoCurrent(run({ status }), simple(launch('manual')))).toBe(false)
      expect(autoCurrent(run({ status }), simple(launch('chat')))).toBe(false)
    }
  })
  test('no run is never current', () => {
    expect(autoCurrent(null, simple())).toBe(false)
  })
})

test.each(STAGES.flatMap((stage) => STATUSES.map((status) => [stage, status] as const)))(
  'Auto at %s while %s shows one stage in progress, Fix inside Review',
  (stage, status) => {
    const items = autoStepper(run({ stage, status }))
    expect(items.map((i) => i.stage)).toEqual(['plan', 'build', 'review', 'merge'])
    const at = {
      scan: 'plan',
      plan: 'plan',
      implement: 'build',
      validate: 'build',
      review: 'review',
      fix: 'review',
      mergeGate: 'merge',
      merge: 'merge',
      done: undefined,
    }[stage]
    const live = items.filter((i) => i.state !== 'done' && i.state !== 'upcoming')
    if (!at) expect(items.every((i) => i.state === 'done')).toBe(true)
    else {
      expect(live.map((i) => i.stage)).toEqual([at])
      expect(live[0].state).toBe(
        status === 'failed'
          ? 'failed'
          : status === 'paused' || status === 'stopped'
            ? 'stopped'
            : stage === 'mergeGate'
              ? 'ready'
              : status === 'waitingOnYou'
                ? 'attention'
                : 'current',
      )
    }
  },
)

test('an agent question Auto waits on needs attention like any other wait', () => {
  expect(
    autoStepper(run({ stage: 'implement', status: 'waitingOnYou', waitingFor: 'agentInput' }))[1]
      .state,
  ).toBe('attention')
})

test('a wait on you says why rather than how far Auto got', () => {
  expect(
    autoStepper(run({ stage: 'fix', status: 'waitingOnYou', reason: 'Fix budget exhausted' }))[2],
  ).toEqual({ stage: 'review', state: 'attention', note: 'Fix budget exhausted' })
})

test('folded Auto stages name themselves; a reason takes their place', () => {
  expect(autoStepper(run({ stage: 'validate' }))[1].note).toBe('Validating')
  expect(autoStepper(run({ stage: 'scan' }))[0].note).toBe('Scanning')
  expect(autoStepper(run({ stage: 'fix' }))[2].note).toBe('Fixing')
  expect(
    autoStepper(run({ stage: 'implement', status: 'paused', reason: 'Out of credit' }))[1],
  ).toMatchObject({ state: 'stopped', note: 'Paused · Out of credit' })
  expect(autoStepper(run({ stage: 'review', baseCommit: 'abc' })).map((i) => i.stage)).toEqual([
    'plan',
    'build',
    'review',
  ])
})

describe('stageModel', () => {
  const reviewer = {
    id: 'reviewer',
    metadata: {
      projectId: 'p',
      task: null,
      componentId: '@review',
      terminalId: 'codex',
      kind: 'agent',
    },
    spec: { cwd: '/p' },
    snapshot: { generation: 1, startedMs: 20, running: true },
    history: [],
  } as unknown as SessionRecord
  const snapshot = (auto: AutoRun | null, log: SimpleEntry[] = []): FlowSnapshot => ({
    records: [reviewer],
    sessions: {
      reviewer: {
        running: true,
        generation: 1,
        status: { agent: { state: 'working', authoritative: true, sinceMs: 20 } },
      } as never,
    },
    simple: simple(...log),
    auto,
    worktree: { projectId: 'p', task: null, path: '/p' },
    now: 1_000_000,
  })
  test.each([
    { note: undefined, expected: 'Lead deciding' },
    { note: 'Checking the reviewer’s findings', expected: 'Checking the reviewer’s findings' },
  ])('the strip shows “$expected” while the lead decides', ({ note, expected }) => {
    const input = snapshot(null, [{ ...launch('manual'), origin: 'lead' } as SimpleEntry])
    input.sessions.reviewer.running = false
    input.lead = 'lead'
    const team = {
      state: 'running',
      lead: { sessionId: 'lead' },
      status: note ? { step: 'reviewed', note, atMs: 30 } : undefined,
    } as ChatTeam
    input.sessions.lead = {
      running: true,
      status: { agent: { state: 'working' } },
    } as FlowSnapshot['sessions'][string]

    const model = stageModel({ snapshot: input, team })
    expect(model.state.waitingOn).toBe(LEAD_RECIPIENT)
    expect(model.stepper.find((item) => item.stage === 'review')?.note).toBe(expected)
  })
  test('while Auto runs, Chat’s strip is the Auto panel’s', () => {
    for (const stage of STAGES) {
      const auto = run({ stage })
      expect(stageModel({ snapshot: snapshot(auto) }).stepper).toEqual(autoStepper(auto))
    }
  })
  test('a failed run halts the strip until work outside it starts', () => {
    const failed = run({ status: 'failed', reason: 'Validation failed' })
    expect(stageModel({ snapshot: snapshot(failed) })).toMatchObject({
      autoHalt: 'failed',
      autoCurrent: true,
    })
    const later = stageModel({ snapshot: snapshot(failed, [launch('manual')]) })
    expect(later).toMatchObject({ autoHalt: undefined, autoCurrent: false })
    expect(later.stepper.find((i) => i.stage === 'review')?.state).toBe('current')
  })
  test('work after a finished in-place run keeps the strip without Merge', () => {
    const done = run({ status: 'done', stage: 'done', baseCommit: 'abc' })
    const later = stageModel({ snapshot: snapshot(done, [launch('manual')]) })
    expect(later.stepper.map((i) => i.stage)).toEqual(['plan', 'build', 'review'])
  })
})
