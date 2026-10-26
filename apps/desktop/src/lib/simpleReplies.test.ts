import { beforeEach, expect, test } from 'vitest'
import { useStore } from '../store'
import { hydrateReplies, persistReplies } from './simpleReplies'
import { revealTerminal } from './attention'
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
