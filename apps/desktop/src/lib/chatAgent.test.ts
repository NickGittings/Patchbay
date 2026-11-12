import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./sessions', () => ({ startTerminal: vi.fn(), reconcileFreshSessions: vi.fn() }))
vi.mock('./chatTeams', () => ({ initializeTeam: vi.fn(), newLead: vi.fn(), teamFor: vi.fn() }))
import { useStore } from '../store'
import { useSimpleUi, simpleKey } from './simpleUi'
import { startTerminal, reconcileFreshSessions } from './sessions'
import { initializeTeam, newLead, teamFor } from './chatTeams'
import { defaultChatPreset, startChatAgent, switchChatAgent } from './chatAgent'
import { sessionId, TASK_ROOT_SCOPE, type DeviceManifest, type SessionRecord } from '../types'
const agents: DeviceManifest[] = ['claude', 'codex'].map((id) => ({
  id,
  name: id,
  command: id,
  kind: 'agent',
  category: 'agent',
  source: 'builtin',
}))
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useSimpleUi.setState({ worktrees: {} })
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.setState({ devices: agents, workspaceSettings: { chatAgent: 'codex' } })
})
test('chat default overrides workflow roles and missing explicit presets require replacement', () => {
  expect(defaultChatPreset(agents, { implement: ['claude'] }, 'codex')?.id).toBe('codex')
  expect(defaultChatPreset(agents, { implement: ['codex'] }, undefined)?.id).toBe('codex')
  expect(defaultChatPreset(agents, {}, undefined)?.id).toBe('claude')
  expect(defaultChatPreset(agents, {}, 'removed')).toBeUndefined()
})
test('startup is lazy and concurrent calls share one session without consuming the draft', async () => {
  const key = simpleKey('p', null)
  useSimpleUi.getState().patch(key, { draft: 'Build this', chatPreset: 'claude' })
  expect(startTerminal).not.toHaveBeenCalled()
  vi.mocked(startTerminal).mockImplementation(async (_component, terminalId) => {
    const id = sessionId(TASK_ROOT_SCOPE, terminalId, null, 'p')
    useStore.setState({
      sessionRecords: [
        {
          id,
          metadata: { name: 'claude', kind: 'agent', terminalId, componentId: TASK_ROOT_SCOPE },
          spec: { command: 'claude', cwd: '/p' },
          history: [],
        } as unknown as SessionRecord,
      ],
      sessions: { [id]: { running: true, generation: 1 } },
    })
    return id
  })
  const first = startChatAgent('p', null)
  const second = startChatAgent('p', null)
  expect(second).toBe(first)
  const record = await first
  expect(startTerminal).toHaveBeenCalledTimes(1)
  expect(reconcileFreshSessions).toHaveBeenCalledTimes(1)
  expect(initializeTeam).toHaveBeenCalledWith('p', null, record)
  expect(useStore.getState().simple?.selectedAgent).toBe(record.id)
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('Build this')
})
test('failed startup retains draft and allows retry', async () => {
  const key = simpleKey('p', null)
  useSimpleUi.getState().patch(key, { draft: 'Keep me' })
  await expect(startChatAgent('p', null)).rejects.toThrow('did not start')
  await expect(startChatAgent('p', null)).rejects.toThrow('did not start')
  expect(startTerminal).toHaveBeenCalledTimes(2)
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('Keep me')
})
test('switching uses a new preset conversation through the context handoff', async () => {
  const team = { id: 'team', projectId: 'p', task: null } as NonNullable<ReturnType<typeof teamFor>>
  vi.mocked(teamFor).mockReturnValue(team)
  await switchChatAgent('p', null, 'claude')
  expect(newLead).toHaveBeenCalledWith(team, expect.objectContaining({ command: 'claude' }))
  await expect(switchChatAgent('p', null, 'arbitrary-session')).rejects.toThrow(
    'no longer available',
  )
  expect(newLead).toHaveBeenCalledTimes(1)
})
