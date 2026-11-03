import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { taskWorkspace, useStore } from '../store'
import type { AutoRun } from '../types'
import { reconcileFreshSessions } from './sessions'
import { restoredAuto } from './autoRestore'
import {
  controlProviderRun,
  createProviderRun,
  driveProviderRuns,
  readyJobs,
  type ProviderJob,
  type ProviderRun,
} from './orchestration'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./sessions', () => ({ listenForTerminals: vi.fn(), reconcileFreshSessions: vi.fn() }))
const job = (id: string, patch: Partial<ProviderJob> = {}): ProviderJob => ({
  id,
  preset: 'claude',
  terminal: { id: 'claude', name: 'Claude', command: 'claude', kind: 'agent' },
  state: 'pending',
  requestId: `${id}-request`,
  sessionId: null,
  error: null,
  report: null,
  instructions: `Implement ${id}`,
  components: [],
  dependencies: [],
  task: null,
  base: null,
  commit: null,
  summary: null,
  integratedHead: null,
  ...patch,
})
const run = (patch: Partial<ProviderRun> = {}): ProviderRun => ({
  id: 'run',
  projectId: 'p',
  task: null,
  kind: 'implementation',
  state: 'running',
  goal: 'Goal',
  components: [],
  target: '/p',
  branch: 'feature',
  sourceRevision: 'rev',
  integratedHead: 'head',
  jobs: [],
  coordinator: null,
  workers: [],
  sealed: false,
  acceptedPartial: false,
  error: null,
  ...patch,
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(reconcileFreshSessions).mockResolvedValue(undefined)
  useStore.setState(useStore.getInitialState())
})
function setup() {
  useStore.setState({
    project: { id: 'p', name: 'P', root: '/p' },
    activeProjectId: 'p',
    projectOrder: ['p'],
  })
  return useStore.getState().toProject()
}
test('independent workers start together and dependents wait for integration rather than submission', () => {
  const a = job('a', { state: 'complete' })
  const b = job('b', { dependencies: ['a'] })
  const c = job('c')
  expect(readyJobs(run({ jobs: [a, b, c] })).map((j) => j.id)).toEqual(['c'])
  expect(readyJobs(run({ jobs: [{ ...a, state: 'integrated' }, b, c] })).map((j) => j.id)).toEqual([
    'b',
    'c',
  ])
  expect(readyJobs(run({ state: 'paused', jobs: [c] }))).toEqual([])
  expect(readyJobs(run({ state: 'stopped', jobs: [c] }))).toEqual([])
})
test('a partial scan launch failure preserves the successful launch and does not relaunch a reconciled session', async () => {
  setup()
  let current = run({ kind: 'scan', jobs: [job('a'), job('b')] })
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'provider_runs') return [current] as never
    if (command === 'provider_job_start') {
      const id = (args as { job: string }).job
      current = {
        ...current,
        jobs: current.jobs.map((j) =>
          j.id === id ? { ...j, state: 'running', sessionId: id } : j,
        ),
      }
      if (id === 'b') throw new Error('Reply lost after spawn')
      return current as never
    }
    throw new Error(String(command))
  })
  await driveProviderRuns('p')
  await driveProviderRuns('p')
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'provider_job_start')).toHaveLength(
    2,
  )
  expect(current.jobs.every((j) => j.state === 'running')).toBe(true)
})
test.each(['scan', 'implementation'] as const)(
  '%s jobs respect the owning Auto run background permission across worktrees and project tabs',
  async (kind) => {
    setup()
    const current = run({ kind, jobs: [job('a')] })
    const auto: AutoRun = {
      runId: 'auto',
      status: 'running',
      stage: kind === 'scan' ? 'scan' : 'implement',
      goal: 'Goal',
      effort: 'standard',
      device: 'claude',
      merge: { mode: 'ask', destinationBranch: 'main' },
      round: 0,
      log: [],
      background: false,
      ...(kind === 'scan' ? { scanRound: current.id } : { implementationRun: current.id }),
    }
    useStore.setState({ auto })
    vi.mocked(invoke).mockResolvedValue([current])
    const starts = () =>
      vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'provider_job_start')
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(1)

    // Selecting another worktree saves the owner outside the active workspace.
    useStore.setState({
      activeTask: 'other',
      auto: null,
      taskWorkspaces: { '': taskWorkspace(useStore.getState()) },
    })
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(1)
    useStore.getState().patchTask('p', null, { auto: { ...auto, background: true } })
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(2)

    useStore.getState().loadProject({
      projectId: 'q',
      root: '/q',
      name: 'Q',
      schemaVersion: 4,
      components: [],
      links: [],
    })
    useStore.getState().patchTask('p', null, { auto })
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(2)
    useStore.getState().patchTask('p', null, { auto: { ...auto, background: true } })
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(3)
    useStore.getState().patchTask('p', null, {
      auto: { ...auto, background: true, status: 'paused' },
    })
    await driveProviderRuns('p')
    expect(starts()).toHaveLength(3)
  },
)
test('Stop is routed through the backend so launch ownership and late replies are reconciled together', async () => {
  vi.mocked(invoke).mockResolvedValue(run({ state: 'stopped' }))
  await controlProviderRun('p', 'run', { kind: 'stop' })
  expect(invoke).toHaveBeenCalledWith('provider_run_control', {
    projectId: 'p',
    id: 'run',
    control: { kind: 'stop' },
  })
})
test('round creation has a stable client identity and preserves all selected providers', async () => {
  const project = setup()
  vi.mocked(invoke).mockResolvedValue(run({ kind: 'scan' }))
  await createProviderRun(
    project,
    'scan',
    'Goal',
    ['web'],
    null,
    ['claude', 'codex'].map((id) => ({
      id,
      name: id,
      command: id,
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
    })),
    undefined,
    'stable-id',
  )
  expect(invoke).toHaveBeenCalledWith(
    'provider_run_create',
    expect.objectContaining({
      draft: expect.objectContaining({
        id: 'stable-id',
        components: ['web'],
        presets: [
          expect.objectContaining({ id: 'claude' }),
          expect.objectContaining({ id: 'codex' }),
        ],
      }),
    }),
  )
})
test('unfinished multi-provider runs restore paused with their rounds and assignments attached', () => {
  const saved = {
    runId: 'auto',
    status: 'running',
    stage: 'scan',
    goal: 'Goal',
    effort: 'standard',
    merge: { mode: 'ask', destinationBranch: 'main' },
    device: 'claude',
    round: 0,
    log: [],
    scanners: ['claude', 'codex', 'claude'],
    workers: ['codex', 'claude'],
    scanRound: 'scan-id',
    implementationRun: 'build-id',
    plannerTurn: true,
  }
  expect(restoredAuto(saved)).toMatchObject({
    status: 'paused',
    stage: 'scan',
    scanRound: 'scan-id',
    implementationRun: 'build-id',
    scanners: ['claude', 'codex'],
    workers: ['codex', 'claude'],
    plannerTurn: true,
  })
})
