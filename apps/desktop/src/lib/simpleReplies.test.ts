import { beforeEach, expect, test } from 'vitest'
import { useStore } from '../store'
import { hydrateReplies, persistReplies, repliesKey } from './simpleReplies'
import { revealTerminal } from './attention'
import { inputDrawer, simpleKey, useSimpleUi } from './simpleUi'
import { ownsPlanner, thread } from './simple'
import { sessionMetadata, type Reply, type SessionRecord, type Task } from '../types'
const reply = (sequence: number): Reply => ({
  sequence,
  atMs: 100 + sequence,
  turn: 'turn',
  text: `Reply ${sequence}`,
})
const record = (scope = '@task'): SessionRecord =>
  ({
    id: 's',
    metadata: { projectId: 'p', componentId: scope, kind: 'agent', task: 't' },
    spec: { cwd: '/t' },
    snapshot: null,
    history: [],
  }) as unknown as SessionRecord
beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.setState({ tasks: [{ id: 't', title: 'Task', worktree: '/t', createdMs: 1 } as Task] })
  sessionMetadata.clear()
  useSimpleUi.setState({ worktrees: {} })
})
test('live and snapshot reply races merge by sequence within one generation only', () => {
  expect(
    hydrateReplies({ generation: 1, running: true, replies: [reply(2)] }, 1, [reply(1), reply(2)]),
  ).toEqual([reply(1), reply(2)])
  expect(
    hydrateReplies({ generation: 1, running: true, replies: [reply(2)] }, 2, [reply(1)]),
  ).toEqual([reply(1)])
  expect(
    hydrateReplies({ generation: 2, running: true, replies: [reply(2)] }, 1, [reply(1)]),
  ).toEqual([reply(2)])
  expect(
    hydrateReplies(
      undefined,
      1,
      Array.from({ length: 25 }, (_, i) => reply(i + 1)),
    ),
  ).toHaveLength(20)
})
test('ingestion persists an inactive worktree, deduplicates, and keeps old generations', () => {
  const r = record()
  useStore.getState().patchTask('p', 't', { simple: { startedMs: 1, log: [] } })
  useStore.setState({ sessionRecords: [r] })
  sessionMetadata.set('s', { ...r.metadata, task: r.metadata.task ?? null })
  persistReplies('s', 1, [reply(1)])
  persistReplies('s', 1, [reply(1)])
  persistReplies('s', 2, [reply(1)])
  expect(useStore.getState().taskWorkspaces.t.simple?.log.map((e) => e.generation)).toEqual([1, 2])
  expect(useStore.getState().simple).toBeNull()
})

test('a late snapshot preserves earlier replies after a newer live reply', () => {
  const r = record()
  useStore.getState().patchTask('p', 't', { simple: { startedMs: 1, log: [] } })
  persistReplies('s', 1, [reply(3)], r)
  persistReplies('s', 1, [reply(1), reply(2), reply(3)], r)
  persistReplies('s', 1, [reply(2)], r)
  const simple = useStore.getState().taskWorkspaces.t.simple!
  expect(simple.log.map((e) => e.kind === 'reply' && e.sequence)).toEqual([1, 2, 3])
  const model = thread(
    {
      records: [r],
      simple: { ...simple, log: simple.log.slice(-1) },
      auto: null,
      sessions: { s: { generation: 1, running: true, replies: [reply(1), reply(2), reply(3)] } },
    },
    { projectId: 'p', task: 't', path: '/t' },
  )
  expect(
    model.items.flatMap((i) =>
      i.kind === 'agent' ? i.entries.map((e) => e.kind === 'reply' && e.sequence) : [],
    ),
  ).toEqual([1, 2, 3])
})

test.each([undefined, 1, 2])(
  'planner ownership agrees for persistence, inline replies and View (claim generation %s)',
  (generation) => {
    const r = record('@plan')
    const simple = {
      startedMs: 1,
      log: [
        {
          kind: 'prompt' as const,
          id: 'claim',
          stage: 'plan' as const,
          atMs: 10,
          sessionId: 's',
          generation,
          text: 'Plan',
          mentions: [],
        },
      ],
    }
    // A claim without a generation names no run, so it never owns the planner's later ones.
    const owned = generation === 1
    const sessions = { s: { generation: 1, running: true, replies: [reply(1)] } }
    useStore.setState({ simpleMode: true, sessionRecords: [r], sessions })
    useStore.getState().patchTask('p', 't', { simple })
    expect(ownsPlanner(simple, 's', 1)).toBe(owned)
    const model = thread(
      { records: [r], sessions, simple, auto: null },
      { projectId: 'p', task: 't', path: '/t' },
    )
    expect(model.foreign.has('s')).toBe(!owned)
    expect(
      model.items.some((i) => i.kind === 'agent' && i.entries.some((e) => e.kind === 'reply')),
    ).toBe(owned)
    persistReplies('s', 1, [reply(1)], r)
    expect(useStore.getState().taskWorkspaces.t.simple!.log.some((e) => e.kind === 'reply')).toBe(
      owned,
    )
    revealTerminal({ sid: 's', componentId: '@plan' })
    expect(useStore.getState().activeTask).toBe(owned ? 't' : null)
  },
)

test('a reply alone never claims a shared planner run', () => {
  expect(
    ownsPlanner(
      {
        startedMs: 1,
        log: [
          { ...reply(1), kind: 'reply', id: 'r', stage: 'plan', sessionId: 's', generation: 1 },
        ],
      },
      's',
      1,
    ),
  ).toBe(false)
})

test('merge replies matched by branch persist and restore in their source chat', async () => {
  const { restoredSimple } = await import('./simple')
  const r = {
    ...record('@merge'),
    metadata: { ...record('@merge').metadata, branch: 'feature' },
    spec: { cwd: '/destination', command: 'cat' },
  }
  useStore.setState({ tasks: [{ ...useStore.getState().tasks[0], branch: 'feature' }] })
  useStore.getState().patchTask('p', 't', { simple: { startedMs: 1, log: [] } })
  persistReplies('s', 1, [reply(1)], r)
  const restored = restoredSimple(
    JSON.parse(JSON.stringify(useStore.getState().taskWorkspaces.t.simple)),
  )!
  expect(restored.log).toHaveLength(1)
  expect(restored.log[0]).toMatchObject({ kind: 'reply', stage: 'merge', text: 'Reply 1' })
  expect(useStore.getState().simple).toBeNull()
})
test('shared planner replies persist only in chats that used that generation', () => {
  const r = record('@plan')
  useStore.getState().patchTask('p', null, {
    simple: {
      startedMs: 1,
      log: [
        {
          kind: 'prompt',
          id: 'p',
          atMs: 10,
          stage: 'plan',
          sessionId: 's',
          generation: 1,
          text: 'Plan',
          mentions: [],
        },
      ],
    },
  })
  useStore.getState().patchTask('p', 't', { simple: { startedMs: 1, log: [] } })
  persistReplies('s', 1, [reply(1)], r)
  expect(useStore.getState().simple?.log.at(-1)?.kind).toBe('reply')
  expect(useStore.getState().taskWorkspaces.t.simple?.log).toEqual([])
})
test('notification View selects the task and latest chat block without leaving Chat', () => {
  const r = record()
  useStore.setState({ sessionRecords: [r], simpleMode: true, view: 'review' })
  revealTerminal({ sid: r.id, componentId: '@task' })
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    view: 'review',
    activeTask: 't',
    activeSession: 's',
    revealed: { sid: 's', componentId: '@task' },
  })
})

test('a reply arriving before its planner claim is persisted once the prompt is logged', () => {
  const r = record('@plan')
  useStore.getState().patchTask('p', null, { simple: { startedMs: 1, log: [] } })
  persistReplies('s', 1, [reply(1)], r)
  const claim = {
    id: 'claim',
    kind: 'prompt' as const,
    stage: 'plan' as const,
    atMs: 100,
    sessionId: 's',
    generation: 1,
    text: 'Plan',
    mentions: [],
  }
  for (const task of [null, 't']) {
    useStore.getState().patchTask('p', task, { simple: { startedMs: 1, log: [claim] } })
    persistReplies('s', 1, [reply(1)], r)
    persistReplies('s', 1, [reply(1)], r)
  }
  expect(useStore.getState().simple?.log.filter((e) => e.kind === 'reply')).toHaveLength(1)
  expect(
    useStore.getState().taskWorkspaces.t.simple?.log.filter((e) => e.kind === 'reply'),
  ).toHaveLength(1)
})

test.each([0, 1])('View pins an unclaimed exited planner (exit %i) in Chat', async (exitCode) => {
  const { plannerSessionId } = await import('../types')
  const sid = plannerSessionId('claude', 'p')
  const r = { ...record('@plan'), id: sid }
  useStore.setState({
    sessionRecords: [r],
    sessions: { [sid]: { generation: 1, running: false, exitCode } },
    simpleMode: true,
    view: 'navigation',
    revealed: { sid: 'old', componentId: '@task' },
  })
  revealTerminal({ sid, componentId: '@plan' })
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    view: 'navigation',
    activeSession: sid,
    revealed: null,
  })
  const ui = useSimpleUi.getState().worktrees[simpleKey('p', null)]
  expect(ui).toMatchObject({
    terminal: 'user',
    terminalSession: { id: sid, generation: 1, pinned: true },
  })
  expect(inputDrawer(ui, undefined, useStore.getState().sessions, [r])).toBe(ui)
  expect(useStore.getState().simple).toBeNull()
})

test('View keeps a planner run used here in its chat', async () => {
  const { plannerSessionId } = await import('../types')
  const sid = plannerSessionId('claude', 'p')
  const r = { ...record('@plan'), id: sid }
  useStore.setState({
    sessionRecords: [r],
    sessions: { [sid]: { generation: 2, running: true } },
    simpleMode: true,
  })
  useStore.getState().patchTask('p', null, {
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'claim',
          kind: 'prompt',
          stage: 'plan',
          atMs: 100,
          sessionId: sid,
          generation: 2,
          text: 'Plan',
          mentions: [],
        },
      ],
    },
  })
  revealTerminal({ sid, componentId: '@plan' })
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    activeSession: sid,
    revealed: { sid, componentId: '@plan' },
  })
})

test('reply text stays bounded across ingestion and restoring old layouts', async () => {
  const { boundedSimpleLog, restoredSimple, SIMPLE_REPLY_LIMIT, SIMPLE_REPLY_BUDGET } =
    await import('./simple')
  const { logSimple } = await import('./simpleActions')
  const prompt = {
    id: 'claim',
    kind: 'prompt' as const,
    stage: 'build' as const,
    atMs: 100,
    sessionId: 's',
    generation: 1,
    text: 'Keep my prompt',
    mentions: [],
  }
  logSimple('p', null, prompt)
  for (let i = 0; i < 30; i++)
    logSimple('p', null, {
      kind: 'reply',
      stage: 'build',
      sessionId: 's',
      generation: 1,
      sequence: i + 1,
      text: 'x'.repeat(SIMPLE_REPLY_LIMIT * 2),
      atMs: 100 + i,
    })
  const log = useStore.getState().simple!.log
  expect(log[0]).toEqual(prompt)
  const replies = log.filter((e) => e.kind === 'reply')
  expect(replies.at(-1)?.sequence).toBe(30)
  expect(replies.every((e) => e.text.length <= SIMPLE_REPLY_LIMIT)).toBe(true)
  expect(replies.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(SIMPLE_REPLY_BUDGET)
  const legacy = replies.map((e) => ({ ...e, text: 'x'.repeat(SIMPLE_REPLY_LIMIT * 2) }))
  expect(restoredSimple({ startedMs: 1, log: [prompt, ...legacy] })?.log).toEqual(
    boundedSimpleLog([prompt, ...legacy]),
  )
})

test('evicted replies stay evicted across repeated restarts, including fully evicted runs', async () => {
  const { logSimple } = await import('./simpleActions')
  const { restoredSimple, thread, SIMPLE_REPLY_LIMIT } = await import('./simple')
  const r = record()
  useStore.setState({ activeTask: 't', simple: { startedMs: 1, log: [] }, sessionRecords: [r] })
  const old = { ...r, id: 'old' }
  logSimple('p', 't', {
    kind: 'reply',
    stage: 'build',
    sessionId: 'old',
    generation: 1,
    sequence: 1,
    text: 'old reply',
    atMs: 2,
  })
  const incoming = Array.from({ length: 20 }, (_, i) => ({
    ...reply(i + 1),
    text: 'x'.repeat(SIMPLE_REPLY_LIMIT),
  }))
  persistReplies('s', 1, incoming, r)
  const saved = useStore.getState().simple!
  expect(saved).not.toHaveProperty('replySequences')
  expect(saved.log).toHaveLength(8)
  for (let i = 0; i < 3; i++) {
    const restored = restoredSimple(JSON.parse(JSON.stringify(useStore.getState().simple)))!
    useStore.setState({ simple: restored })
    const model = thread(
      {
        records: [old, r],
        simple: restored,
        auto: null,
        sessions: {
          old: { running: false, generation: 1, replies: [{ ...reply(1), atMs: 2 }] },
          s: { running: true, generation: 1, replies: incoming },
        },
      },
      { projectId: 'p', task: 't', path: '/t' },
    )
    expect(model.items.flatMap((item) => (item.kind === 'agent' ? item.entries : []))).toEqual(
      saved.log,
    )
    persistReplies('old', 1, [{ ...reply(1), atMs: 2 }], old)
    persistReplies('s', 1, incoming, r)
    expect(useStore.getState().simple).toEqual(saved)
  }
  persistReplies('s', 1, [{ ...reply(21), text: 'new' }], r)
  expect(useStore.getState().simple!.log.at(-1)).toMatchObject({ sequence: 21, text: 'new' })
})

test('restoring legacy cursors retains late replies and removes cursor state', async () => {
  const { restoredSimple } = await import('./simple')
  const simple = restoredSimple({ startedMs: 1, log: [], replySequences: { '["s",1]': 3 } })!
  expect(simple).toEqual({ startedMs: 1, log: [] })
  useStore.setState({ activeTask: 't', simple })
  persistReplies('s', 1, [reply(1)], record())
  expect(useStore.getState().simple!.log).toHaveLength(1)
})

test('View finds the chat that used the current planner generation', () => {
  const r = record('@plan')
  const claim = {
    id: 'claim',
    kind: 'prompt' as const,
    stage: 'plan' as const,
    sessionId: 's',
    generation: 2,
    atMs: 10,
    text: 'Plan',
    mentions: [],
  }
  useStore.setState({
    sessionRecords: [r],
    sessions: { s: { generation: 2, running: true } },
    simpleMode: true,
    simple: { startedMs: 1, log: [{ ...claim, generation: 1 }] },
  })
  useStore.getState().patchTask('p', 't', { simple: { startedMs: 1, log: [claim] } })
  revealTerminal({ sid: 's', componentId: '@plan' })
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    activeTask: 't',
    activeSession: 's',
  })
})

test('View selects a merge source even when its destination task is listed first', () => {
  const r = { ...record('@merge'), spec: { cwd: '/dest', merge_source: '/t', command: 'cat' } }
  const destination = { id: 'dest', worktree: '/dest' } as Task
  useStore.setState({
    sessionRecords: [r],
    simpleMode: true,
    tasks: [destination, ...useStore.getState().tasks],
  })
  revealTerminal({ sid: 's', componentId: '@merge' })
  expect(useStore.getState()).toMatchObject({
    simpleMode: true,
    activeTask: 't',
    activeSession: 's',
  })
})

test('the persistence key changes only with the replies or the chats receiving them', () => {
  const r = record('@plan')
  useStore.getState().patchTask('p', null, { simple: { startedMs: 1, log: [] } })
  const key = repliesKey('s', 1, [reply(1)], r)
  persistReplies('s', 1, [reply(1)], r)
  expect(repliesKey('s', 1, [reply(1)], r)).toBe(key)
  useStore.getState().patchTask('p', null, {
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'claim',
          kind: 'prompt',
          stage: 'plan',
          atMs: 10,
          sessionId: 's',
          generation: 1,
          text: 'Plan',
          mentions: [],
        },
      ],
    },
  })
  const claimed = repliesKey('s', 1, [reply(1)], r)
  expect(claimed).not.toBe(key)
  persistReplies('s', 1, [reply(1)], r)
  // The persisted reply changes the chat's log, not what the key names.
  expect(repliesKey('s', 1, [reply(1)], r)).toBe(claimed)
  expect(repliesKey('s', 1, [reply(1), reply(2)], r)).not.toBe(claimed)
  expect(repliesKey('s', 2, [reply(1)], r)).not.toBe(claimed)
})
