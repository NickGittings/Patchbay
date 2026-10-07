import { expect, test } from 'vitest'
import type { DeviceManifest } from '../types'
import { agentDevices, nearbyIds, plannerDevice, planTerminals } from './plan'

const device = (id: string, kind: DeviceManifest['kind']): DeviceManifest => ({
  id,
  name: id,
  category: 'agents',
  command: id,
  kind,
  source: 'builtin',
})

test('planner terminals come from agent devices, else Claude', () => {
  expect(planTerminals([device('codex', 'agent'), device('dev', 'task')])).toEqual([
    { id: 'codex', name: 'codex', command: 'codex', adapter: undefined, kind: 'agent' },
  ])
  expect(planTerminals([]).map((t) => t.id)).toEqual(['claude'])
})

test('agent presets are offered, else the built-in Claude', () => {
  const codex = device('codex', 'agent')
  expect(agentDevices([codex, device('dev', 'task')])).toEqual([codex])
  expect(agentDevices([]).map((d) => d.id)).toEqual(['claude'])
})

test('the planner device is the preset behind the planner terminal, else Claude', () => {
  const codex = device('codex', 'agent')
  expect(plannerDevice([device('dev', 'task'), codex], 'codex')).toBe(codex)
  expect(plannerDevice([], 'claude')).toMatchObject({ id: 'claude', command: 'claude' })
})

test('nearby components are direct neighbours outside the highlight', () => {
  const edges = [
    { source: 'web', target: 'api' },
    { source: 'api', target: 'db' },
    { source: 'admin', target: 'web' },
    { source: 'other', target: 'lib' },
  ]
  expect([...nearbyIds(['web'], edges)].sort()).toEqual(['admin', 'api'])
  expect([...nearbyIds(['web', 'api'], edges)].sort()).toEqual(['admin', 'db'])
  expect(nearbyIds([], edges).size).toBe(0)
})

test('nearbyIds reuses its result for the same inputs', () => {
  const highlighted = ['web']
  const edges = [{ source: 'web', target: 'api' }]
  expect(nearbyIds(highlighted, edges)).toBe(nearbyIds(highlighted, edges))
})
