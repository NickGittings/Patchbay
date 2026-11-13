import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import type { SessionRecord } from '../types'
import { useStore } from '../store'
import { chatIdentity } from './chatIdentity'
import { useChatTeams, type ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'
import { simpleKey, useSimpleUi } from './simpleUi'
import SimpleComposer from '../components/SimpleComposer'
import SimpleAgent from '../components/SimpleAgent'

vi.mock('./windows', () => ({ showsSession: vi.fn(), openComponentWindow: vi.fn() }))
vi.mock('./clock', () => ({ useClockNow: () => 0 }))
// SSR must sample the configured stores, rather than Zustand's initial hydration snapshot.
vi.mock('../store', async (original) => {
  const actual = await original<typeof import('../store')>()
  return {
    ...actual,
    useStore: Object.assign(
      (select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) =>
        select(actual.useStore.getState()),
      actual.useStore,
    ),
  }
})
vi.mock('./chatTeams', async (original) => {
  const actual = await original<typeof import('./chatTeams')>()
  return {
    ...actual,
    useChatTeams: Object.assign(
      (select: (s: ReturnType<typeof actual.useChatTeams.getState>) => unknown) =>
        select(actual.useChatTeams.getState()),
      actual.useChatTeams,
    ),
  }
})
vi.mock('./simpleUi', async (original) => {
  const actual = await original<typeof import('./simpleUi')>()
  return {
    ...actual,
    useSimpleUi: Object.assign(
      (select: (s: ReturnType<typeof actual.useSimpleUi.getState>) => unknown) =>
        select(actual.useSimpleUi.getState()),
      actual.useSimpleUi,
    ),
  }
})

vi.mock('./ipc', async (original) => ({
  ...(await original<typeof import('./ipc')>()),
  terminalAttach: vi.fn(),
  terminalDetach: vi.fn(),
  terminalPrompt: vi.fn(),
}))

const record = (id: string): SessionRecord => ({
  id,
  metadata: {
    projectId: 'p',
    projectRoot: '/p',
    projectName: 'P',
    task: null,
    componentId: '@task',
    terminalId: id,
    kind: 'agent',
    name: 'Thorough coding',
    adapter: 'codex',
    conversationId: null,
  },
  spec: { command: 'codex', cwd: '/p', purpose: 'chat' },
  snapshot: null,
  history: [],
  interrupted: false,
})
const team = {
  id: 'team',
  projectId: 'p',
  task: null,
  lead: { sessionId: 'lead' },
  scopes: {},
} as ChatTeam
const run = { chatTeam: 'team', jobs: [{ sessionId: 'worker' }] } as ProviderRun

beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useSimpleUi.setState({ worktrees: {} })
  useChatTeams.setState({ teams: { p: [team] }, runs: { p: [run] } })
})

test('role follows durable team membership; provider and preset remain separate', () => {
  expect(chatIdentity(record('lead'), [team], [run])).toEqual({
    role: 'Lead',
    provider: 'Codex',
    preset: 'Thorough coding',
    label: 'Lead · Codex',
  })
  expect(chatIdentity(record('worker'), [team], [run]).role).toBe('Builder')
  expect(chatIdentity(record('unknown'), [team], [run]).role).toBe('Agent')
  expect(chatIdentity(record('worker'), [team], [{ ...run, chatTeam: 'other' }]).role).toBe('Agent')
  expect(
    chatIdentity(record('adopted'), [
      { ...team, scopes: { adopted: { generation: 1, components: [] } } },
    ]).role,
  ).toBe('Builder')
})

test('viewing a Builder terminal keeps the composer addressed to the Lead', () => {
  const lead = record('lead'),
    worker = record('worker')
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.setState({
    serviceConnected: true,
    simple: { startedMs: 1, log: [], selectedAgent: 'lead' },
    sessionRecords: [lead, worker],
    sessions: { lead: { generation: 1, running: true, chatStartup: 'pending' } },
  })
  const scopeKey = simpleKey('p', null)
  useSimpleUi
    .getState()
    .patch(scopeKey, { terminal: 'user', terminalSession: { id: 'worker', pinned: true } })
  const html = renderToStaticMarkup(
    createElement(SimpleComposer, {
      scopeKey,
      stage: 'build',
      records: [lead, worker],
      terminalRecord: worker,
      openTerminal: () => {},
    }),
  )
  expect(html).toContain('Talking to Lead · Codex')
  expect(html).toContain('Preset: Thorough coding')
  expect(html).toContain('Starting Lead · Codex…')
  expect(html).toContain('Hide Builder terminal')
  expect(html).not.toContain('Talking to Builder')
  const header = renderToStaticMarkup(
    createElement(SimpleAgent, {
      record: lead,
      sessionId: 'lead',
      entries: [],
      latest: false,
      working: false,
      openFile: () => {},
    }),
  )
  expect(header).toContain('Lead · Codex')
  expect(header).toContain('View Lead terminal')
})
