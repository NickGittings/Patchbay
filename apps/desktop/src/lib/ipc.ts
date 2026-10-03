import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DeviceManifest, DirEntry, Project, TerminalEvent, TerminalSnapshot } from '../types'

export const openProject = (root: string) =>
  invoke<{ project: Project; detected: boolean }>('open_project', { root })
export const rescanProject = (project: Project) =>
  invoke<{ project: Project; added: number }>('rescan_project', { project })
export const saveProject = (project: Project) => invoke<string>('save_project', { project })
export const componentContext = (project: Project, componentId: string) =>
  invoke<string>('component_context', { project, componentId })
export const gitChanges = (root: string, components: [string, string][]) =>
  invoke<Record<string, number>>('git_changes', { root, components })

export const listDevices = () => invoke<DeviceManifest[]>('list_devices')
export const saveDevice = (device: DeviceManifest) => invoke<string>('save_device', { device })

export const terminalStart = (project: Project, componentId: string, terminalId: string) =>
  invoke<string>('terminal_start', { project, componentId, terminalId })
export const terminalWrite = (sessionId: string, data: string) =>
  invoke<void>('terminal_write', { sessionId, data })
export const terminalResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('terminal_resize', { sessionId, cols, rows })
export const terminalStop = (sessionId: string) => invoke<void>('terminal_stop', { sessionId })
/** Kill every session and drop retained output; returns the generation floor. */
export const terminalReset = () => invoke<number>('terminal_reset')

export const onTerminalEvent = (handler: (e: TerminalEvent) => void): Promise<UnlistenFn> =>
  listen<TerminalEvent>('patchbay://terminal', (e) => handler(e.payload))

export const terminalSnapshot = (sessionId: string) =>
  invoke<TerminalSnapshot | null>('terminal_snapshot', { sessionId })
export const listDir = (root: string, path: string) =>
  invoke<DirEntry[]>('list_dir', { root, path })
