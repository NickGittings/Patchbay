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

test('role follows durable team membership; a preset named after its provider is omitted', () => {
  expect(chatIdentity(record('lead'), [team], [run])).toEqual({
    role: 'Lead',
    roleKey: 'lead',
    detail: 'Codex · Thorough coding',
    title: 'Lead · Codex · Thorough coding',
  })
  expect(
    chatIdentity({ ...record('lead'), metadata: { ...record('lead').metadata, name: 'codex' } }, [
      team,
    ]).title,
  ).toBe('Lead · Codex')
  expect(chatIdentity(record('worker'), [team], [run]).role).toBe('Builder')
  expect(chatIdentity(record('unknown'), [team], [run]).role).toBe('Builder')
  const scoped = (componentId: string) => ({
    ...record('scoped'),
    metadata: { ...record('scoped').metadata, componentId },
  })
  expect(chatIdentity(scoped('@review'), [team], [run]).role).toBe('Reviewer')
  expect(chatIdentity(scoped('@plan')).role).toBe('Planner')
  expect(chatIdentity(scoped('@merge')).title).toBe('Merge agent · Codex · Thorough coding')
  expect(chatIdentity(scoped('@merge')).roleKey).toBe('merge')
  expect(chatIdentity(record('worker'), [team], [{ ...run, chatTeam: 'other' }]).roleKey).toBe(
    'builder',
  )
  expect(
    chatIdentity(record('adopted'), [
      { ...team, scopes: { adopted: { generation: 1, components: [] } } },
    ]).role,
  ).toBe('Builder')
})

test('agents outside any team take their role from the launch scope', () => {
  const scoped = (componentId: string, kind: 'agent' | 'shell' = 'agent') => ({
    ...record('solo'),
    metadata: { ...record('solo').metadata, componentId, kind },
  })
  expect(chatIdentity(scoped('@task')).roleKey).toBe('builder')
  expect(chatIdentity(scoped('web')).role).toBe('Builder')
  expect(chatIdentity(scoped('@review')).role).toBe('Reviewer')
  expect(chatIdentity(scoped('@map')).role).toBe('Agent')
  expect(chatIdentity(scoped('@task', 'shell')).role).toBe('Agent')
})
