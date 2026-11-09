import { expect, test } from 'vitest'
import {
  clearedSimple,
  restoredSimple,
  thread,
  visibleReply,
  type SimpleState,
  type SimpleSnapshot,
} from './simple'
import { flow, type FlowSnapshot } from './simpleFlow'
import {
  MAIN_PLANNING_TASK,
  PROJECT_DRAFT,
  plannerSessionId,
  type SessionRecord,
  type SessionState,
} from '../types'

const worktree = { projectId: 'p', task: 't', path: '/t' }
const planner = (task: string | null, id = 'planner'): SessionRecord =>
  ({
    id,
    metadata: { projectId: 'p', componentId: '@plan', task, kind: 'agent' },
    spec: { cwd: task === 't' ? '/t' : '/p' },
    snapshot: { startedMs: 10, generation: 1 },
    history: [],
  }) as unknown as SessionRecord
const simple = (): SimpleState => ({
  startedMs: 1,
  log: [
    {
      id: 'ask',
      kind: 'prompt',
      stage: 'plan',
      atMs: 10,
      sessionId: 'planner',
      generation: 1,
      text: 'Secret feature request',
      mentions: ['web'],
    },
    {
      id: 'answer',
      kind: 'reply',
      stage: 'plan',
      atMs: 20,
      sessionId: 'planner',
      generation: 1,
      sequence: 1,
      text: 'Secret answer',
    },
  ],
})
const sessions: Record<string, SessionState> = {
  planner: {
    running: true,
    generation: 1,
    startedMs: 10,
    replies: [{ atMs: 20, sequence: 1, text: 'Secret answer', turn: null }],
    status: { agent: { state: 'review', authoritative: true, sinceMs: 30 } },
  } as SessionState,
}
const snapshot = (state: SimpleState): SimpleSnapshot => ({
  simple: state,
  records: [planner('t')],
  sessions,
  auto: null,
  plan: { text: 'Preserved plan', cut: false, savedMs: 25 },
})

test('main, siblings and project drafts have independent planner identities and recipients', () => {
  const records = [
    planner(MAIN_PLANNING_TASK, 'main'),
    planner('t', 'task'),
    planner('sibling', 'sibling'),
    planner(PROJECT_DRAFT, 'draft'),
  ]
  for (const task of [null, 't', 'sibling', PROJECT_DRAFT]) {
    const model = thread({ records, sessions: {}, simple: null, auto: null }, { ...worktree, task })
    expect(model.records.map((r) => r.id)).toEqual([
      task === null ? 'main' : task === 't' ? 'task' : task === PROJECT_DRAFT ? 'draft' : 'sibling',
    ])
  }
  expect(
    new Set(
      [null, 't', 'sibling', PROJECT_DRAFT].map((task) => plannerSessionId('codex', 'p', task)),
    ).size,
  ).toBe(4)
})

test('Clear removes visible text and plan cards while preserving the recipient, planning boundary and Build action', () => {
  const before = snapshot(simple())
  const prior = thread(before, worktree)
  const cleared = clearedSimple(before.simple!, sessions, 40)
  expect(JSON.stringify(cleared)).not.toMatch(/Secret|feature request|answer/)
  expect(cleared.log).toEqual([])
  const restored = restoredSimple(JSON.parse(JSON.stringify(cleared)))!
  const after = { ...before, simple: restored }
  const model = thread(after, worktree)
  expect(model.items).toEqual([])
  expect(model.planningStarted).toBe(prior.planningStarted)
  expect(model.planReady).toBe(true)
  const beforeFlow = flow({ ...before, worktree } as FlowSnapshot)
  const afterFlow = flow({ ...after, worktree } as FlowSnapshot)
  expect(afterFlow).toEqual(beforeFlow)
  expect(afterFlow.prompt?.actions[0].action).toBe('build')
})

test('Clear blocks snapshot replay by timestamp and generation/sequence, and new replies appear normally', () => {
  const cleared = clearedSimple(simple(), sessions, 40)
  expect(visibleReply(cleared, 'planner', 1, { atMs: 50, sequence: 1 })).toBe(false)
  expect(visibleReply(cleared, 'planner', 0, { atMs: 50, sequence: 99 })).toBe(false)
  expect(visibleReply(cleared, 'planner', 1, { atMs: 20, sequence: 2 })).toBe(false)
  expect(visibleReply(cleared, 'planner', 1, { atMs: 50, sequence: 2 })).toBe(true)
  expect(visibleReply(cleared, 'planner', 2, { atMs: 50, sequence: 1 })).toBe(true)
  const state = snapshot(cleared)
  state.sessions = {
    planner: {
      ...sessions.planner,
      replies: [
        ...sessions.planner.replies!,
        { atMs: 50, sequence: 2, text: 'New reply', turn: null },
      ],
    },
  }
  const model = thread(state, worktree)
  expect(model.items.flatMap((i) => (i.kind === 'agent' ? i.entries : []))).toMatchObject([
    { text: 'New reply' },
  ])
})

test('repeated clears retain the original planning boundary and suppress even trimmed old snapshots', () => {
  const first = clearedSimple(simple(), sessions, 40)
  const second = clearedSimple(
    first,
    {
      planner: {
        ...sessions.planner,
        replies: [{ atMs: 50, sequence: 12, text: 'later', turn: null }],
      },
    },
    60,
  )
  const restored = restoredSimple({ ...second, log: simple().log })!
  expect(restored.log).toEqual([])
  expect(thread(snapshot(restored), worktree).planningStarted).toBe(10)
  expect(visibleReply(restored, 'planner', 1, { atMs: 70, sequence: 11 })).toBe(false)
})

test('clearing an active turn preserves its workflow without retaining conversation text', () => {
  const state: FlowSnapshot = {
    ...snapshot(simple()),
    worktree,
    sessions: {
      planner: {
        ...sessions.planner,
        status: {
          agent: { state: 'working', authoritative: true, sinceMs: 30 },
        } as SessionState['status'],
      },
    },
  }
  const expected = flow(state)
  const cleared = clearedSimple(state.simple!, state.sessions, 40)
  expect(flow({ ...state, simple: cleared })).toEqual(expected)
  expect(flow({ ...state, simple: cleared }).step).toBe('planning')
})

test('plan cards split conversation groups at their saved time and stay there after later replies and reload', () => {
  const state = simple()
  state.log.push({
    id: 'later',
    kind: 'reply',
    stage: 'plan',
    atMs: 60,
    sessionId: 'planner',
    generation: 1,
    sequence: 2,
    text: 'Later follow-up',
  })
  const before = thread(snapshot(state), worktree)
  const plan = before.items.find((i) => i.kind === 'plan')!
  expect(plan.atMs).toBe(25)
  expect(before.items.map((i) => i.kind)).toEqual(['line', 'agent', 'plan', 'agent'])
  const restored = thread(snapshot(restoredSimple(JSON.parse(JSON.stringify(state)))!), worktree)
  expect(restored.items).toEqual(before.items)
  const proposal = thread(
    {
      ...snapshot(state),
      proposal: { version: 1, plan: 'Proposal', assignments: [], savedMs: 50 },
    },
    worktree,
  )
  expect(proposal.items.find((i) => i.kind === 'plan')).toMatchObject({
    atMs: 50,
    text: 'Proposal',
  })
})

test('a transferred plan remains buildable when its saved time precedes the new worktree and its history has no prompt', () => {
  const state = snapshot({ startedMs: 0, log: [], transferredFrom: PROJECT_DRAFT })
  state.createdMs = 1000
  expect(thread(state, worktree).planReady).toBe(true)
  const main = thread(
    { ...state, simple: { startedMs: 2000, log: [] } },
    { ...worktree, task: null, path: '/p' },
  )
  expect(main.planReady).toBe(true)
})
