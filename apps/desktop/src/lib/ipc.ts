import { extraContext } from '../extensions/context'
import type { ExtensionRegistry } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  Added,
  DeviceManifest,
  DirEntry,
  GitStatus,
  Project,
  TerminalEvent,
  TerminalSnapshot,
  TerminalSpec,
} from '../types'

export const GIT_DIRTY_EVENT = 'patchbay://git-dirty'

/** Backend folder picker; may also ask whether external folders may be read. */
export const openProject = () =>
  invoke<{ project: Project; detected: boolean; locked: string[] } | null>('open_project')
export const rescanProject = (project: Project) => invoke<Added>('rescan_project', { project })
export const saveProject = (project: Project) => invoke<string>('save_project', { project })
export const componentContext = async (project: Project, componentId: string) =>
  invoke<string>('component_context', {
    project,
    componentId,
    extraContext: await extraContext(project, [componentId]),
  })
/** Opens a folder picker; `null` if cancelled. */
export const addFolder = (project: Project) => invoke<Added | null>('add_folder', { project })
/** Opens a folder picker for a component's folder; the path relative to the root, or `null`. */
export const pickComponentFolder = () => invoke<string | null>('pick_component_folder')
/** Tell the backend which component folders are on the map; it can only narrow file access. */
export const syncRoots = (paths: string[]) => invoke<void>('sync_roots', { paths })
export const onFileAccessChanged = (handler: () => void) =>
  listen('patchbay://file-access', handler)
export const gitStatus = (components: { id: string; path: string }[]) =>
  invoke<GitStatus>('git_status', { components })
export const planContext = async (project: Project, componentIds: string[]) =>
  invoke<string>('plan_context', {
    project,
    componentIds,
    extraContext: await extraContext(project, componentIds),
  })
export const planStart = async (project: Project, componentIds: string[], terminal: TerminalSpec) =>
  invoke<string>('plan_start', {
    project,
    componentIds,
    terminal,
    extraContext: await extraContext(project, componentIds),
  })

export const listDevices = () => invoke<DeviceManifest[]>('list_devices')
export const saveDevice = (device: DeviceManifest) => invoke<string>('save_device', { device })

export const terminalStart = async (project: Project, componentId: string, terminalId: string) =>
  invoke<string>('terminal_start', {
    project,
    componentId,
    terminalId,
    extraContext: await extraContext(project, [componentId]),
  })
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

export const listExtensions = () => invoke<ExtensionRegistry>('list_extensions')
export const reloadExtensions = () => invoke<ExtensionRegistry>('reload_extensions')
export const setExtensionEnabled = (id: string, enabled: boolean) =>
  invoke<ExtensionRegistry>('set_extension_enabled', { id, enabled })
export const installExtension = () => invoke<ExtensionRegistry | null>('install_extension')
export const revealExtensionsDir = () => invoke<void>('reveal_extensions_dir')
export const commandRun = (project: Project, componentId: string, commandId: string) =>
  invoke<string>('command_run', { project, componentId, commandId })
export const extensionTerminalRun = (
  project: Project,
  extensionId: string,
  componentId: string,
  command: string,
  requestId: string,
) =>
  invoke<string>('extension_terminal_run', {
    project,
    request: { extensionId, componentId, command, requestId },
  })
export const extensionStorageGet = (extensionId: string) =>
  invoke<Record<string, unknown>>('extension_storage_get', { extensionId })
export const extensionStorageSet = (extensionId: string, data: Record<string, unknown>) =>
  invoke<void>('extension_storage_set', { extensionId, data })
export const extensionFileRead = (extensionId: string, path: string) =>
  invoke<string>('extension_file_read', { extensionId, path })
