import { beforeEach, expect, test, vi } from 'vitest'
import type { ComponentGroup, PendingStack, TerminalSpec } from '../types'

const state = vi.hoisted(() => ({
  project: { id: 'p', worktreeSetup: { command: 'old setup' } },
  projects: { p: {} },
  nodes: [] as { id: string; data: { name: string; terminals: TerminalSpec[] } }[],
  groups: [] as ComponentGroup[],
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

import { applyStackProposal, discardStackProposal, startStackAgent } from './stackAgent'

import { startDetectionAgent } from './dependencies'

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
  state.nodes = [
    {
      id: 'api',
      data: {
        name: 'API',
        terminals: [{ id: 'dev', name: 'Dev', kind: 'task', command: 'npm start' }],
      },
    },
  ]
  state.updateTerminal.mockImplementation((component, id, patch) => {
    const current = state.nodes
      .find((n) => n.id === component)
      ?.data.terminals.find((t) => t.id === id)
    if (current) Object.assign(current, patch)
  })
  state.updateGroup.mockImplementation((id, patch) => {
    const group = state.groups.find((g) => g.id === id)
    if (group) Object.assign(group, patch)
  })
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

const group = (id: string, name = 'Local stack'): ComponentGroup => ({
  id,
  name,
  componentIds: ['api', 'web'],
  orderedStartup: false,
  readinessTimeoutSeconds: 60,
})

function existingStack() {
  state.groups = [group('target', 'Renamed'), group('unrelated')]
  state.nodes[0].data.terminals[0].action = 'development'
  state.nodes[0].data.terminals[0].readyWhen = 'old ready'
  state.nodes[0].data.terminals.push(
    { id: 'obsolete', name: 'Obsolete', kind: 'task', command: 'old', action: 'development' },
    { id: 'shell', name: 'Shell', kind: 'shell', command: '' },
    { id: 'agent', name: 'Agent', kind: 'agent', command: 'agent' },
    { id: 'check', name: 'Check', kind: 'task', command: 'npm test', action: 'validation' },
  )
  state.nodes.push(
    {
      id: 'web',
      data: {
        name: 'Web',
        terminals: [
          { id: 'dev', name: 'Dev', kind: 'task', command: 'web', action: 'development' },
        ],
      },
    },
    {
      id: 'other',
      data: {
        name: 'Other',
        terminals: [
          { id: 'dev', name: 'Dev', kind: 'task', command: 'other', action: 'development' },
        ],
      },
    },
  )
}

test('redetection replaces by id, corrects commands and readiness, removes obsolete startup and keeps definitions', async () => {
  existingStack()
  const untouched = structuredClone(state.nodes[0].data.terminals.slice(2))
  const pending = {
    ...proposal(),
    stackId: 'target',
    terminals: [
      {
        component: 'api',
        terminal: 'dev',
        command: 'npm ci && npm run build && npm start',
        readyWhen: '',
        reason: 'README:1',
      },
    ],
  }
  await applyStackProposal(pending, pending.terminals, 'p')
  expect(state.groups[0]).toEqual({
    ...group('target'),
    componentIds: ['api'],
    orderedStartup: true,
  })
  expect(state.groups[1]).toEqual(group('unrelated'))
  expect(state.nodes[0].data.terminals[0]).toMatchObject({
    id: 'dev',
    command: pending.terminals[0].command,
    readyWhen: '',
    action: 'development',
  })
  expect(state.nodes[0].data.terminals[1]).toMatchObject({
    id: 'obsolete',
    command: 'old',
    action: undefined,
  })
  expect(state.nodes[1].data.terminals[0].action).toBeUndefined()
  expect(state.nodes[2].data.terminals[0].action).toBe('development')
  expect(state.nodes[0].data.terminals.slice(2)).toEqual(untouched)
  expect(state.addTerminal).not.toHaveBeenCalled()
  expect(state.addGroup).not.toHaveBeenCalled()
  await applyStackProposal(pending, pending.terminals, 'p')
  expect(state.nodes[0].data.terminals).toHaveLength(5)
  expect(state.addTerminal).not.toHaveBeenCalled()
})

test('discarding a replacement leaves all configuration intact', async () => {
  existingStack()
  const before = structuredClone({
    nodes: state.nodes,
    groups: state.groups,
    project: state.project,
  })
  await discardStackProposal('p', 'cancelled')
  expect({ nodes: state.nodes, groups: state.groups, project: state.project }).toEqual(before)
  expect(state.updateTerminal).not.toHaveBeenCalled()
})

test('a missing target or stale terminal prevents replacement before any edits', async () => {
  existingStack()
  for (const pending of [
    { ...proposal(), stackId: 'missing' },
    {
      ...proposal(),
      stackId: 'target',
      terminals: [{ component: 'api', terminal: 'check', readyWhen: '', reason: 'x' }],
    },
  ]) {
    await applyStackProposal(pending, pending.terminals, 'p', true)
    expect(state.updateTerminal).not.toHaveBeenCalled()
    expect(state.updateGroup).not.toHaveBeenCalled()
    expect(state.project.worktreeSetup.command).toBe('old setup')
    expect(ipc.stackProposalClear).not.toHaveBeenCalled()
  }
})

test('a replacement may remove every member', async () => {
  existingStack()
  const pending = { ...proposal(), stackId: 'target', terminals: [] }
  await applyStackProposal(pending, [], 'p')
  expect(state.groups[0].componentIds).toEqual([])
  expect(
    state.nodes.flatMap((n) => n.data.terminals).filter((t) => t.action === 'development'),
  ).toHaveLength(1)
})

test('Detect again carries the stable stack id into detection', async () => {
  const preset: TerminalSpec = { id: 'agent', name: 'Agent', kind: 'agent', command: 'agent' }
  await startStackAgent('p', preset, 'target')
  expect(startDetectionAgent).toHaveBeenCalledWith(
    'p',
    preset,
    expect.objectContaining({ stackId: 'target' }),
  )
})

test('a proposed new terminal that now matches a name updates that definition', async () => {
  const pending = {
    ...proposal(),
    terminals: [
      { component: 'api', name: ' DEV ', command: 'npm run dev', readyWhen: 'ready', reason: 'x' },
    ],
  }
  await applyStackProposal(pending, pending.terminals, 'p')
  expect(state.updateTerminal).toHaveBeenCalledWith('api', 'dev', {
    action: 'development',
    command: 'npm run dev',
    readyWhen: 'ready',
  })
  expect(state.addTerminal).not.toHaveBeenCalled()
})
