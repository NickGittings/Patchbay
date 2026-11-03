import { beforeEach, expect, test, vi } from 'vitest'
import type { PendingStack } from '../types'

const state = vi.hoisted(() => ({
  project: { id: 'p', worktreeSetup: { command: 'old setup' } },
  projects: { p: {} },
  nodes: [{ id: 'api', data: { terminals: [{ id: 'dev', kind: 'task', command: 'npm start' }] } }],
  groups: [] as { id: string; name: string; componentIds: string[] }[],
  dirty: false,
  setMessage: vi.fn(),
  updateTerminal: vi.fn(),
  addTerminal: vi.fn(),
  addGroup: vi.fn(),
  updateGroup: vi.fn(),
}))
const ipc = vi.hoisted(() => ({
  stackProposalClear: vi.fn(async () => true),
  stackProposalRead: vi.fn(async () => null),
}))
vi.mock('../store', () => ({
  useStore: { getState: () => state, setState: (patch: object) => Object.assign(state, patch) },
}))
vi.mock('./ipc', () => ipc)
vi.mock('./dependencies', () => ({ startDetectionAgent: vi.fn() }))
vi.mock('./mapSave', () => ({ mapEditsBlocked: () => false }))
vi.mock('./rail', () => ({ selectPanel: vi.fn() }))

import { applyStackProposal } from './stackAgent'

const proposal = (): PendingStack => ({
  id: 'proposal',
  sessionId: 'agent',
  submittedMs: 1,
  name: 'Local stack',
  orderedStartup: true,
  terminals: [{ component: 'api', terminal: 'dev', readyWhen: '', reason: 'package.json:1' }],
  worktreeSetup: { command: 'npm ci', reason: 'README:1' },
})

beforeEach(() => {
  vi.clearAllMocks()
  state.project = { id: 'p', worktreeSetup: { command: 'old setup' } }
  state.dirty = false
  state.groups = []
})

test('preparation-only application updates the map without creating a stack or running commands', async () => {
  const pending = { ...proposal(), terminals: [] }
  await applyStackProposal(pending, [], 'p', true)
  expect(state.project.worktreeSetup.command).toBe('npm ci')
  expect(state.dirty).toBe(true)
  expect(state.addGroup).not.toHaveBeenCalled()
  expect(state.updateTerminal).not.toHaveBeenCalled()
  expect(ipc.stackProposalClear).toHaveBeenCalledWith('p', pending.id)
})

test('unchecked preparation stays unchanged while selected services apply', async () => {
  const pending = proposal()
  await applyStackProposal(pending, pending.terminals, 'p', false)
  expect(state.project.worktreeSetup.command).toBe('old setup')
  expect(state.updateTerminal).toHaveBeenCalled()
  expect(state.addGroup).toHaveBeenCalledWith('Local stack', ['api'], true)
})

test('preparation and services can apply together', async () => {
  const pending = proposal()
  await applyStackProposal(pending, pending.terminals, 'p', true)
  expect(state.project.worktreeSetup.command).toBe('npm ci')
  expect(state.updateTerminal).toHaveBeenCalled()
  expect(state.addGroup).toHaveBeenCalled()
})

test('older proposals without preparation preserve existing setup', async () => {
  const pending = { ...proposal(), worktreeSetup: undefined }
  await applyStackProposal(pending, pending.terminals, 'p', true)
  expect(state.project.worktreeSetup.command).toBe('old setup')
})

test('an empty selection leaves the proposal for review', async () => {
  await applyStackProposal(proposal(), [], 'p', false)
  expect(state.project.worktreeSetup.command).toBe('old setup')
  expect(ipc.stackProposalClear).not.toHaveBeenCalled()
})
