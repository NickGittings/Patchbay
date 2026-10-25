import { expect, test } from 'vitest'
import type { DeviceManifest } from '../types'
import { chatRolePresets, restoredAgentRoles, roleDevice, roleDevices } from './agentRoles'

const device = (id: string, kind: DeviceManifest['kind'] = 'agent'): DeviceManifest => ({
  id,
  name: id,
  category: 'agents',
  command: id,
  kind,
  source: 'builtin',
})
const claude = device('claude')
const codex = device('codex')
const devices = [claude, codex, device('dev', 'task')]

test('a role launches its assigned preset while it is installed', () => {
  expect(roleDevice(devices, { implement: ['codex'] }, 'implement')).toBe(codex)
  expect(roleDevice(devices, { implement: ['gone', 'codex'] }, 'implement')).toBe(codex)
})

test('an unassigned or uninstalled role falls back to the caller, then the first preset', () => {
  expect(roleDevice(devices, {}, 'fix', codex)).toBe(codex)
  expect(roleDevice(devices, { fix: ['gone'] }, 'fix', codex)).toBe(codex)
  expect(roleDevice(devices, {}, 'merge')).toBe(claude)
  expect(roleDevice(devices, { merge: ['dev'] }, 'merge')).toBe(claude)
  expect(roleDevice([], {}, 'plan')).toMatchObject({ id: 'claude' })
})

test('only review runs several presets', () => {
  const roles = { review: ['codex', 'claude'], plan: ['codex', 'claude'] }
  expect(roleDevices(devices, roles, 'review')).toEqual([codex, claude])
  expect(roleDevices(devices, roles, 'plan')).toEqual([codex])
  expect(roleDevices(devices, {}, 'review')).toEqual([claude])
})

test('a chat checks the hooks of every preset its stages launch, each once', () => {
  const other = device('other')
  const all = [claude, codex, other]
  expect(chatRolePresets(all, {})).toEqual([claude])
  expect(chatRolePresets(all, { plan: ['codex'] })).toEqual([codex, claude])
  expect(
    chatRolePresets(all, { plan: ['codex'], review: ['other', 'codex'], fix: ['claude'] }),
  ).toEqual([codex, other, claude])
  expect(chatRolePresets(all, { plan: ['codex'], review: ['codex'], merge: ['codex'] })).toEqual([
    codex,
  ])
})

test('restored assignments drop malformed entries and keep one preset outside review', () => {
  expect(restoredAgentRoles(null)).toEqual({})
  expect(restoredAgentRoles(['codex'])).toEqual({})
  expect(
    restoredAgentRoles({
      plan: ['claude', 'codex'],
      review: ['codex', 'codex', 7, '', 'claude'],
      fix: 'codex',
      merge: [],
      other: ['codex'],
    }),
  ).toEqual({ plan: ['claude'], review: ['codex', 'claude'] })
})
