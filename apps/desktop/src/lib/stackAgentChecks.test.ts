import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { PendingStack } from '../types'
vi.mock('./ipc', () => ({
  stackProposalRead: vi.fn(async () => null),
  stackProposalClear: vi.fn(async () => true),
  onStackProposals: vi.fn(async () => () => {}),
  onAutoSetup: vi.fn(async () => () => {}),
  autoSetupReport: vi.fn(async () => true),
  autoSetupSet: vi.fn(async () => {}),
  enableWorktreeSetup: vi.fn(async () => {}),
  disableWorktreeSetup: vi.fn(async () => {}),
  syncAgentProject: vi.fn(async () => {}),
}))
vi.mock('./sessions', () => ({ launching: () => false }))
vi.mock('./dependencies', () => ({ startDetectionAgent: vi.fn(async () => true) }))
vi.mock('./mapSave', () => ({
  mapEditsBlocked: () => false,
  flushMapSaves: vi.fn(async () => true),
}))
vi.mock('./actions', () => ({ graphActionIn: vi.fn(async () => ({})) }))
vi.mock('./rail', () => ({ selectPanel: vi.fn() }))
const { applyStackProposal, autoApply, startAutoSetup, useStackProposals } =
  await import('./stackAgent')
const { graphActionIn } = await import('./actions')
const ipc = await import('./ipc')
const { startDetectionAgent } = await import('./dependencies')
const { flushMapSaves } = await import('./mapSave')

const pending = (): PendingStack => ({
  id: `submission-${Math.random()}`,
  sessionId: 'agent',
  submittedMs: 1,
  version: 2,
  name: 'Local stack',
  orderedStartup: false,
  terminals: [{ component: 'api', terminal: 'dev', readyWhen: 'Listening', reason: 'x:1' }],
  checks: [
    { component: 'api', path: 'api', name: 'Tests', command: 'npm test', reason: 'package.json:7' },
  ],
  missingChecks: [{ component: 'web', reason: 'no tooling' }],
  worktreeSetup: { command: 'npm ci', reason: 'package-lock.json:1' },
  isolation: {
    parallelSafe: true,
    resources: [{ name: 'Port', kind: 'port', approach: 'PORT=$((3000+N))', evidence: 'x:2' }],
    blockers: [],
  },
  componentIds: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useStackProposals.setState({ pending: {}, busy: {}, applied: {} })
  useStore.getState().loadProject({
    projectId: 'p',
    schemaVersion: 5,
    root: '/p',
    name: 'P',
    links: [],
    components: ['api', 'web'].map((id) => ({
      id,
      name: id.toUpperCase(),
      kind: 'backend' as const,
      notes: '',
      position: { x: 0, y: 0 },
      path: id,
      terminals: [{ id: 'dev', name: 'Dev', kind: 'task' as const, command: 'npm run dev' }],
    })),
  })
})

const terminals = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!.data.terminals

test('applying version 2 writes the stack, checks, preparation and instances in one edit', async () => {
  const p = pending()
  const applied = await applyStackProposal(p, p.terminals, 'p', true)
  expect(applied?.setup).toBe('npm ci')
  expect(terminals('api').map((t) => [t.name, t.action])).toEqual([
    ['Dev', 'development'],
    ['Tests', 'validation'],
  ])
  const s = useStore.getState()
  expect(s.groups).toHaveLength(1)
  expect(s.project?.worktreeSetup?.command).toBe('npm ci')
  expect(s.project?.instances).toMatchObject({ parallelSafe: true, detected: true })
  expect(s.project?.instances?.notes).toContain('Port (port)')
  expect(s.toProject().instances?.parallelSafe).toBe(true)
  expect(s.toProject().schemaVersion).toBe(5)
  expect(graphActionIn).not.toHaveBeenCalled()
  expect(ipc.stackProposalClear).toHaveBeenCalledWith('p', p.id)
})

test('apply and run checks runs only the applied components in the captured worktree', async () => {
  const p = pending()
  await applyStackProposal(p, p.terminals, 'p', false, { checks: p.checks, run: true })
  expect(graphActionIn).toHaveBeenCalledWith(
    'p',
    null,
    expect.objectContaining({ projectId: 'p' }),
    { kind: 'validateSelected', componentIds: ['api'] },
  )
})

test('unticked checks and version 1 proposals leave checks and instances alone', async () => {
  const p = pending()
  await applyStackProposal(p, p.terminals, 'p', false, { checks: [] })
  expect(terminals('api')).toHaveLength(1)
  const v1 = { ...pending(), version: 1, isolation: undefined }
  useStore.setState({ project: { ...useStore.getState().project!, instances: undefined } })
  await applyStackProposal(v1, v1.terminals, 'p')
  expect(terminals('api')).toHaveLength(1)
  expect(useStore.getState().project?.instances).toBeUndefined()
})

test('an automatic setup applies with Undo, enables preparation and reports back', async () => {
  useStore.setState({ sessionRecords: [] })
  await startAutoSetup('p', 'task-1', 'agent')
  expect(startDetectionAgent).toHaveBeenCalledWith(
    'p',
    expect.objectContaining({ kind: 'agent' }),
    expect.objectContaining({ detection: { auto: true } }),
  )
  expect(ipc.autoSetupReport).not.toHaveBeenCalled()
  const p = { ...pending(), auto: true }
  await autoApply('p', p)
  await autoApply('p', p)
  expect(ipc.enableWorktreeSetup).toHaveBeenCalledTimes(1)
  expect(ipc.enableWorktreeSetup).toHaveBeenCalledWith('p', 'npm ci')
  expect(ipc.syncAgentProject).toHaveBeenCalled()
  expect(ipc.autoSetupReport).toHaveBeenLastCalledWith('p', { kind: 'applied', setup: 'npm ci' })
  expect(useStore.getState().message).toContain('Agent in task-1 set up run & test for P')
  const applied = useStackProposals.getState().applied.p
  expect(applied.checkout).toBe('task-1')
  applied.undo.run()
  const s = useStore.getState()
  expect(terminals('api')).toHaveLength(1)
  expect(terminals('api')[0].action).toBeUndefined()
  expect(s.groups).toHaveLength(0)
  expect(s.project?.worktreeSetup).toBeUndefined()
  // Undone, but not offered to agents again.
  expect(s.project?.instances).toEqual({ parallelSafe: false, detected: true })
  expect(ipc.disableWorktreeSetup).toHaveBeenCalledWith('p')
  expect(useStackProposals.getState().applied.p).toBeUndefined()
})

test('an automatic setup for a project in the background waits for review', async () => {
  useStore.setState({ project: { ...useStore.getState().project!, id: 'other' } })
  await autoApply('p', { ...pending(), auto: true })
  expect(ipc.autoSetupReport).toHaveBeenCalledWith('p', {
    kind: 'review',
    reason: 'switch to P in Patchbay to review it',
  })
  expect(ipc.enableWorktreeSetup).not.toHaveBeenCalled()
})

test('a detection already running or waiting for review answers the agent at once', async () => {
  useStackProposals.setState({ pending: { p: pending() } })
  await startAutoSetup('p', null, 'agent')
  expect(ipc.autoSetupReport).toHaveBeenCalledWith('p', expect.objectContaining({ kind: 'review' }))
  expect(startDetectionAgent).not.toHaveBeenCalled()
  useStackProposals.setState({ pending: {} })
  vi.mocked(startDetectionAgent).mockResolvedValueOnce(false)
  await startAutoSetup('p', null, 'agent')
  expect(ipc.autoSetupReport).toHaveBeenLastCalledWith('p', {
    kind: 'failed',
    reason: 'Patchbay could not start run & test detection',
  })
})

test('an automatic apply that cannot be saved is taken back and kept for review', async () => {
  vi.mocked(flushMapSaves).mockResolvedValueOnce(false)
  const p = { ...pending(), auto: true }
  await autoApply('p', p)
  expect(terminals('api')).toHaveLength(1)
  expect(terminals('api')[0].action).toBeUndefined()
  expect(useStore.getState().groups).toHaveLength(0)
  expect(useStore.getState().project?.instances).toBeUndefined()
  expect(ipc.stackProposalClear).not.toHaveBeenCalled()
  expect(ipc.autoSetupReport).toHaveBeenCalledWith('p', expect.objectContaining({ kind: 'review' }))
})

test('undo puts back the preparation command that was enabled before', async () => {
  vi.mocked(ipc.enableWorktreeSetup).mockResolvedValueOnce('make bootstrap')
  await autoApply('p', { ...pending(), auto: true })
  useStackProposals.getState().applied.p.undo.run()
  expect(ipc.enableWorktreeSetup).toHaveBeenLastCalledWith('p', 'make bootstrap')
  expect(ipc.disableWorktreeSetup).not.toHaveBeenCalled()
})
