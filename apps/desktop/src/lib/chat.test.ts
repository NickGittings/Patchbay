import { expect, test } from 'vitest'
import { chatAutoActive, chatBusy, chatHandoff, chatRecipient } from './chat'
import { boundedSimple, clearedSimple, restoredSimple, type SimpleState } from './simple'
import type { SessionRecord, SessionState } from '../types'

const record = (id: string) => ({ id, metadata: { kind: 'agent' } }) as SessionRecord

test('chat keeps the explicitly selected agent when another agent asks or workflow changes', () => {
  const records = [record('builder'), record('reviewer')]
  expect(chatRecipient(records, 'builder')?.id).toBe('builder')
  expect(chatRecipient(records, 'missing')).toBeUndefined()
  expect(chatRecipient(records)).toBeUndefined()
  expect(chatRecipient([record('reviewer')], 'builder')).toBeUndefined()
})

test('agent selection survives persistence, bounding, and clearing history', () => {
  const state: SimpleState = { startedMs: 1, log: [], selectedAgent: 'builder' }
  expect(restoredSimple(boundedSimple(state))?.selectedAgent).toBe('builder')
  expect(clearedSimple(state, {}, 10).selectedAgent).toBe('builder')
  expect(restoredSimple({ ...state, selectedAgent: 123 })?.selectedAgent).toBeUndefined()
  expect(restoredSimple({ startedMs: 1, log: [] })?.selectedAgent).toBeUndefined()
})

test('handoff contains workspace and recent discussion and is bounded', () => {
  const simple: SimpleState = {
    startedMs: 1,
    log: [
      { kind: 'prompt', id: 'p', atMs: 1, stage: 'build', text: 'Fix the parser', mentions: [] },
      {
        kind: 'reply',
        id: 'r',
        atMs: 2,
        stage: 'build',
        sessionId: 's',
        generation: 1,
        sequence: 1,
        text: 'Tests pass',
      },
    ],
  }
  const handoff = chatHandoff(simple, 'feature/parser', ['src/parser.rs'])
  expect(handoff).toContain('feature/parser')
  expect(handoff).toContain('src/parser.rs')
  expect(handoff).toContain('User: Fix the parser')
  expect(handoff).toContain('Agent: Tests pass')
  expect(
    chatHandoff({ ...simple, log: [{ ...simple.log[0], text: 'x'.repeat(30000) }] }, 'main', [])
      .length,
  ).toBeLessThan(16500)
})

test('auto controls manual chat until paused and handoff waits for a settled turn', () => {
  expect(chatAutoActive('running')).toBe(true)
  expect(chatAutoActive('waitingOnYou')).toBe(true)
  expect(chatAutoActive('paused')).toBe(false)
  expect(chatAutoActive('done')).toBe(false)
  expect(chatBusy({ running: true } as SessionState)).toBe(true)
  expect(
    chatBusy({
      running: true,
      status: { agent: { authoritative: true, state: 'idle' } },
    } as SessionState),
  ).toBe(false)
})

test('selecting an agent in a background workspace does not redirect the active chat', async () => {
  const { useStore, projectStateOf, workspaceOf } = await import('../store')
  const { selectChatAgent } = await import('./agentChats')
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  selectChatAgent('p', null, 'root-agent')
  selectChatAgent('p', 'task', 'task-agent')
  expect(useStore.getState().simple?.selectedAgent).toBe('root-agent')
  expect(workspaceOf(projectStateOf('p')!, 'task').simple?.selectedAgent).toBe('task-agent')
})

test('input remains mounted while typing invalidates hooks, but closes on confirmed work or restart', async () => {
  const { chatInputRequests } = await import('./chat')
  const records = [record('s')]
  const waiting = {
    running: true,
    generation: 1,
    status: { agent: { state: 'needsInput', authoritative: true, sinceMs: 10 } },
  } as SessionState
  const requests = chatInputRequests(records, { s: waiting })
  expect(requests).toEqual([{ sessionId: 's', generation: 1, sinceMs: 10 }])
  const typing = {
    ...waiting,
    status: {
      ...waiting.status!,
      agent: { ...waiting.status!.agent!, state: 'working' as const, authoritative: false },
    },
  }
  expect(chatInputRequests(records, { s: typing }, requests)).toEqual(requests)
  expect(chatInputRequests(records, { s: { ...typing, generation: 2 } }, requests)).toEqual([])
  expect(
    chatInputRequests(
      records,
      {
        s: {
          ...typing,
          status: { ...typing.status, agent: { ...typing.status.agent, authoritative: true } },
        },
      },
      requests,
    ),
  ).toEqual([])
})
