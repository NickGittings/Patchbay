import { describe, expect, test } from 'vitest'
import {
  chatStatus,
  chatStepHeading,
  chatStepper,
  flow,
  workflowPromptKey,
  type FlowSnapshot,
} from './simpleFlow'
import {
  LAUNCH_RECORD_GRACE_MS,
  pendingLaunch,
  retryMergeBranch,
  thread,
  type SimpleState,
} from './simple'
import type { AutoRun, ReviewFindings, SessionRecord, SessionState } from '../types'
const worktree = { projectId: 'p', task: 't', path: '/t', branch: 'feature' }
const record = (scope: string): SessionRecord =>
  ({
    id: scope,
    metadata: { projectId: 'p', componentId: scope, kind: 'agent', task: 't' },
    spec: { cwd: '/t', merge_source: '/t' },
    snapshot: { startedMs: 10 },
    history: [],
  }) as unknown as SessionRecord
const session = (state: string): SessionState =>
  ({
    running: true,
    generation: 1,
    status: { agent: { state, authoritative: true, sinceMs: 20, turnId: 'turn' } },
  }) as SessionState
const snapshot = (scope?: string, state = 'review'): FlowSnapshot => ({
  worktree,
  now: 40,
  records: scope ? [record(scope)] : [],
  sessions: scope ? { [scope]: session(state) } : {},
  simple: { startedMs: 1, log: [] },
  auto: null,
  base: 'main',
})
const findings = (clean: boolean): ReviewFindings =>
  ({
    verdict: { clean, counts: { critical: 0, high: clean ? 0 : 2, medium: 0, low: 0 } },
  }) as ReviewFindings

/** This chat prompted the shared planner's run, so it is this conversation's. */
const prompted = (s: FlowSnapshot) => {
  s.simple!.log.push({
    id: 'ask',
    kind: 'prompt',
    stage: 'plan',
    atMs: 5,
    sessionId: '@plan',
    generation: 1,
    text: 'Plan it',
    mentions: [],
  })
  return s
}
test('idle and planning ignore old shared plans until the planner finishes a fresh one', () => {
  expect(flow(snapshot()).step).toBe('idle')
  expect(
    flow({ ...snapshot(), plan: { text: 'old', cut: false, savedMs: 0 } }).prompt,
  ).toBeUndefined()
  expect(flow(prompted(snapshot('@plan', 'working'))).step).toBe('planning')
  const ready = { ...prompted(snapshot('@plan')), plan: { text: 'new', cut: false, savedMs: 30 } }
  expect(flow(ready)).toMatchObject({
    step: 'planReady',
    prompt: { text: 'Build this plan?', actions: [{ action: 'build' }, { action: 'plan' }] },
  })
  expect(flow({ ...ready, sessions: { '@plan': session('working') } }).prompt).toBeUndefined()
})
test('a retired stage agent leaves the next stage in charge of the step', () => {
  const s = snapshot('@task')
  const stopped = { ...s.sessions['@task'], running: false }
  expect(flow({ ...s, sessions: { '@task': stopped } }).step).toBe('built')
  const reviewing = {
    ...snapshot('@review', 'working'),
    records: [record('@task'), record('@review')],
  }
  reviewing.records[1] = {
    ...reviewing.records[1],
    snapshot: { startedMs: 30 },
  } as unknown as SessionRecord
  reviewing.sessions['@task'] = stopped
  expect(flow(reviewing).step).toBe('reviewing')
})
test('build, review, fix and merge prompts follow the latest turn and artifacts', () => {
  expect(flow(snapshot('@task', 'working')).step).toBe('building')
  expect(flow(snapshot('@task'))).toMatchObject({
    step: 'built',
    prompt: { text: 'Building done. Review the changes?' },
  })
  expect(flow(snapshot('@review', 'working')).step).toBe('reviewing')
  expect(flow({ ...snapshot('@review'), findings: findings(false) })).toMatchObject({
    step: 'reviewed',
    prompt: { text: '2 issues found. Fix them?' },
  })
  expect(flow({ ...snapshot('@review'), findings: findings(true) }).prompt?.text).toBe(
    'No issues. Merge into main?',
  )
  for (const paths of [[], ['src/a', 'src/b']])
    expect(
      flow({ ...snapshot('@review'), findings: findings(true), conflicts: paths }).prompt?.text,
    ).toBe(paths.length ? 'Conflicts in src/a, src/b.' : 'No conflicts with main. Merge?')
  const fix = snapshot('@task')
  fix.simple!.log.push({
    id: 'fix',
    atMs: 11,
    kind: 'action',
    action: 'fix',
    stage: 'build',
    sessionId: '@task',
    generation: 1,
  })
  expect(flow(fix)).toMatchObject({ step: 'fixed', prompt: { text: 'Fixes done.' } })
  expect(flow({ ...fix, sessions: { '@task': session('working') } }).step).toBe('fixing')
  expect(flow(snapshot('@merge', 'working')).step).toBe('merging')
  expect(flow({ ...snapshot('@merge'), outcome: 'merged' })).toMatchObject({
    step: 'merged',
    prompt: { text: 'Merged into main.', actions: [] },
  })
})
test('Auto drives steps and renders its gates without launching manual actions', () => {
  const auto = {
    status: 'running',
    stage: 'review',
    merge: { destinationBranch: 'main' },
  } as AutoRun
  expect(flow({ ...snapshot('@task'), auto }).step).toBe('reviewing')
  expect(
    flow({ ...snapshot(), auto: { ...auto, stage: 'mergeGate', status: 'waitingOnYou' } }).prompt
      ?.actions[0].action,
  ).toBe('mergeApproval')
  expect(
    flow({
      ...snapshot(),
      auto: { ...auto, stage: 'fix', status: 'waitingOnYou', waitingFor: 'fixBudget' },
    }).prompt?.actions[0].action,
  ).toBe('resumeAuto')
  expect(
    flow({
      ...snapshot(),
      auto: { ...auto, stage: 'plan', status: 'waitingOnYou', waitingFor: 'agentInput' },
    }).prompt,
  ).toBeUndefined()
})

test('review waits for every running lane and merge-anyway still checks conflicts', () => {
  const s = snapshot('@review')
  const other = { ...record('@review'), id: 'other' }
  s.records = [...s.records, other]
  s.sessions.other = session('working')
  s.findings = findings(false)
  expect(flow(s)).toMatchObject({ step: 'reviewing', busyAgent: { id: 'other' } })
  s.sessions.other = session('review')
  s.conflicts = []
  expect(flow(s)).toMatchObject({
    step: 'reviewed',
    prompt: { text: 'No conflicts with main. Merge?' },
  })
})
test('a later planning action supersedes an earlier merge outcome and completed Auto', () => {
  const s = snapshot('@plan', 'working')
  s.outcome = 'merged'
  s.auto = {
    status: 'done',
    stage: 'done',
    log: [{ atMs: 1, text: 'Done' }],
    merge: { destinationBranch: 'release' },
  } as AutoRun
  s.simple!.log.push({
    id: 'p',
    kind: 'prompt',
    stage: 'plan',
    atMs: 10,
    sessionId: '@plan',
    generation: 1,
    text: 'Next feature',
    mentions: [],
  })
  expect(flow(s)).toMatchObject({ step: 'planning' })
})
test('an agent at its prompt after a resume nobody here prompted is done, a fresh kickoff is not', () => {
  const resumed = snapshot('@task', 'idle')
  resumed.sessions['@task'].status!.agent!.turnId = null
  expect(flow(resumed)).toMatchObject({ step: 'built' })
  const launched = snapshot('@task', 'idle')
  launched.sessions['@task'].status!.agent!.turnId = null
  launched.simple!.log.push({
    id: 'build',
    atMs: 11,
    kind: 'action',
    action: 'implement',
    stage: 'build',
    sessionId: '@task',
    generation: 1,
  })
  expect(flow(launched)).toMatchObject({ step: 'building', busyAgent: { id: '@task' } })
  // Another run of that agent (a later generation) is no longer waiting for this kickoff.
  launched.sessions['@task'].generation = 2
  expect(flow(launched).step).toBe('built')
})
test('a reviewer whose idle is stale or unconfirmed still holds the review open', () => {
  const s = snapshot('@review')
  const other = { ...record('@review'), id: 'other' }
  s.records = [...s.records, other]
  s.findings = findings(false)
  for (const authoritative of [false, undefined]) {
    s.sessions.other = session('idle')
    s.sessions.other.status!.agent!.authoritative = authoritative
    expect(flow(s)).toMatchObject({ step: 'reviewing', busyAgent: { id: 'other' } })
  }
  s.sessions.other = session('idle')
  expect(flow(s).step).toBe('reviewed')
})
test('a shared planner another chat is using does not make this one plan', () => {
  const s = snapshot('@plan', 'working')
  s.records[0].metadata.task = null // Historical shared planner, before explicit scopes.
  s.plan = { text: 'new', cut: false, savedMs: 30 }
  expect(flow(s).step).toBe('planReady')
  expect(flow(s).busyAgent).toBeUndefined()
  expect(flow(prompted(s)).step).toBe('planning')
})

test('follow-ups hide next-step actions until each prompted agent finishes its new turn', () => {
  for (const scope of ['@plan', '@task', '@review', '@merge']) {
    for (const finished of ['idle', 'review', 'ended']) {
      const s = snapshot(scope, finished)
      s.plan = { text: 'Plan', savedMs: 70, cut: false }
      s.findings = findings(false)
      s.sessions[scope].replies = [{ sequence: 1, atMs: 20, text: 'Done', turn: 'previous' }]
      s.simple!.log.push({
        id: 'follow-up',
        kind: 'prompt',
        stage:
          scope === '@plan'
            ? 'plan'
            : scope === '@review'
              ? 'review'
              : scope === '@merge'
                ? 'merge'
                : 'build',
        sessionId: scope,
        generation: 1,
        atMs: 40,
        text: 'One more thing',
        mentions: [],
      })
      const waiting = flow(s)
      expect(waiting.prompt).toBeUndefined()
      expect(waiting.busyAgent?.id).toBe(scope)
      s.sessions[scope].status!.agent!.sinceMs = 60
      expect(flow(s).prompt).toBeDefined()
    }
  }
})

test('a follow-up sent to another review lane keeps the whole review open', () => {
  const s = snapshot('@review')
  s.records = [...s.records, { ...record('@review'), id: 'other' }]
  s.sessions.other = session('review')
  s.findings = findings(true)
  s.simple!.log.push({
    id: 'follow-up',
    kind: 'prompt',
    stage: 'review',
    sessionId: 'other',
    generation: 1,
    atMs: 40,
    text: 'Check again',
    mentions: [],
  })
  expect(flow(s)).toMatchObject({ step: 'reviewing', busyAgent: { id: 'other' } })
  expect(flow(s).prompt).toBeUndefined()
})

test.each(['implement', 'fix', 'review', 'merge'] as const)(
  'a logged %s launch stays working before its record appears',
  (action) => {
    const s = snapshot('@review')
    s.records = [...s.records, record('@task')]
    s.sessions['@task'] = session('review')
    s.findings = findings(false)
    s.simple!.log.push({
      id: 'launch',
      atMs: 30,
      kind: 'action',
      action,
      stage: action === 'implement' || action === 'fix' ? 'build' : action,
      sessionId: 'not-reconciled-yet',
    })
    const result = flow(s)
    expect(result.step).toBe(
      { implement: 'building', fix: 'fixing', review: 'reviewing', merge: 'merging' }[action],
    )
    expect(result.prompt).toBeUndefined()
    expect(result.step).not.toBe('fixed')
    expect(flow({ ...s, now: 30 + LAUNCH_RECORD_GRACE_MS - 1 }).prompt).toBeUndefined()
  },
)

test('a launch whose record never appears gives way to the usual prompts after a grace', () => {
  const s = snapshot('@review')
  s.records = [...s.records, record('@task')]
  s.sessions['@task'] = session('review')
  s.findings = findings(false)
  s.simple!.log.push({
    id: 'launch',
    atMs: 30,
    kind: 'action',
    action: 'implement',
    stage: 'build',
    sessionId: 'forgotten',
  })
  const result = flow({ ...s, now: 30 + LAUNCH_RECORD_GRACE_MS })
  expect(result.prompt?.actions.length).toBeGreaterThan(0)
})

test('a fresh merge launch does not reuse a previous merged outcome before reconciliation', () => {
  const s = snapshot('@merge')
  s.outcome = 'merged'
  s.simple!.log.push({
    id: 'merge-again',
    atMs: 30,
    kind: 'action',
    action: 'merge',
    stage: 'merge',
    sessionId: 'new-merger',
  })
  expect(flow(s)).toMatchObject({ step: 'merging' })
  expect(flow(s).prompt).toBeUndefined()
})

test.each(['review', 'merge'] as const)(
  'a %s rerun waits for its generation in the reused slot',
  (stage) => {
    const s = snapshot(`@${stage}`)
    s.outcome = 'merged'
    s.findings = findings(false)
    s.simple!.log.push({
      id: 'rerun',
      atMs: 30,
      kind: 'action',
      action: stage,
      stage,
      sessionId: `@${stage}`,
      generation: 2,
    })
    expect(flow(s)).toMatchObject({ step: stage === 'review' ? 'reviewing' : 'merging' })
    expect(flow(s).prompt).toBeUndefined()
    expect(flow({ ...s, now: 30 + LAUNCH_RECORD_GRACE_MS - 1 }).prompt).toBeUndefined()
    s.sessions[`@${stage}`].generation = 2
    s.sessions[`@${stage}`].status!.agent!.sinceMs = 40
    s.outcome = undefined
    expect(flow(s).prompt).toBeDefined()
  },
)

test('an unconfirmed run cannot borrow the previous run in its slot', () => {
  const s = snapshot('@review')
  s.findings = findings(false)
  s.simple!.log.push({
    id: 'unknown',
    atMs: 30,
    kind: 'action',
    action: 'review',
    stage: 'review',
    sessionId: '@review',
  })
  expect(flow(s)).toMatchObject({ step: 'reviewing' })
  expect(flow(s).prompt).toBeUndefined()
  expect(flow({ ...s, now: 30 + LAUNCH_RECORD_GRACE_MS }).prompt).toBeDefined()
})

test('an expired unclaimed launch is already settled on the first Chat render', () => {
  const s = snapshot('@task')
  s.simple!.log.push({
    id: 'old',
    atMs: Date.now() - LAUNCH_RECORD_GRACE_MS - 1,
    kind: 'action',
    action: 'implement',
    stage: 'build',
    sessionId: 'missing',
  })
  expect(pendingLaunch(s, s.records)).toBeUndefined()
  expect(flow({ ...s, now: undefined }).prompt).toBeDefined()
})

test('a recovered merge with unknown status does not claim it is unfinished', () => {
  expect(flow(snapshot('@merge')).prompt?.text).not.toBe('Merge has not completed.')
})

test('merge status loading and failures never offer conflict recovery', () => {
  const s = snapshot('@merge')
  expect(flow({ ...s, outcomePending: true }).prompt).toBeUndefined()
  for (const outcome of [undefined, 'inProgress'] as const) {
    const prompt = flow({ ...s, outcome }).prompt!
    expect(prompt.actions).toEqual([{ action: 'retryMergeStatus', label: 'Retry status' }])
  }
  expect(flow({ ...s, outcome: 'dirty' }).prompt!.actions).toEqual([
    { action: 'merge', label: 'Merge again' },
    { action: 'retryMergeStatus', label: 'Retry status' },
  ])
  expect(flow({ ...s, outcomeError: 'The merge branches changed' }).prompt).toMatchObject({
    text: 'Merge status unavailable: The merge branches changed',
  })
  expect(flow({ ...s, outcome: 'notMerged' }).prompt?.actions[0].action).toBe('checkMerge')
  expect(flow({ ...s, outcome: 'notMerged', conflicts: [] }).prompt?.actions[0].action).toBe(
    'merge',
  )
  for (const outcome of ['merged', 'alreadyIntegrated'] as const)
    expect(flow({ ...s, outcome }).step).toBe('merged')
})

test('prompt identity survives loading and activity, but changes for new attempts and scopes', () => {
  const s = snapshot('@merge')
  const key = (snapshot: FlowSnapshot) =>
    workflowPromptKey(snapshot, thread(snapshot, snapshot.worktree), flow(snapshot))
  const original = key(s)
  expect(key({ ...s, outcomePending: true })).toBe(original)
  expect(key({ ...s, outcomeError: 'Source worktree no longer exists' })).toBe(original)
  expect(key({ ...s, sessions: { '@merge': session('working') } })).toBe(original)
  expect(key({ ...s, outcome: 'merged' })).not.toBe(original)
  const recovery = key({ ...s, outcome: 'notMerged' })
  expect(recovery).not.toBe(original)
  expect(key({ ...s, outcome: 'notMerged', conflicts: [] })).not.toBe(recovery)
  expect(key({ ...s, worktree: { ...worktree, task: 'other' } })).not.toBe(original)
  expect(key({ ...s, sessions: { '@merge': { ...session('review'), generation: 2 } } })).not.toBe(
    original,
  )
  s.simple!.log.push({
    id: 'attempt',
    kind: 'action',
    action: 'merge',
    stage: 'merge',
    atMs: 11,
    sessionId: '@merge',
    generation: 1,
  })
  const launched = key(s)
  expect(key({ ...s, sessions: { '@merge': session('working') } })).toBe(launched)
  expect(key({ ...s, sessions: { '@merge': { ...session('review'), generation: 2 } } })).not.toBe(
    launched,
  )
  const replacement = {
    ...record('@merge'),
    id: 'new-merge',
    snapshot: { ...record('@merge').snapshot!, generation: 1, startedMs: 100 },
  }
  expect(key({ ...s, records: [replacement], sessions: {} })).not.toBe(launched)
  s.simple!.log.push({ ...s.simple!.log[0], id: 'next-attempt', atMs: 12 })
  expect(key(s)).not.toBe(launched)
})

test('a build lead prompt advances a merged chat to the build stage', () => {
  const s = snapshot('@merge')
  s.outcome = 'merged'
  expect(flow(s).step).toBe('merged')
  const lead = record('@task')
  s.records = [...s.records, lead]
  s.simple!.log.push({
    id: 'next',
    atMs: 40,
    kind: 'prompt',
    stage: 'build',
    sessionId: lead.id,
    text: 'Continue',
    mentions: [],
  })
  expect(thread(s, s.worktree).stage).toBe('build')
  s.sessions = { ...s.sessions, [lead.id]: session('working') }
  expect(flow(s).step).toBe('building')
  const finished = session('review')
  finished.status!.agent!.sinceMs = 50
  s.sessions = { ...s.sessions, [lead.id]: finished }
  expect(flow(s).prompt?.text).toBe('Building done. Review the changes?')
})

test('a coordinating lead’s turns advance no workflow stage', () => {
  const s = snapshot('@task', 'working')
  s.lead = '@task'
  expect(flow(s).step).toBe('idle')
  s.sessions['@task'] = session('review')
  s.simple!.retainedWorkflow = [
    { id: 'old-fix', kind: 'action', action: 'fix', stage: 'build', atMs: 5, sessionId: 'gone' },
  ]
  s.now = 5 + LAUNCH_RECORD_GRACE_MS
  expect(flow(s).step).toBe('idle')
  expect(chatStepper(flow(s).step).every((item) => item.state === 'upcoming')).toBe(true)
})

test('messaging the lead keeps the finished review in charge of the step', () => {
  const s = snapshot('@review')
  s.findings = findings(true)
  s.records = [...s.records, { ...record('@task'), snapshot: { startedMs: 30 } } as SessionRecord]
  s.sessions['@task'] = session('review')
  s.lead = '@task'
  s.simple!.log.push({
    id: 'question',
    kind: 'prompt',
    stage: 'build',
    atMs: 35,
    sessionId: '@task',
    generation: 1,
    text: 'What changed?',
    mentions: [],
  })
  expect(flow(s).step).toBe('reviewed')
})

test('a stage agent adopted as the lead still reports its stage', () => {
  const s = snapshot('@task')
  s.lead = '@task'
  s.simple!.log.push({
    id: 'build',
    kind: 'action',
    action: 'implement',
    stage: 'build',
    atMs: 5,
    sessionId: '@task',
    generation: 1,
  })
  expect(flow(s).step).toBe('built')
})

test('an adopted lead keeps its stage after its process restarts', () => {
  const s = snapshot('@task')
  s.lead = '@task'
  s.sessions['@task'] = { ...s.sessions['@task'], generation: 2 }
  s.simple!.log.push({
    id: 'build',
    kind: 'action',
    action: 'implement',
    stage: 'build',
    atMs: 500,
    sessionId: '@task',
    generation: 1,
  })
  expect(thread(s, worktree).stage).toBe('build')
})

test('a saved prompt without a session still sets the stage', () => {
  const s = snapshot('@review')
  s.simple!.log.push({
    id: 'saved',
    kind: 'prompt',
    stage: 'build',
    atMs: 500,
    text: 'Keep going',
    mentions: [],
  })
  expect(thread(s, worktree).stage).toBe('build')
})

test('merging again targets the branch the dirty merge was launched for', () => {
  const request = {
    source: '/feature',
    sourceBranch: 'feature',
    destination: '/develop',
    destinationBranch: 'develop',
  }
  const simple: SimpleState = {
    startedMs: 0,
    log: [{ id: 'merge', kind: 'action', action: 'merge', stage: 'merge', atMs: 1, request }],
  }
  expect(retryMergeBranch(simple, 'dirty')).toBe('develop')
  expect(retryMergeBranch(simple, 'merged')).toBeUndefined()
})

const states = (items: ReturnType<typeof chatStepper>) =>
  items.map((i) => `${i.stage}:${i.state}${i.note ? `(${i.note})` : ''}`).join(' ')

test('the chat stepper places each flow step in plan, build, review and merge', () => {
  expect(states(chatStepper('idle'))).toBe(
    'plan:upcoming build:upcoming review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('planning'))).toBe(
    'plan:current build:upcoming review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('planReady'))).toBe(
    'plan:done build:ready(Ready) review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('building'))).toBe(
    'plan:done build:current review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('built'))).toBe(
    'plan:done build:done review:ready(Ready) merge:upcoming',
  )
  expect(states(chatStepper('reviewing'))).toBe(
    'plan:done build:done review:current merge:upcoming',
  )
  expect(states(chatStepper('fixing'))).toBe(
    'plan:done build:done review:current(Fixing) merge:upcoming',
  )
  expect(states(chatStepper('fixed'))).toBe(
    'plan:done build:done review:ready(Re-review) merge:upcoming',
  )
  expect(states(chatStepper('merging'))).toBe('plan:done build:done review:done merge:current')
  expect(states(chatStepper('merged'))).toBe('plan:done build:done review:done merge:done')
})

test('the chat stepper reads the review verdict and drops merge for a run in place', () => {
  expect(states(chatStepper('reviewed'))).toBe(
    'plan:done build:done review:attention(No verdict) merge:upcoming',
  )
  expect(states(chatStepper('reviewed', { issues: 1 }))).toBe(
    'plan:done build:done review:attention(1 issue) merge:upcoming',
  )
  expect(states(chatStepper('reviewed', { issues: 3 }))).toBe(
    'plan:done build:done review:attention(3 issues) merge:upcoming',
  )
  expect(states(chatStepper('reviewed', { issues: 0 }))).toBe(
    'plan:done build:done review:done merge:ready(Ready)',
  )
  expect(states(chatStepper('reviewed', { issues: 0, inPlace: true }))).toBe(
    'plan:done build:done review:done',
  )
  expect(states(chatStepper('merged', { inPlace: true }))).toBe('plan:done build:done review:done')
})

test('the chat stepper halts the stage in progress and falls back to a given note', () => {
  expect(states(chatStepper('building', { halt: 'paused' }))).toBe(
    'plan:done build:stopped(Paused) review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('reviewed', { issues: 2, halt: 'failed' }))).toBe(
    'plan:done build:done review:failed(Failed) merge:upcoming',
  )
  expect(states(chatStepper('merged', { halt: 'stopped' }))).toBe(
    'plan:done build:done review:done merge:done',
  )
  expect(states(chatStepper('building', { note: 'Waiting on builder' }))).toBe(
    'plan:done build:current(Waiting on builder) review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('building', { halt: 'failed', note: 'Builder exited' }))).toBe(
    'plan:done build:failed(Failed · Builder exited) review:upcoming merge:upcoming',
  )
  expect(states(chatStepper('fixing', { note: 'Auto reason' }))).toBe(
    'plan:done build:done review:current(Fixing) merge:upcoming',
  )
})

describe('chatStatus', () => {
  const lead = { step: 'planning' as const, note: 'Drafting', atMs: 100 }
  const simple = (atMs: number) =>
    ({
      startedMs: 0,
      log: [{ kind: 'action', action: 'review', stage: 'review', atMs }],
    }) as unknown as Parameters<typeof chatStatus>[1]['simple']

  test('the lead decides over a leftover reviewer', () => {
    expect(chatStatus('reviewed', { lead, autoRunning: false, simple: simple(50) })).toEqual({
      step: 'planning',
      note: 'Drafting',
    })
  })
  test('Auto and a newer stage launch keep the derived step', () => {
    expect(chatStatus('building', { lead, autoRunning: true, simple: simple(50) }).step).toBe(
      'building',
    )
    expect(chatStatus('reviewing', { lead, autoRunning: false, simple: simple(150) }).step).toBe(
      'reviewing',
    )
  })
  test('a chat without a lead status keeps the derived step', () => {
    expect(chatStatus('built', { autoRunning: false, simple: simple(50) }).step).toBe('built')
  })
  test('every step has its own heading', () => {
    expect(chatStepHeading('built')).toBe('Build')
    expect(chatStepHeading('idle')).not.toBe('Review')
  })
})
