import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn() }))
import { useStore } from '../store'
import * as ipc from './ipc'
import { logLaunch } from './simpleActions'
import type { TerminalSnapshot } from '../types'

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
const run = (generation: number, startedMs: number) =>
  ({ generation, startedMs }) as TerminalSnapshot

test('a launch claims the run the service started since, never the stopped one in the store', async () => {
  useStore.getState().setSession('planner', { generation: 1, running: false, startedMs: 5 })
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue(run(2, 150))
  await logLaunch('p', null, resume, 100, { atRunStart: true })
  expect(log()).toMatchObject([{ sessionId: 'planner', generation: 2, atMs: 150 }])
  expect(ipc.terminalSnapshot).toHaveBeenCalledWith('planner', 0)
})

test('a run the store holds from this launch needs no lookup, nor does a reported one', async () => {
  useStore.getState().setSession('planner', { generation: 3, running: true, startedMs: 120 })
  await logLaunch('p', null, resume, 100)
  await logLaunch('p', null, { ...resume, sessionId: 'reviewer', generation: 7 }, 100)
  expect(log().map((e) => e.generation)).toEqual([3, 7])
  expect(ipc.terminalSnapshot).not.toHaveBeenCalled()
})

test.each([
  ['the service still names the pre-launch run', () => Promise.resolve(run(1, 5))],
  ['the service is unreachable', () => Promise.reject(new Error('Disconnected'))],
])('a launch whose run nobody names claims none when %s', async (_, snapshot) => {
  useStore.getState().setSession('planner', { generation: 1, running: true, startedMs: 5 })
  vi.mocked(ipc.terminalSnapshot).mockImplementation(snapshot)
  await logLaunch('p', null, resume, 100)
  expect(log()).toHaveLength(1)
  expect(log()[0].generation).toBeUndefined()
})
