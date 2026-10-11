import { expect, test, vi } from 'vitest'
import type { DeviceManifest, TerminalSpec } from '../types'

const terminal = (id: string, command: string, kind: TerminalSpec['kind']): TerminalSpec => ({
  id,
  name: id,
  command,
  kind,
})
const rootTerminals = [terminal('root-agent', 'claude', 'agent')]
const apiTerminals = [terminal('api-test', 'npm test', 'task')]
const nodes = [{ id: 'api', data: { name: 'API', terminals: apiTerminals } }]
const addRootTerminal = vi.fn(() => 'root-new')
const addTerminal = vi.fn((_c: string, d: DeviceManifest | null) => {
  const t = terminal(`api-${d?.id ?? 'custom'}`, d?.command ?? '', d?.kind ?? 'task')
  apiTerminals.push(t)
  return t.id
})
const addTaskComponentTerminal = vi.fn()
const setMaximizedTerminal = vi.fn()
const setActiveSession = vi.fn()
const startTerminal = vi.fn(() => Promise.resolve())
vi.mock('../store', () => ({
  useStore: {
    getState: () => ({
      rootTerminals,
      nodes,
      addRootTerminal,
      addTerminal,
      addTaskComponentTerminal,
      activeTask: 't1',
      setMaximizedTerminal,
      setActiveSession,
    }),
  },
}))
vi.mock('./sessions', () => ({ startTerminal }))
const { addTaskTerminal, startTaskAgent } = await import('./implement')

const claude: DeviceManifest = {
  id: 'claude',
  name: 'Claude',
  category: 'agent',
  command: 'claude',
  kind: 'agent',
  source: 'builtin',
}

test('task implementation defaults to one root agent and reuses its configured provider', async () => {
  await startTaskAgent(claude)
  expect(addRootTerminal).not.toHaveBeenCalled()
  expect(startTerminal.mock.calls).toEqual([['@task', 'root-agent', 't1']])
  startTerminal.mockClear()
  const codex = { ...claude, id: 'codex', command: 'codex', adapter: 'codex' as const }
  await startTaskAgent(codex)
  expect(addRootTerminal).toHaveBeenCalledWith(codex)
  expect(startTerminal.mock.calls).toEqual([['@task', 'root-new', 't1']])
})

test('starting an existing root agent focuses it', async () => {
  await startTaskAgent(claude)
  expect(setActiveSession.mock.lastCall?.[0]).toBeTruthy()
  expect(setMaximizedTerminal).toHaveBeenLastCalledWith(null)
})

const dev: DeviceManifest = {
  id: 'dev',
  name: 'Dev',
  category: 'terminal',
  command: 'npm run dev',
  kind: 'task',
  source: 'builtin',
}

test('a root agent from Add terminal starts like Start agent did', async () => {
  startTerminal.mockClear()
  await addTaskTerminal('@task', { kind: 'device', device: claude })
  expect(startTerminal.mock.calls).toEqual([['@task', 'root-agent', 't1']])
})

test('a component preset is saved once, joins the task stopped, and is reused', async () => {
  startTerminal.mockClear()
  await addTaskTerminal('api', { kind: 'device', device: dev })
  await addTaskTerminal('api', { kind: 'device', device: dev })
  expect(addTerminal).toHaveBeenCalledTimes(1)
  expect(addTaskComponentTerminal.mock.calls).toEqual([
    ['api', 'api-dev'],
    ['api', 'api-dev'],
  ])
  expect(startTerminal).not.toHaveBeenCalled()
})

test('a saved component terminal joins the task without touching the map', async () => {
  addTerminal.mockClear()
  addTaskComponentTerminal.mockClear()
  await addTaskTerminal('api', { kind: 'saved', terminalId: 'api-test' })
  expect(addTerminal).not.toHaveBeenCalled()
  expect(addTaskComponentTerminal).toHaveBeenCalledWith('api', 'api-test')
})

test('a component agent is saved on the component and starts there', async () => {
  startTerminal.mockClear()
  addTaskComponentTerminal.mockClear()
  await addTaskTerminal('api', { kind: 'device', device: claude })
  expect(addTaskComponentTerminal).toHaveBeenCalledWith('api', 'api-claude')
  expect(startTerminal.mock.calls).toEqual([['api', 'api-claude', 't1']])
})
