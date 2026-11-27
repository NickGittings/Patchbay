import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { AgentRoles, DeviceManifest } from '../types'
import { restoredAgentRoles } from './agentRoles'
import { restoredNotifications } from './notificationSettings'
import { restoredUsage } from './usageSettings'
import { listDevices } from './ipc'
import { flushWorkspace, workspaceDocument, workspaceSaveBlocked } from './workspace'

/** The workspace settings that travel (mirrors `settings_bundle::PORTABLE_SETTINGS`). Others,
 * such as hook sources and pending merge cleanups, describe this machine. */
export const PORTABLE_SETTINGS = [
  'agentRoles',
  'notifications',
  'usage',
  'chatAgent',
  'autoKeepAwake',
  'mergeCleanup',
  'reviewCouncil',
] as const
/** Portable settings kept in their own store fields rather than in `workspaceSettings`. */
const STORE_FIELDS = new Set<string>(['agentRoles', 'notifications', 'usage'])
/** Tells open settings panels that profiles changed underneath them. */
export const SETTINGS_IMPORTED_EVENT = 'patchbay:settings-imported'

export interface ImportedSettings {
  settings: Record<string, unknown>
  profilesNeedingKeys: string[]
  profilesMissingPrograms: string[]
}

const settingsExport = (settings: Record<string, unknown>) =>
  invoke<string | null>('settings_export', { settings })
const settingsImport = () => invoke<ImportedSettings | null>('settings_import')

interface SettingsState {
  agentRoles: AgentRoles
  workspaceSettings: Record<string, unknown>
}

/** The store after importing `settings`: each preference in the file replaces the user's, and
 * everything else, including this machine's runtime state, stays as it is. */
export function importedSettingsState(
  settings: Record<string, unknown>,
  current: Pick<SettingsState, 'workspaceSettings'>,
) {
  const has = (key: string) => Object.hasOwn(settings, key)
  const workspaceSettings = { ...current.workspaceSettings }
  for (const key of PORTABLE_SETTINGS)
    if (!STORE_FIELDS.has(key) && has(key)) workspaceSettings[key] = settings[key]
  return {
    workspaceSettings,
    ...(has('agentRoles') ? { agentRoles: restoredAgentRoles(settings.agentRoles) } : {}),
    ...(has('notifications')
      ? { notifications: restoredNotifications(settings.notifications) }
      : {}),
    ...(has('usage') ? { usageSettings: restoredUsage(settings.usage) } : {}),
  }
}

/** Preset ids the imported settings refer to that this machine doesn't have. */
export function missingPresets(state: SettingsState, devices: Pick<DeviceManifest, 'id'>[]) {
  const known = new Set(devices.map((d) => d.id))
  const council = state.workspaceSettings.reviewCouncil as { members?: unknown } | undefined
  const ids = [
    ...Object.values(state.agentRoles).flat(),
    state.workspaceSettings.chatAgent,
    ...(Array.isArray(council?.members) ? council.members : []),
  ].filter((id): id is string => typeof id === 'string' && !!id)
  return [...new Set(ids.filter((id) => !known.has(id)))]
}

export async function exportSettings() {
  const s = useStore.getState()
  const blocked = workspaceSaveBlocked()
  if (blocked) return s.setMessage(blocked, true)
  try {
    const path = await settingsExport(workspaceDocument().settings ?? {})
    if (path) s.setMessage(`Settings exported to ${path}`, true)
  } catch (e) {
    s.setMessage(String(e), undefined, undefined, 'error')
  }
}

export async function importSettings() {
  const s = useStore.getState()
  const blocked = workspaceSaveBlocked()
  if (blocked) return s.setMessage(blocked, true)
  try {
    const imported = await settingsImport()
    if (!imported) return
    useStore.setState((s) => importedSettingsState(imported.settings, s))
    window.dispatchEvent(new Event(SETTINGS_IMPORTED_EVENT))
    const devices = await listDevices()
    useStore.getState().setDevices(devices)
    await flushWorkspace(true)
    const notes = [
      imported.profilesNeedingKeys.length &&
        `Add API keys in Agent profiles for: ${imported.profilesNeedingKeys.join(', ')}.`,
      imported.profilesMissingPrograms.length &&
        `Install or locate the executable for: ${imported.profilesMissingPrograms.join(', ')}.`,
    ].filter(Boolean)
    const missing = missingPresets(useStore.getState(), devices)
    if (missing.length)
      notes.push(`Missing presets, reassign them in Agent roles: ${missing.join(', ')}.`)
    s.setMessage(['Settings imported.', ...notes].join(' '), !notes.length)
  } catch (e) {
    s.setMessage(String(e), undefined, undefined, 'error')
  }
}
