import { expect, test } from 'vitest'
import type { SessionRecord } from '../types'
import { chatIdentity } from './chatIdentity'
import type { ChatTeam } from './chatTeams'
import type { ProviderRun } from './orchestration'

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
