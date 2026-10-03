import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  DeviceManifest,
  DirEntry,
  GitStatus,
  Project,
  TerminalEvent,
  TerminalSnapshot,
} from '../types'

export const openProject = (root: string) =>
  invoke<{ project: Project; detected: boolean }>('open_project', { root })
export const rescanProject = (project: Project) =>
  invoke<{ project: Project; added: number }>('rescan_project', { project })
export const saveProject = (project: Project) => invoke<string>('save_project', { project })
export const componentContext = (project: Project, componentId: string) =>
  invoke<string>('component_context', { project, componentId })
/** Opens a folder picker; `null` if cancelled. */
export const addFolder = (project: Project) =>
  invoke<{ project: Project; added: number } | null>('add_folder', { project })
export const gitStatus = (project: Project) => invoke<GitStatus>('git_status', { project })

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

/** The main window hears every session; a pop-out only its own component's (see `TauriSink`). */
export function onTerminalEvent(handler: (e: TerminalEvent) => void): Promise<UnlistenFn> {
  const { label } = getCurrentWebviewWindow()
  const event = label === 'main' ? 'patchbay://terminal' : `patchbay://terminal/${label}`
  return listen<TerminalEvent>(event, (e) => handler(e.payload))
}

export const terminalSnapshot = (sessionId: string) =>
  invoke<TerminalSnapshot | null>('terminal_snapshot', { sessionId })
/** `path` is relative to the open project's root; the backend refuses anything outside it. */
export const listDir = (path: string) => invoke<DirEntry[]>('list_dir', { path })
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })
