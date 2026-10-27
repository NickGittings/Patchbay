import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./ipc', () => ({ terminalSnapshot: vi.fn() }))
import { useStore } from '../store'
import * as ipc from './ipc'
import { logSimple } from './simpleActions'
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
const actions = () => useStore.getState().simple?.log ?? []

test('a session entry without its run claims the run the service names, not the stale store one', async () => {
  useStore.getState().setSession('planner', { generation: 1, running: false, startedMs: 5 })
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue({
    generation: 2,
    startedMs: 50,
  } as TerminalSnapshot)
  await logSimple(
    'p',
    null,
    { kind: 'action', action: 'pauseAuto', stage: 'plan', sessionId: 'planner' },
    { atRunStart: true },
  )
  expect(actions()).toMatchObject([{ sessionId: 'planner', generation: 2, atMs: 50 }])
  expect(ipc.terminalSnapshot).toHaveBeenCalledWith('planner', 0)
})

test('a known run is logged at once without a lookup, and an unreachable service falls back', async () => {
  void logSimple('p', null, {
    kind: 'action',
    action: 'review',
    stage: 'review',
    sessionId: 'reviewer',
    generation: 4,
  })
  expect(actions()).toMatchObject([{ generation: 4 }])
  void logSimple('p', null, { kind: 'action', action: 'resumeAuto', stage: 'build' })
  expect(actions()).toHaveLength(2)
  expect(ipc.terminalSnapshot).not.toHaveBeenCalled()
  useStore.getState().setSession('builder', { generation: 3, running: true })
  vi.mocked(ipc.terminalSnapshot).mockRejectedValue(new Error('Disconnected'))
  await logSimple('p', null, {
    kind: 'action',
    action: 'implement',
    stage: 'build',
    sessionId: 'builder',
  })
  expect(actions().at(-1)).toMatchObject({ sessionId: 'builder', generation: 3 })
})
