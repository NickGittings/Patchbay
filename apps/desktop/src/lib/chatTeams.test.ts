import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./ipc', () => ({ sessionsList: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { useStore, workspaceOf } from '../store'
import { useSimpleUi, simpleKey } from './simpleUi'
import { clearSimpleChat } from './simpleActions'
import { restoredSimple } from './simple'
import {
  applyTeamHandoff,
  cacheTeam,
  initializeTeam,
  refreshChatTeams,
  resetLead,
  sendWorkerMessage,
  useChatTeams,
  type ChatTeam,
} from './chatTeams'
import type { SessionRecord } from '../types'
const preset = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  kind: 'agent' as const,
  adapter: 'codex' as const,
}
const team = (patch: Partial<ChatTeam> = {}): ChatTeam => ({
  id: 'team',
  projectId: 'p',
  task: null,
  target: '/p',
  lead: { sessionId: 'lead', generation: 1, conversation: 'conversation', preset },
  state: 'running',
  workers: [preset],
  limit: 2,
  rounds: [],
  checkpoint: {
    goal: 'Goal',
    constraints: 'Keep edits',
    decisions: '',
    remaining: 'Verify',
    validation: 'Pending',
  },
  messages: [],
  reset: null,
  handoff: null,
  error: null,
  ...patch,
})
const record: SessionRecord = {
  id: 'lead',
  metadata: {
    projectId: 'p',
    projectRoot: '/p',
    projectName: 'P',
    componentId: '@task',
    terminalId: 'lead',
    name: 'Codex',
    kind: 'agent',
    adapter: 'codex',
    conversationId: 'conversation',
    command: 'codex',
  },
  spec: { cwd: '/p', command: 'codex' },
  snapshot: null,
  history: [],
  interrupted: false,
}
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.getState().patchTask('p', null, {
    simple: {
      startedMs: 1,
      selectedAgent: 'lead',
      log: [
        {
          id: 'user',
          atMs: 2,
          stage: 'build',
          kind: 'prompt',
          sessionId: 'lead',
          text: 'Retain my changes',
          mentions: [],
        },
      ],
    },
  })
  useSimpleUi.setState({ worktrees: {} })
  useChatTeams.setState({ teams: {}, runs: {} })
})
test('migration keeps the selected lead and visible history and initializes paused', async () => {
  useStore.setState({ sessionRecords: [record] })
  vi.mocked(invoke).mockImplementation(
    async (cmd) => (cmd === 'chat_teams' ? [] : team({ state: 'paused' })) as never,
  )
  await refreshChatTeams('p')
  const initialize = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'chat_team_initialize')
  expect(initialize?.[1]).toMatchObject({
    projectId: 'p',
    seed: { sessionId: 'lead', paused: true, checkpoint: { goal: 'Retain my changes' } },
  })
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useStore.getState().simple?.selectedAgent).toBe('lead')
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'provider_job_start')).toBe(false)
})
test('fresh conversation queues a durable reset and keeps history until confirmation', async () => {
  const reset = team({
    reset: { id: 'reset', nextSession: 'lead', phase: 'queued', clearHistory: true, error: null },
  })
  vi.mocked(invoke).mockResolvedValue(reset)
  await resetLead(team())
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_control',
    expect.objectContaining({
      control: expect.objectContaining({ kind: 'reset', session: 'lead', clearHistory: true }),
    }),
  )
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)].coordinationReset).toBe(true)
})
test('a confirmed replacement clears once, retains a handoff and keeps clear reply boundaries after restore', async () => {
  const confirmed = team({
    lead: { ...team().lead, generation: 2 },
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      text: 'Goal and validation retained',
      clearHistory: true,
    },
  })
  useStore.getState().setSession('lead', {
    generation: 1,
    running: true,
    replies: [{ sequence: 8, atMs: 4, text: 'old reply', turn: null }],
  })
  vi.mocked(invoke).mockResolvedValue(team({ lead: confirmed.lead }))
  await applyTeamHandoff(confirmed)
  const simple = useStore.getState().simple!
  expect(simple.log).toHaveLength(1)
  expect(simple.log[0].text).toContain('Goal and validation retained')
  expect(simple.coordinationHandoff).toBe('reset')
  expect(simple.clearBoundary?.runs).toContainEqual({
    sessionId: 'lead',
    generation: 1,
    sequence: 8,
  })
  useStore.getState().patchTask('p', null, { simple: restoredSimple(simple) })
  await applyTeamHandoff(confirmed)
  expect(useStore.getState().simple?.log).toEqual(simple.log)
})
test('handoffs apply to their own background worktree without clearing another worktree', async () => {
  useStore.getState().patchTask('p', 'worker-task', {
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'background',
          atMs: 2,
          kind: 'prompt',
          stage: 'build',
          text: 'Background goal',
          mentions: [],
        },
      ],
    },
  })
  const main = useStore.getState().simple
  const background = team({
    task: 'worker-task',
    handoff: {
      id: 'reset',
      sessionId: 'other-lead',
      generation: 3,
      text: 'Background handoff',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockResolvedValue({ ...background, handoff: null })
  await applyTeamHandoff(background)
  expect(useStore.getState().simple).toEqual(main)
  expect(workspaceOf(useStore.getState(), 'worker-task').simple?.selectedAgent).toBe('other-lead')
  expect(workspaceOf(useStore.getState(), 'worker-task').simple?.log[0].text).toContain(
    'Background handoff',
  )
})
test('clear visible history leaves coordination, provider and worker state untouched', () => {
  const current = cacheTeam(team())
  expect(clearSimpleChat('p', null)).toBe(true)
  expect(useChatTeams.getState().teams.p).toEqual([current])
  expect(useStore.getState().simple?.selectedAgent).toBe('lead')
  expect(invoke).not.toHaveBeenCalled()
})
test('failed handoff acknowledgement does not clear newly arrived visible history on retry', async () => {
  const confirmed = team({
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      text: 'Retained goal',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue(team())
  await expect(applyTeamHandoff(confirmed)).rejects.toThrow('lost reply')
  const simple = useStore.getState().simple!
  useStore.getState().patchTask('p', null, {
    simple: {
      ...simple,
      log: [
        ...simple.log,
        {
          id: 'new',
          atMs: Date.now() + 1,
          kind: 'prompt',
          stage: 'build',
          text: 'new user message',
          mentions: [],
        },
      ],
    },
  })
  await applyTeamHandoff(confirmed)
  expect(useStore.getState().simple?.log.at(-1)?.text).toBe('new user message')
})
test('side messages address the stored team and assignment and preserve their text', async () => {
  vi.mocked(invoke).mockResolvedValue(team())
  await sendWorkerMessage(team(), 'assignment-a', 'Check this constraint')
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_message',
    expect.objectContaining({
      projectId: 'p',
      id: 'team',
      assignment: 'assignment-a',
      text: 'Check this constraint',
      messageId: expect.any(String),
    }),
  )
})
test('initializing the selected lead uses its authenticated preset rather than injected briefing arguments', async () => {
  vi.mocked(invoke).mockResolvedValue(team())
  await initializeTeam('p', null, {
    ...record,
    spec: { cwd: '/p', command: 'codex --injected-briefing' },
  })
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_initialize',
    expect.objectContaining({
      seed: expect.objectContaining({ preset: expect.objectContaining({ command: 'codex' }) }),
    }),
  )
})

test('a reply from the replacement that arrives before handoff acknowledgement stays visible', async () => {
  const original = useStore.getState().simple!
  useStore.getState().patchTask('p', null, {
    simple: {
      ...original,
      log: [
        ...original.log,
        {
          id: 'new-reply',
          atMs: 110,
          kind: 'reply',
          stage: 'build',
          sessionId: 'lead',
          generation: 2,
          sequence: 1,
          text: 'Fresh conversation reply',
        },
      ],
    },
  })
  useStore.getState().setSession('lead', {
    generation: 2,
    running: true,
    replies: [{ sequence: 1, atMs: 110, text: 'Fresh conversation reply', turn: null }],
  })
  const confirmed = team({
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      startedMs: 100,
      text: 'Retained handoff',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockResolvedValue({ ...confirmed, handoff: null })
  await applyTeamHandoff(confirmed)
  const simple = useStore.getState().simple!
  expect(simple.log.map((entry) => entry.text)).toEqual([
    expect.stringContaining('Retained handoff'),
    'Fresh conversation reply',
  ])
  expect(simple.clearBoundary?.runs.some((r) => r.sessionId === 'lead' && r.generation === 2)).toBe(
    false,
  )
})

test('a side-message RPC with an uncertain reply retries the same durable identity', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue(team())
  await expect(
    sendWorkerMessage(team(), 'unique-retry-worker', 'Keep this message once'),
  ).rejects.toThrow('reply lost')
  await sendWorkerMessage(team(), 'unique-retry-worker', 'Keep this message once')
  const messages = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'chat_team_message')
  expect(messages[0][1]).toEqual(messages[1][1])
})
