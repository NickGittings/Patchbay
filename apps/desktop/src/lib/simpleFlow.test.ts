import { expect, test } from 'vitest'
import { flow, type FlowSnapshot } from './simpleFlow'
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
