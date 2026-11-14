import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./workspace', () => ({ flushWorkspace: vi.fn(async () => {}) }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn(async () => {}) }))
vi.mock('./planDrafts', () => ({ savePlanDraft: vi.fn(async () => {}), planDrafts: new Map() }))
vi.mock('./chatTeams', async () => {
  const { create } = await import('zustand')
  return { useChatTeams: create(() => ({ teams: {}, runs: {} })) }
})
import { invoke } from '@tauri-apps/api/core'
import { emptyTaskWorkspace, useStore, workspaceOf } from '../store'
import { sessionId, TASK_ROOT_SCOPE } from '../types'
import { emptySimpleUi, simpleKey, useSimpleUi } from './simpleUi'
import { finishTask, refreshTaskCycle, useTaskCycles, type TaskCycleState } from './workCycles'
import { useChatTeams } from './chatTeams'

const receipt = (): TaskCycleState => ({
  cycle: 'second',
  finishing: null,
  history: [
    {
      cycle: '',
      nextCycle: 'second',
      completedMs: 1,
      branch: 'feature',
      firstRequest: 'First request',
      workspace: emptyTaskWorkspace(),
      coordination: { runs: [{ id: 'old-run' }] },
      artifacts: [],
      sessions: [{ id: 'old-agent', name: 'Agent', conversationId: 'provider-id' }],
    },
  ],
})
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState(), true)
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.getState().patchTask('p', null, {
    rootTerminals: [
      { id: 'shell', name: 'Shell', kind: 'shell', command: '' },
      { id: 'agent', name: 'Agent', kind: 'agent', command: 'codex' },
    ],
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'prompt',
          kind: 'prompt',
          stage: 'build',
          atMs: 1,
          text: 'First request',
          mentions: [],
        },
      ],
      selectedAgent: 'old-agent',
      coordinationHandoff: 'old handoff',
    },
    planStory: 'Old story',
    planActive: 'codex',
    auto: null,
  })
  useTaskCycles.setState({ scopes: {} })
  useChatTeams.setState({ teams: {}, runs: {} })
  useSimpleUi.setState({
    worktrees: { [simpleKey('p', null)]: { ...emptySimpleUi(), draft: 'Old draft', mentions: [] } },
  })
})
test('finish deduplicates requests, preserves shell identities and archives before resetting', async () => {
  let resolve!: (value: TaskCycleState) => void
  const response = new Promise<TaskCycleState>((r) => {
    resolve = r
  })
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'task_cycle_finish' ? response : receipt(),
  )
  const shell = sessionId(TASK_ROOT_SCOPE, 'shell', null, 'p')
  const agent = sessionId(TASK_ROOT_SCOPE, 'agent', null, 'p')
  const first = finishTask('p', null)
  expect(finishTask('p', null)).toBe(first)
  expect(useStore.getState().finishingTask).toBe(true)
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'task_cycle_finish',
      expect.objectContaining({
        cycle: '',
        workspace: expect.objectContaining({ planStory: 'Old story' }),
      }),
    ),
  )
  expect(useStore.getState().simple?.log[0].kind).toBe('prompt')
  resolve(receipt())
  await first
  expect(useStore.getState().workCycle).toBe('second')
  expect(useStore.getState().simple).toBeNull()
  expect(useStore.getState().planActive).toBeNull()
  expect(useStore.getState().planStory).toBeNull()
  expect(useStore.getState().rootTerminals.map((t) => t.id)).toEqual(['shell'])
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)].draft).toBe('')
  expect(sessionId(TASK_ROOT_SCOPE, 'shell', null, 'p')).toBe(shell)
  // Re-add the same configured agent; its new cycle must have a fresh identity.
  useStore.getState().patchTask('p', null, {
    rootTerminals: [
      ...useStore.getState().rootTerminals,
      { id: 'agent', name: 'Agent', kind: 'agent', command: 'codex' },
    ],
  })
  expect(sessionId(TASK_ROOT_SCOPE, 'agent', null, 'p')).not.toBe(agent)
  // Pinned in work_cycles::tests::legacy_identity_is_unchanged_and_shells_ignore_the_cycle.
  expect(sessionId(TASK_ROOT_SCOPE, 'agent', null, 'p')).toBe('s-eca87c9e0cd6c3f9cdcd15b5f12de4a4')
})
test('partial cleanup failure keeps chat and retries the same cycle', async () => {
  const pending = { ...receipt(), cycle: '', history: [], finishing: receipt().history[0] }
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'task_cycle_finish') throw new Error('Agent could not be stopped')
    return pending
  })
  await expect(finishTask('p', null)).rejects.toThrow('could not be stopped')
  expect(useStore.getState().simple?.log).toHaveLength(1)
  expect(useStore.getState().workCycle).toBeUndefined()
  expect(useStore.getState().finishingTask).toBe(true)
  vi.mocked(invoke).mockResolvedValue(receipt())
  await finishTask('p', null)
  expect(useStore.getState().workCycle).toBe('second')
})
test('restart receipt resets only its worktree and does not discard new coordination', async () => {
  useStore.setState({
    taskWorkspaces: { other: { ...emptyTaskWorkspace(), planStory: 'Other task' } },
  })
  vi.mocked(invoke).mockResolvedValue(receipt())
  await refreshTaskCycle('p', null)
  expect(workspaceOf(useStore.getState(), 'other').planStory).toBe('Other task')
  useChatTeams.setState({
    runs: {
      p: [
        { id: 'new-run', task: null },
        { id: 'old-run', task: null },
      ] as never[],
    },
  })
  useStore.getState().patchTask('p', null, { simple: { startedMs: 2, log: [] } })
  await refreshTaskCycle('p', null)
  expect(useStore.getState().simple?.startedMs).toBe(2)
  expect(useChatTeams.getState().runs.p.map((r) => r.id)).toEqual(['new-run'])
})

test('a delayed pre-finish receipt cannot restore the old cycle or erase a new task', async () => {
  vi.mocked(invoke).mockResolvedValue(receipt())
  await refreshTaskCycle('p', null)
  useStore.getState().patchTask('p', null, { simple: { startedMs: 20, log: [] } })
  vi.mocked(invoke).mockResolvedValue({ cycle: '', finishing: null, history: [] })
  const current = await refreshTaskCycle('p', null)
  expect(current.cycle).toBe('second')
  expect(useStore.getState().workCycle).toBe('second')
  expect(useStore.getState().simple?.startedMs).toBe(20)
})
