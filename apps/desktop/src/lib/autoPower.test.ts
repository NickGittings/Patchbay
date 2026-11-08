import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AutoRun } from '../types'
import { emptyTaskWorkspace, useStore } from '../store'
import { followAutoPower, needsAutoPower, setAutoKeepAwake, useAutoPower } from './autoPower'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
const run = (patch: Partial<AutoRun> = {}) => ({ status: 'running', ...patch }) as AutoRun
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback(),
    },
  })
  useStore.setState({
    restoring: false,
    serviceConnected: true,
    workspaceSettings: {},
    project: { id: 'p', name: 'P', root: '/p' },
    projectOrder: ['p'],
    activeTask: null,
    projects: {},
    auto: run(),
    taskWorkspaces: {},
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('only eligible running work and explicit scheduled pauses need power', () => {
  expect(needsAutoPower(run(), true)).toBe(true)
  expect(needsAutoPower(run(), false)).toBe(false)
  for (const status of ['waitingOnYou', 'done', 'failed', 'stopped', 'paused'] as const)
    expect(needsAutoPower(run({ status }), true)).toBe(false)
  for (const pauseKind of ['scheduled', 'usage'] as const)
    expect(
      needsAutoPower(
        run({ status: 'paused', pauseKind, resumeTrigger: { kind: 'time', atMs: 100 } }),
        true,
      ),
    ).toBe(true)
  expect(
    needsAutoPower(
      run({ status: 'paused', pauseKind: 'user', resumeTrigger: { kind: 'time', atMs: 100 } }),
      true,
    ),
  ).toBe(false)
})

test('defaults off, follows service changes, and releases on cleanup', async () => {
  const stop = followAutoPower()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: false,
    needed: true,
  })
  setAutoKeepAwake(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: true,
  })
  useStore.setState({ serviceConnected: false })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: false,
  })
  stop()
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: false,
    needed: false,
  })
})

test('scheduled wait stays inhibited across resume and cancellation releases demand', async () => {
  setAutoKeepAwake(true)
  useStore.setState({
    auto: run({
      status: 'paused',
      pauseKind: 'scheduled',
      resumeTrigger: { kind: 'time', atMs: 1000 },
    }),
  })
  const stop = followAutoPower()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: true,
  })
  useStore.setState({ auto: run() })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: true,
  })
  useStore.setState({ auto: run({ status: 'paused', pauseKind: 'scheduled' }) })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: false,
  })
  stop()
})

test('background permission and other runs keep one demand until the last run ends', async () => {
  setAutoKeepAwake(true)
  useStore.setState({
    auto: run({ status: 'paused' }),
    taskWorkspaces: {
      t: { ...emptyTaskWorkspace(), auto: run({ background: false }) },
    } as ReturnType<typeof useStore.getState>['taskWorkspaces'],
  })
  const stop = followAutoPower()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: false,
  })
  useStore.setState({
    taskWorkspaces: {
      t: { ...emptyTaskWorkspace(), auto: run({ background: true }) },
    } as ReturnType<typeof useStore.getState>['taskWorkspaces'],
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: true,
  })
  useStore.setState({ auto: run(), taskWorkspaces: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: true,
  })
  useStore.setState({ restoring: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: true,
    needed: false,
  })
  stop()
})

test('unavailable background execution does not request sleep prevention', async () => {
  vi.stubGlobal('navigator', {})
  setAutoKeepAwake(true)
  const stop = followAutoPower()
  await vi.advanceTimersByTimeAsync(0)
  expect(invoke).toHaveBeenLastCalledWith('set_auto_keep_awake_demand', {
    enabled: false,
    needed: true,
  })
  expect(useAutoPower.getState().status).toBe('unavailable')
  stop()
})
