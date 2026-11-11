import { expect, test } from 'vitest'
import type { DeviceManifest, WorkspaceDocument } from '../types'
import {
  chatRolePresets,
  restoredAgentDefaults,
  restoredAgentRoles,
  roleDevice,
  roleDevices,
} from './agentRoles'

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

test('scanners and workers restore several presets and default to off', () => {
  const roles = restoredAgentRoles({
    scan: ['codex', 'codex', 'claude'],
    worker: ['claude', 7, 'codex'],
  })
  expect(roles).toEqual({ scan: ['codex', 'claude'], worker: ['claude', 'codex'] })
  expect(roleDevices(devices, roles, 'scan')).toEqual([codex, claude])
  expect(roleDevices(devices, roles, 'worker')).toEqual([claude, codex])
  expect(roleDevices(devices, {}, 'scan')).toEqual([])
  expect(roleDevices(devices, {}, 'worker')).toEqual([])
  expect(roleDevices(devices, { scan: ['missing'] }, 'scan')).toEqual([])
})

const legacyProject = (id: string, agentRoles: unknown, implementSubagents?: unknown) =>
  ({
    id,
    root: `/${id}`,
    name: id,
    savedFingerprint: '',
    draft: null,
    layout: { agentRoles, implementSubagents },
  }) satisfies WorkspaceDocument['projects'][number]

test('legacy defaults prefer the active project and fill missing roles from other projects', () => {
  const projects = [
    legacyProject('krilo', { plan: ['codex'], review: ['codex'] }, 3),
    legacyProject('safari', {}, undefined),
    legacyProject('other', { plan: ['claude'], fix: ['claude'] }, 5),
  ]
  expect(restoredAgentDefaults({ projects, activeProject: 'safari' })).toEqual({
    agentRoles: { plan: ['codex'], review: ['codex'], fix: ['claude'] },
    implementSubagents: 3,
  })
  expect(restoredAgentDefaults({ projects, activeProject: 'other' })).toEqual({
    agentRoles: { plan: ['claude'], review: ['codex'], fix: ['claude'] },
    implementSubagents: 5,
  })
})

test('saved global defaults including cleared roles and Off override legacy project settings', () => {
  const projects = [legacyProject('p', { review: ['claude'], fix: ['claude'] }, 5)]
  for (const agentRoles of [{}, { review: ['codex', 'codex'] }]) {
    expect(
      restoredAgentDefaults({
        projects,
        activeProject: 'p',
        settings: { agentRoles, implementSubagents: 0 },
      }),
    ).toEqual({ agentRoles: restoredAgentRoles(agentRoles), implementSubagents: 0 })
  }
})

test('malformed global defaults are sanitized without resurrecting old project assignments', () => {
  expect(
    restoredAgentDefaults({
      projects: [legacyProject('p', { review: ['claude'] }, 3)],
      activeProject: 'p',
      settings: { agentRoles: 'bad', implementSubagents: 99 },
    }),
  ).toEqual({ agentRoles: {}, implementSubagents: 0 })
  expect(restoredAgentDefaults({ projects: [], activeProject: null })).toEqual({
    agentRoles: {},
    implementSubagents: 0,
  })
})
