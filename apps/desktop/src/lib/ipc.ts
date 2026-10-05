import { extraContext } from '../extensions/context'
import type { ExtensionRegistry } from '../types'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { OpenedProject, SessionRecord, WorkspaceDocument } from '../types'
function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return tauriInvoke<T>(command, { projectId: useStore.getState().project?.id, ...args })
}
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  Added,
  ChangedFile,
  DeviceManifest,
  DirEntry,
  FileDiff,
  GitStatus,
  Project,
  Review,
  TerminalEvent,
  TerminalSnapshot,
  TerminalSpec,
  Worktree,
} from '../types'

export const GIT_DIRTY_EVENT = 'patchbay://git-dirty'
/** Mirrors `service::TERMINAL_EVENT`. */
const TERMINAL_EVENT = 'patchbay://terminal'

/** Backend folder picker; may also ask whether external folders may be read. */
export const openProject = () =>
  invoke<OpenedProject | null>('open_project').then(
    (opened) => opened && { ...opened, project: { ...opened.project, projectId: opened.id } },
  )
export const rescanProject = (project: Project) =>
  invoke<Added>('rescan_project', { project, projectId: project.projectId })
export const saveProject = (project: Project) =>
  invoke<string>('save_project', { project, projectId: project.projectId })
export const componentContext = async (project: Project, componentId: string) =>
  invoke<string>('component_context', {
    project,
    projectId: project.projectId,
    componentId,
    extraContext: await extraContext(project, [componentId]),
  })
/** Opens a folder picker; `null` if cancelled. */
export const addFolder = (project: Project) =>
  invoke<Added | null>('add_folder', { project, projectId: project.projectId })
/** Opens a folder picker for a component's folder; the path relative to the root, or `null`. */
export const pickComponentFolder = () => invoke<string | null>('pick_component_folder')
/** Tell the backend which component folders are on the map; it can only narrow file access. */
export const syncRoots = (paths: string[]) => invoke<void>('sync_roots', { paths })
export const onFileAccessChanged = (handler: () => void) =>
  listen('patchbay://file-access', handler)
export const gitStatus = (
  components: { id: string; path: string }[],
  projectId = useStore.getState().project?.id,
) => invoke<GitStatus>('git_status', { components, projectId })
/** Every component on the map is sent so files are attributed as `gitStatus` counts them. */
export const gitChanges = (components: { id: string; path: string }[], componentId: string) =>
  invoke<ChangedFile[]>('git_changes', { components, componentId })
/**
 * `path` must be one of the component's changes, relative to the project root; `oldPath` is the
 * one it lists for a rename, so the diff shows the rename.
 */
export const gitDiff = (
  components: { id: string; path: string }[],
  componentId: string,
  path: string,
  oldPath?: string,
  worktree?: string,
) => invoke<FileDiff>('git_diff', { components, componentId, path, oldPath, worktree })
/** `worktree` is a path `gitWorktrees` returned; omitted for the open one. */
export const gitReview = (project: Project, worktree?: string) =>
  invoke<Review>('git_review', { project, projectId: project.projectId, worktree })
export const gitWorktrees = () => invoke<Worktree[]>('git_worktrees')
export const planContext = async (project: Project, componentIds: string[]) =>
  invoke<string>('plan_context', {
    project,
    projectId: project.projectId,
    componentIds,
    extraContext: await extraContext(project, componentIds),
  })
export const planStart = async (
  project: Project,
  componentIds: string[],
  terminal: TerminalSpec,
  requestId: string = crypto.randomUUID(),
) =>
  invoke<string>('plan_start', {
    project,
    projectId: project.projectId,
    componentIds,
    terminal,
    requestId,
    extraContext: await extraContext(project, componentIds),
  })

export const listDevices = () => invoke<DeviceManifest[]>('list_devices')
export const saveDevice = (device: DeviceManifest) => invoke<string>('save_device', { device })

/** Only agent terminals get a briefing, so only they wait for extension context. */
export const terminalStart = async (
  project: Project,
  componentId: string,
  terminalId: string,
  caller?: string,
  requestId: string = crypto.randomUUID(),
) => {
  const terminal = project.components
    .find((c) => c.id === componentId)
    ?.terminals.find((t) => t.id === terminalId)
  return invoke<string>('terminal_start', {
    project,
    projectId: project.projectId,
    componentId,
    terminalId,
    requestId,
    extraContext:
      terminal?.kind === 'agent' ? await extraContext(project, [componentId], caller) : [],
  })
}
export const terminalWrite = (sessionId: string, data: string) =>
  invoke<void>('terminal_write', { sessionId, data })
export const terminalResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('terminal_resize', { sessionId, cols, rows })
export const terminalStop = (sessionId: string) => invoke<void>('terminal_stop', { sessionId })
/** A window showed the session to the user; every window hears the new status. */
export const terminalSeen = (sessionId: string) => invoke<void>('terminal_seen', { sessionId })
/** Kill every session and drop retained output; returns the generation floor. */
export const terminalReset = () => invoke<number>('terminal_reset')

/** The main window hears every session; a pop-out only its own component's (`Bridge::route`). */
export function onTerminalEvent(handler: (e: TerminalEvent) => void): Promise<UnlistenFn> {
  const label = getCurrentWebviewWindow().label
  const channel = label === 'main' ? TERMINAL_EVENT : `${TERMINAL_EVENT}/${label}`
  return listen<{ instanceId: string; event: TerminalEvent }>(channel, (e) =>
    handler({ ...e.payload.event, instanceId: e.payload.instanceId }),
  )
}

export const terminalSnapshot = (sessionId: string) =>
  invoke<TerminalSnapshot | null>('terminal_snapshot', { sessionId })
/** `path` is relative to the open project's root; the backend refuses anything outside it. */
export const listDir = (path: string, projectId = useStore.getState().project?.id) =>
  invoke<DirEntry[]>('list_dir', { path, projectId })
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })

export const listExtensions = () => invoke<ExtensionRegistry>('list_extensions')
export const reloadExtensions = () => invoke<ExtensionRegistry>('reload_extensions')
export const setExtensionEnabled = (id: string, enabled: boolean) =>
  invoke<ExtensionRegistry>('set_extension_enabled', { id, enabled })
export const installExtension = () => invoke<ExtensionRegistry | null>('install_extension')
export const revealExtensionsDir = () => invoke<void>('reveal_extensions_dir')
export const commandRun = (project: Project, componentId: string, commandId: string) =>
  invoke<string>('command_run', {
    project,
    projectId: project.projectId,
    componentId,
    commandId,
    requestId: crypto.randomUUID(),
  })
export const extensionTerminalRun = (
  project: Project,
  extensionId: string,
  componentId: string,
  command: string,
  key: string,
) =>
  invoke<string>('extension_terminal_run', {
    project,
    projectId: project.projectId,
    requestId: crypto.randomUUID(),
    request: { extensionId, componentId, command, key },
  })
export const extensionStorageGet = (extensionId: string) =>
  invoke<Record<string, unknown>>('extension_storage_get', { extensionId })
export const extensionStorageSet = (extensionId: string, data: Record<string, unknown>) =>
  invoke<void>('extension_storage_set', { extensionId, data })
export const extensionFileRead = (
  extensionId: string,
  path: string,
  projectId = useStore.getState().project?.id,
) => invoke<string>('extension_file_read', { extensionId, path, projectId })

/** Register as a viewer; `claim` makes this window the one that types and sizes the PTY. */
export const terminalAttach = (sessionId: string, claim = false) =>
  invoke<void>('terminal_attach', { sessionId, claim })
export const terminalDetach = (sessionId: string) => invoke<void>('terminal_detach', { sessionId })
export const sessionsList = () => invoke<SessionRecord[]>('sessions_list')
export const sessionResume = (sessionId: string, requestId: string = crypto.randomUUID()) =>
  invoke<string>('session_resume', { sessionId, requestId })
export const sessionConversation = (sessionId: string, conversationId: string) =>
  invoke<void>('session_conversation', { sessionId, conversationId })
export const sessionForget = (sessionId: string) => invoke<void>('session_forget', { sessionId })
export const quitPatchbay = (stopWork = false) => invoke<void>('quit_patchbay', { stopWork })
export const workspaceLoad = () =>
  invoke<{ document: WorkspaceDocument; opened: OpenedProject[]; errors: Record<string, string> }>(
    'workspace_load',
  )
export const workspaceSave = (document: WorkspaceDocument) =>
  invoke<void>('workspace_save', { document })
export const projectRelink = (projectId: string) =>
  invoke<OpenedProject | null>('project_relink', { projectId })

export const sessionHistory = (sessionId: string, incarnation: number) =>
  invoke<TerminalSnapshot | null>('session_history', { sessionId, incarnation })
