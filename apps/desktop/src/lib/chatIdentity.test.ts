import { expect, test } from 'vitest'
import { COORDINATOR_SCOPE, TASK_ROOT_SCOPE, WORKER_SCOPE, type SessionRecord } from '../types'
import { chatIdentity, namedBuilder } from './chatIdentity'
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
  spec: { command: 'codex', cwd: '/p' },
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
  expect(chatIdentity(record('worker'), [team], [run]).role).toBe('Sub-builder')
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
  ).toBe('Sub-builder')
})

test('agents outside any team take their role from the launch scope', () => {
  const scoped = (componentId: string, kind: 'agent' | 'shell' = 'agent') => ({
    ...record('solo'),
    metadata: { ...record('solo').metadata, componentId, kind },
  })
  expect(chatIdentity(scoped('@task')).roleKey).toBe('builder')
  expect(chatIdentity(scoped(COORDINATOR_SCOPE)).role).toBe('Builder')
  expect(chatIdentity(scoped(WORKER_SCOPE)).role).toBe('Sub-builder')
  expect(chatIdentity(scoped('web')).role).toBe('Builder')
  expect(chatIdentity(scoped('@review')).role).toBe('Reviewer')
  expect(chatIdentity(scoped('@map')).role).toBe('Agent')
  expect(chatIdentity(scoped('@task', 'shell')).role).toBe('Agent')
})

test('tiles use build role names for root Builders, coordinators and Sub-builders', () => {
  const scoped = (componentId: string, branch?: string): SessionRecord => {
    const session = record(componentId)
    return { ...session, metadata: { ...session.metadata, componentId, branch } }
  }
  expect(namedBuilder(scoped(TASK_ROOT_SCOPE), 'builder')).toBe(true)
  expect(namedBuilder(scoped(COORDINATOR_SCOPE), 'builder')).toBe(true)
  expect(namedBuilder(scoped(WORKER_SCOPE), 'subBuilder')).toBe(true)
  expect(namedBuilder(scoped('api'), 'subBuilder')).toBe(true)
  expect(namedBuilder(scoped('api'), 'builder')).toBe(false)
  expect(namedBuilder(scoped(TASK_ROOT_SCOPE, 'feature-x'), 'builder')).toBe(false)
  expect(namedBuilder(scoped(TASK_ROOT_SCOPE), 'agent')).toBe(false)
})

test('a plain chat agent only talks, so it is no Builder', () => {
  const chatAgent = { ...record('solo'), spec: { command: 'codex', cwd: '/p', purpose: 'chat' } }
  expect(chatIdentity(chatAgent as SessionRecord).role).toBe('Agent')
})

test('a component named like an object key is no special scope', () => {
  const odd = {
    ...record('odd'),
    metadata: { ...record('odd').metadata, componentId: 'constructor' },
  }
  expect(chatIdentity(odd).roleKey).toBe('builder')
})
