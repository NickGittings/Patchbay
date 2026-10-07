import { expect, test, vi } from 'vitest'
import type { DeviceManifest, TerminalSpec } from '../types'

const terminal = (id: string, command: string, kind: TerminalSpec['kind']): TerminalSpec => ({
  id,
  name: id,
  command,
  kind,
})
const nodes = [
  { id: 'web', data: { terminals: [terminal('agent-1', ' claude ', 'agent')] } },
  { id: 'api', data: { terminals: [terminal('dev', 'claude', 'task')] } },
]
const addTerminal = vi.fn(() => 'claude-new')
const startTerminal = vi.fn(() => Promise.resolve())
vi.mock('../store', () => ({ useStore: { getState: () => ({ nodes, addTerminal }) } }))
vi.mock('./sessions', () => ({ startTerminal }))
const { agentDevices, startAgentsIn } = await import('./implement')

const claude: DeviceManifest = {
  id: 'claude',
  name: 'Claude',
  category: 'agent',
  command: 'claude',
  kind: 'agent',
  source: 'builtin',
}

test('reuses a matching agent terminal and adds one where missing', async () => {
  await startAgentsIn(['web', 'api', 'gone'], claude, 't1')
  // A task terminal running the same command isn't an agent, so api gets a new one.
  expect(addTerminal).toHaveBeenCalledExactlyOnceWith('api', claude)
  expect(startTerminal.mock.calls).toEqual([
    ['web', 'agent-1', 't1'],
    ['api', 'claude-new', 't1'],
  ])
})

test('only agent presets are offered', () => {
  expect(agentDevices([claude, { ...claude, id: 'dev', kind: 'task' }])).toEqual([claude])
})
