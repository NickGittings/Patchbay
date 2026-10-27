import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({ sessionsList: vi.fn() }))
import { useStore } from '../store'
import * as ipc from './ipc'
import { logLaunch } from './simpleActions'
import type { SessionRecord } from '../types'

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
})
const log = () => useStore.getState().simple?.log ?? []
const resume = { kind: 'action', action: 'resume', stage: 'plan', sessionId: 'planner' } as const
const record = (generation: number, startedMs: number, requestIds: string[]) =>
  ({
    id: 'planner',
    metadata: { projectId: 'p', componentId: '@plan', terminalId: 'claude' },
    snapshot: { generation, startedMs, running: true },
    requestIds,
  }) as unknown as SessionRecord

test('a launch claims the run its request started, whatever the clocks say', async () => {
  useStore.getState().setSession('planner', { generation: 1, running: false, startedMs: 500 })
  // The service's clock is behind the app's: the run still counts, by its request.
  vi.mocked(ipc.sessionsList).mockResolvedValue([record(2, 5, ['old', 'launch'])])
  await logLaunch('p', null, resume, 'launch', { atRunStart: true })
  expect(log()).toMatchObject([{ sessionId: 'planner', generation: 2, atMs: 5 }])
  // The listed run replaces the stopped one in the store, even without a reconciliation.
  expect(useStore.getState().sessions.planner?.generation).toBe(2)
})

test('a run the store lists for the request needs no lookup, nor does a reported one', async () => {
  useStore.setState({ sessionRecords: [record(3, 120, ['launch'])] })
  await logLaunch('p', null, resume, 'launch')
  await logLaunch('p', null, { ...resume, sessionId: 'reviewer', generation: 7 }, undefined)
  expect(log().map((e) => e.generation)).toEqual([3, 7])
  expect(ipc.sessionsList).not.toHaveBeenCalled()
})

test.each([
  ['a later launch replaced its run', () => Promise.resolve([record(3, 900, ['launch', 'later'])])],
  ['it is still spawning', () => Promise.resolve([record(1, 5, ['old'])])],
  ['the service is unreachable', () => Promise.reject(new Error('Disconnected'))],
])('a launch claims no run when %s', async (_, list) => {
  useStore.getState().setSession('planner', { generation: 1, running: true, startedMs: 5 })
  vi.mocked(ipc.sessionsList).mockImplementation(list)
  await logLaunch('p', null, resume, 'launch')
  expect(log()).toHaveLength(1)
  expect(log()[0].generation).toBeUndefined()
})

test('a launch without a request claims no run', async () => {
  await logLaunch('p', null, resume, undefined)
  expect(log()[0].generation).toBeUndefined()
  expect(ipc.sessionsList).not.toHaveBeenCalled()
})
