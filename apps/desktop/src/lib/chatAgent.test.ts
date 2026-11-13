import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./sessions', () => ({ startTerminal: vi.fn(), reconcileFreshSessions: vi.fn() }))
vi.mock('./chatTeams', () => ({ initializeTeam: vi.fn(), newLead: vi.fn(), teamFor: vi.fn() }))
vi.mock('./terminals', () => ({ hasVisibleTerminal: () => false }))
vi.mock('./ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ipc')>()),
  terminalAttach: vi.fn(),
  terminalDetach: vi.fn(),
  terminalPrompt: vi.fn(),
}))
import { useStore, workspaceOf } from '../store'
import { useSimpleUi, simpleKey } from './simpleUi'
import { startTerminal, reconcileFreshSessions } from './sessions'
import { initializeTeam, newLead, teamFor } from './chatTeams'
import { defaultChatPreset, startChatAgent, switchChatAgent } from './chatAgent'
import { sendToSession, waitForPrompt } from './simpleComposer'
import { terminalPrompt } from './ipc'
import {
  sessionId,
  TASK_ROOT_SCOPE,
  type DeviceManifest,
  type SessionRecord,
  type SessionState,
} from '../types'
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
function mockAgentStartup() {
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
      sessions: {
        [id]: {
          running: true,
          generation: 1,
          status: {
            agent: { state: 'idle', authoritative: true, provider: 'codex', sinceMs: 1 },
          } as SessionState['status'],
        },
      },
    })
    return id
  })
}
test('startup is lazy and concurrent calls share one session without consuming the draft', async () => {
  const key = simpleKey('p', null)
  useSimpleUi.getState().patch(key, { draft: 'Build this', chatPreset: 'claude' })
  expect(startTerminal).not.toHaveBeenCalled()
  mockAgentStartup()
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
  const roots = useStore.getState().rootTerminals
  vi.mocked(newLead).mockImplementation(async (_team, terminal) => {
    expect(useStore.getState().rootTerminals).toContainEqual(terminal)
    return team
  })
  await switchChatAgent('p', null, 'claude')
  expect(useStore.getState().rootTerminals).toHaveLength(roots.length + 1)
  expect(newLead).toHaveBeenCalledWith(team, expect.objectContaining({ command: 'claude' }))
  await expect(switchChatAgent('p', null, 'arbitrary-session')).rejects.toThrow(
    'no longer available',
  )
  expect(newLead).toHaveBeenCalledTimes(1)
})

test('a team with a forgotten lead requires continuation before launching another session', async () => {
  const team = { id: 'team', projectId: 'p', task: null } as NonNullable<ReturnType<typeof teamFor>>
  vi.mocked(teamFor).mockReturnValue(team)
  useSimpleUi.getState().patch(simpleKey('p', null), { draft: 'Keep my request' })
  await expect(startChatAgent('p', null)).rejects.toThrow('Reconnect the existing lead')
  expect(startTerminal).not.toHaveBeenCalled()
  expect(initializeTeam).not.toHaveBeenCalled()
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)].draft).toBe('Keep my request')
  await switchChatAgent('p', null, 'claude')
  expect(newLead).toHaveBeenCalledWith(team, expect.objectContaining({ command: 'claude' }))
})

test('switching registers its terminal in the owning background worktree', async () => {
  const team = { id: 'team', projectId: 'p', task: 'feature' } as NonNullable<
    ReturnType<typeof teamFor>
  >
  vi.mocked(teamFor).mockReturnValue(team)
  const roots = useStore.getState().rootTerminals
  await switchChatAgent('p', 'feature', 'codex')
  const terminal = vi.mocked(newLead).mock.calls[0][1]
  expect(workspaceOf(useStore.getState(), 'feature').rootTerminals).toContainEqual(terminal)
  expect(useStore.getState().rootTerminals).toBe(roots)
})

test('coordination failure still delivers the first message to the running agent', async () => {
  mockAgentStartup()
  vi.mocked(initializeTeam).mockRejectedValue(new Error('Not a Git repository'))
  const record = await startChatAgent('p', null)
  const context = { projectId: 'p', task: null, recipient: record.id, generation: 1 }
  await waitForPrompt(context, {
    current: () => context,
    session: () => useStore.getState().sessions[record.id],
  })
  await sendToSession({
    projectId: 'p',
    task: null,
    sid: record.id,
    generation: 1,
    text: 'Build this on the first send',
    mentions: [],
    stage: 'build',
  })
  expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(
    record.id,
    1,
    'Build this on the first send',
    false,
  )
  expect(useStore.getState().simple?.selectedAgent).toBe(record.id)
  expect(useStore.getState().simple?.log).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining('Continuing locally') }),
  )
  expect(useStore.getState().simple?.log.at(-1)).toMatchObject({
    kind: 'prompt',
    text: 'Build this on the first send',
  })
})
