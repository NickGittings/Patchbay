import { expect, test } from 'vitest'
import type { FlowNode } from '../store'
import { MERGE_SCOPE, REVIEW_SCOPE, TASK_ROOT_SCOPE, type TerminalSpec } from '../types'
import { retainedTerminal, taskTerminals, tileLabel } from './taskTerminals'

const agent: TerminalSpec = { id: 'agent', name: 'Claude', command: 'claude', kind: 'agent' }
const shell: TerminalSpec = { id: 'shell', name: 'Shell', command: 'zsh', kind: 'shell' }
const nodes = [{ id: 'api', data: { name: 'API', terminals: [agent] } }] as unknown as FlowNode[]
const metadata = (componentId: string, branch?: string) => ({
  metadata: {
    projectId: 'p',
    projectRoot: '/p',
    projectName: 'P',
    componentId,
    terminalId: agent.id,
    name: agent.name,
    kind: agent.kind,
    adapter: null,
    branch,
    conversationId: null,
  },
})
const retained = (componentId: string, terminal = agent) =>
  retainedTerminal('sid', { componentId, terminal }, nodes)
const root = (terminal: TerminalSpec) =>
  taskTerminals({ rootTerminals: [terminal], componentTerminals: [] }, nodes, {}, 'p', null)[0]

test('a terminal on the map leads with its component', () => {
  expect(tileLabel(retained('api'), metadata('api'))).toBe('API')
})

test('a root agent leads with its role, before and after it has a record', () => {
  expect(tileLabel(root(agent))).toBe('Build')
  expect(tileLabel(root(agent), metadata(TASK_ROOT_SCOPE))).toBe('Build')
})

test('a root agent with a reviewed branch is labeled Fix', () => {
  expect(tileLabel(root(agent), metadata(TASK_ROOT_SCOPE, 'feature-x'))).toBe('Fix')
})

test.each([
  [REVIEW_SCOPE, 'Review'],
  [MERGE_SCOPE, 'Merge'],
  ['deleted-component', 'Build'],
])('a retained %s agent is labeled %s', (scope, role) => {
  expect(tileLabel(retained(scope))).toBe(role)
})

test('terminals that are not agents get no role label', () => {
  expect(tileLabel(root(shell))).toBeUndefined()
  expect(tileLabel(retained(REVIEW_SCOPE, shell))).toBeUndefined()
})
