import { extraContext } from '../extensions/context'
import type { ExtensionRegistry } from '../types'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { OpenedProject, PlanText, SessionRecord, WorkspaceDocument } from '../types'
function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  return tauriInvoke<T>(command, { projectId: useStore.getState().project?.id, ...args })
}
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type {
  Added,
  MapIssue,
  MapEdit,
  ReconciliationPreview,
  ActionPlan,
  ActionReport,
  ActionRequest,
  ChangedFile,
  DeviceManifest,
  DirEntry,
  EditorPreferences,
  EditorTarget,
  EditorLauncher,
  FileSearchResult,
  FileDiff,
  GitStatus,
  Kickoff,
  Project,
  Review,
  Task,
  TaskDraft,
  TaskPatch,
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
  invoke<ReconciliationPreview>('rescan_project', { project, projectId: project.projectId })
export const mapIssues = (project: Project) =>
  invoke<MapIssue[]>('map_issues', { project, projectId: project.projectId })
export const applyReconciliation = (project: Project, previewId: string, selected: string[]) =>
  invoke<MapEdit>('apply_reconciliation', {
    project,
    projectId: project.projectId,
    previewId,
    selected,
  })
export const editMapComponents = (
  project: Project,
  remove: string[],
  componentId?: string,
  path?: string,
) =>
  invoke<MapEdit>('edit_map_components', {
    project,
    projectId: project.projectId,
    remove,
    componentId,
    path,
  })
export const cleanupComponentScopes = (project: Project, removed: string[]) =>
  invoke<void>('cleanup_component_scopes', { project, projectId: project.projectId, removed })
export const releaseMapEdit = (projectId: string, token: string) =>
  invoke<void>('release_map_edit', { projectId, token })
export type ProjectSaveResult =
  | { status: 'saved'; path: string; fingerprint: string }
  | { status: 'conflict'; fingerprint: string }
export const saveProject = (project: Project, expectedFingerprint: string | null) =>
  invoke<ProjectSaveResult>('save_project', {
    project,
    projectId: project.projectId,
    expectedFingerprint,
  })
export const reloadProject = (projectId: string) =>
  invoke<OpenedProject>('reload_project', { projectId })
export const graphActionPlan = (project: Project, request: ActionRequest, task?: string) =>
  invoke<ActionPlan>('graph_action_plan', {
    project,
    projectId: project.projectId,
    request,
    task,
  })
/** Runs in the session service, which owns the terminals it starts. */
export const graphActionRun = (project: Project, request: ActionRequest, task?: string) =>
  invoke<ActionReport>('graph_action_run', {
    project,
    projectId: project.projectId,
    request,
    task,
  })
export const graphGroupStop = (
  groupId: string,
  task?: string,
  projectId = useStore.getState().project?.id,
) => invoke<void>('graph_group_stop', { groupId, task, projectId })
/** Stop the running validation; `false` if none was running. */
export const graphValidationCancel = (projectId = useStore.getState().project?.id) =>
  invoke<boolean>('graph_validation_cancel', { projectId })
export const componentContext = async (
  project: Project,
  componentId: string,
  task?: string,
  peers?: string[],
) =>
  invoke<string>('component_context', {
    project,
    projectId: project.projectId,
    componentId,
    extraContext: await extraContext(project, [componentId], undefined, task),
    task,
    peers,
  })
/** Opens a folder picker; `null` if cancelled. */
export const addFolder = (project: Project) =>
  invoke<Added | null>('add_folder', { project, projectId: project.projectId })
/** Opens a folder picker for a component's folder; the path relative to the root, or `null`. */
export const pickComponentFolder = () => invoke<string | null>('pick_component_folder')
/** Tell the backend which component folders are on the map; it can only narrow file access. */
export const syncRoots = (paths: string[], projectId = useStore.getState().project?.id) =>
  invoke<void>('sync_roots', { paths, projectId })
export const onFileAccessChanged = (handler: () => void) =>
  listen('patchbay://file-access', handler)
/** `task` reads the task's worktree instead of the project's own. */
export const gitStatus = (
  components: { id: string; path: string }[],
  task?: string,
  projectId = useStore.getState().project?.id,
) => invoke<GitStatus>('git_status', { components, task, projectId })
/** Every component on the map is sent so files are attributed as `gitStatus` counts them. */
export const gitChanges = (
  components: { id: string; path: string }[],
  componentId: string,
  task?: string,
) => invoke<ChangedFile[]>('git_changes', { components, componentId, task })
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
export const gitBranches = () => invoke<string[]>('git_branches')
/** Planners belong to the project, so they never take a task. */
export const planContext = async (project: Project, componentIds: string[]) =>
  invoke<string>('plan_context', {
    project,
    projectId: project.projectId,
    componentIds,
    extraContext: await extraContext(project, componentIds),
  })
/** The plan the planner saved for the project (or task); empty when there is none. */
export const planRead = (projectId: string, task?: string) =>
  invoke<PlanText>('plan_read', { projectId, task })
/**
 * Replace the saved plan that component agents receive in their briefing, while the file still
 * holds `expected` (`null` replaces any content); `false` when it didn't.
 */
export const planWrite = (
  projectId: string,
  task: string | undefined,
  text: string,
  expected: string | null,
) => invoke<boolean>('plan_write', { projectId, task, text, expected })
export const planStart = async (
  project: Project,
  componentIds: string[],
  terminal: TerminalSpec,
  requestId: string = crypto.randomUUID(),
  resume = false,
) =>
  invoke<string>('plan_start', {
    project,
    projectId: project.projectId,
    componentIds,
    terminal,
    requestId,
    resume,
    extraContext: await extraContext(project, componentIds),
  })

const activeId = () => useStore.getState().project?.id
export const taskList = (projectId = activeId()) => invoke<Task[]>('task_list', { projectId })
/** Creates the branch (unless it exists) and a worktree beside the repo. */
export const taskCreate = (draft: TaskDraft, projectId = activeId()) =>
  invoke<Task>('task_create', { draft, projectId })
/** `worktree` is a path `gitWorktrees` returned. */
export const taskAttach = (
  worktree: string,
  title: string | undefined,
  components: string[],
  projectId = activeId(),
) => invoke<Task>('task_attach', { worktree, title, components, projectId })
export const taskUpdate = (id: string, patch: TaskPatch, projectId = activeId()) =>
  invoke<Task>('task_update', { id, patch, projectId })
/**
 * git refuses to remove a worktree with changes; the branch is always kept. The task's sessions are
 * stopped first and forgotten after; resolves to whether forgetting them succeeded.
 */
export const taskRemove = (id: string, deleteWorktree: boolean, projectId = activeId()) =>
  invoke<boolean>('task_remove', { id, deleteWorktree, projectId })
/** Watch the task's worktree (none for the project's own). */
export const taskActivate = (id: string | null, projectId = useStore.getState().project?.id) =>
  invoke<void>('task_activate', { id, projectId })

export const listDevices = () => invoke<DeviceManifest[]>('list_devices')
export const saveDevice = (device: DeviceManifest) => invoke<string>('save_device', { device })

/**
 * Only agent terminals get a briefing, so only they wait for extension context. With `task`, the
 * terminal runs in that task's worktree.
 */
export const terminalStart = async (
  project: Project,
  componentId: string,
  terminalId: string,
  caller?: string,
  task?: string,
  requestId: string = crypto.randomUUID(),
  peers?: string[],
  resume = false,
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
    resume,
    extraContext:
      terminal?.kind === 'agent' ? await extraContext(project, [componentId], caller, task) : [],
    task,
    peers,
  })
}
export const terminalWrite = (sessionId: string, data: string) =>
  invoke<void>('terminal_write', { sessionId, data })
export const terminalResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('terminal_resize', { sessionId, cols, rows })
export const terminalCloseGuard = (projectId: string, componentId: string, terminalId: string) =>
  invoke<string>('terminal_close_guard', { projectId, componentId, terminalId })
export const terminalStop = (sessionId: string) => invoke<void>('terminal_stop', { sessionId })
export const sessionsStopAll = () => invoke<void>('sessions_stop_all')
/** A window showed the session to the user; every window hears the new status. */
export const terminalSeen = (sessionId: string) => invoke<void>('terminal_seen', { sessionId })
/** Stop every session, retaining output; returns the highest observed generation. */
export const terminalReset = () => invoke<number>('terminal_reset')
/** Stop an older Patchbay version's session service, ending its running work. */
export const serviceRetire = () => invoke<void>('service_retire')

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
export const listDir = (
  path: string,
  projectId = useStore.getState().project?.id,
  task: string | null = null,
) => invoke<DirEntry[]>('list_dir', { path, projectId, task })
export const revealPath = (
  path: string,
  worktree?: string,
  projectId = useStore.getState().project?.id,
  task: string | null = useStore.getState().activeTask,
) => invoke<void>('reveal_path', { path, projectId, task, worktree })
/** The absolute path of `path` (relative to the project root) in the task's worktree, or the open
 * folder without one. */
export const resolvePath = (
  path: string,
  projectId = useStore.getState().project?.id,
  task: string | null = useStore.getState().activeTask,
) => invoke<string>('resolve_path', { path, projectId, task })
export const editorPreferences = () => invoke<EditorPreferences>('editor_preferences')
export const editorSavePreferences = (preferences: EditorPreferences) =>
  invoke<void>('editor_save_preferences', { preferences })
export const editorDiscover = () => invoke<EditorLauncher[]>('editor_discover')
export const editorOpen = (
  target: EditorTarget,
  projectId: string,
  task: string | null,
  worktree?: string,
) => invoke<void>('editor_open', { target, projectId, task, worktree })
export const fileSearch = (query: string, projectId: string, task: string | null) =>
  invoke<FileSearchResult[]>('file_search', { query, projectId, task })
export const terminalOpenReference = (sessionId: string, generation: number, reference: string) =>
  invoke<void>('terminal_open_reference', { sessionId, generation, reference })

export const listExtensions = () => invoke<ExtensionRegistry>('list_extensions')
export const reloadExtensions = () => invoke<ExtensionRegistry>('reload_extensions')
export const setExtensionEnabled = (id: string, enabled: boolean) =>
  invoke<ExtensionRegistry>('set_extension_enabled', { id, enabled })
export const installExtension = () => invoke<ExtensionRegistry | null>('install_extension')
export const revealExtensionsDir = () => invoke<void>('reveal_extensions_dir')
export const commandRun = (
  project: Project,
  componentId: string,
  commandId: string,
  task?: string,
) =>
  invoke<string>('command_run', {
    task,
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
  task?: string,
) =>
  invoke<string>('extension_terminal_run', {
    task,
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
  task?: string,
) => invoke<string>('extension_file_read', { extensionId, path, projectId, task })

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
export const quitPatchbay = () => invoke<void>('quit_patchbay')
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

export const agentHooksCheck = (provider: 'claude' | 'codex', sourceOverride?: string) =>
  invoke<import('../types').AgentIntegration>('agent_hooks_check', { provider, sourceOverride })
export const agentHooksConfigure = (
  provider: 'claude' | 'codex',
  install: boolean,
  sourceOverride?: string,
) =>
  invoke<import('../types').AgentIntegration>('agent_hooks_configure', {
    provider,
    install,
    sourceOverride,
  })

export const extensionSessionsList = (
  extensionId: string,
  project: Project,
  componentId: string,
  task?: string,
) =>
  invoke<import('../types').ComponentSessionSummary[]>('extension_sessions_list', {
    extensionId,
    project,
    projectId: project.projectId,
    componentId,
    task,
  })
export const extensionUrlOpen = (extensionId: string, projectId: string, url: string) =>
  invoke<void>('extension_url_open', { extensionId, projectId, url })

/** The task a fix for review session `sessionId` runs in; `null` for the project folder. */
export const reviewFixTask = (sessionId: string, projectId: string) =>
  invoke<string | null>('review_fix_task', { sessionId, projectId })
export const taskRootStart = async (
  project: Project,
  componentIds: string[],
  terminal: TerminalSpec,
  task?: string,
  requestId: string = crypto.randomUUID(),
  kickoff?: Kickoff,
  resume = false,
) =>
  invoke<string>('task_root_start', {
    projectId: project.projectId,
    project,
    componentIds,
    terminal,
    task,
    requestId,
    resume,
    kickoff: kickoff?.kind,
    reviewSession: kickoff?.kind === 'fixFindings' ? kickoff.reviewSession : undefined,
    extraContext:
      terminal.kind === 'agent' ? await extraContext(project, componentIds, undefined, task) : [],
  })
/** A planner submitted a proposal (`agent_commands.rs` emits it). */
export const PROPOSAL_EVENT = 'patchbay://proposal'
export const onProposal = (
  handler: (event: { projectId: string; task: string | null }) => void,
): Promise<UnlistenFn> =>
  listen<{ projectId: string; task: string | null }>(PROPOSAL_EVENT, (e) => handler(e.payload))
export const proposalRead = (projectId: string, task?: string) =>
  invoke<import('../types').PlannerProposal | null>('proposal_read', { projectId, task })
export const proposalApply = (
  project: Project,
  task: string | undefined,
  expected: import('../types').PlannerProposal,
  /** The task that receives it; defaults to `task`, which holds the proposal. */
  target?: string,
) =>
  invoke<string[]>('proposal_apply', {
    projectId: project.projectId,
    project,
    task,
    target,
    expected,
  })
export const taskActivities = (projectId: string) =>
  invoke<import('../types').TaskActivity[]>('task_activities', { projectId })

export const syncAgentProject = (project: Project) =>
  invoke<void>('sync_agent_project', { projectId: project.projectId, project })

/** Launch a dedicated merge session; validates the worktrees immediately before starting. */
export const mergeAgentStart = (
  project: Project,
  request: import('../types').MergeRequest,
  terminal: TerminalSpec,
  requestId: string,
) =>
  invoke<string>('merge_agent_start', {
    projectId: project.projectId,
    project,
    request,
    terminal,
    requestId,
  })

export const reviewAgentStart = (
  project: Project,
  request: import('../types').ReviewRequest,
  terminal: TerminalSpec,
  requestId: string,
) =>
  invoke<string>('review_agent_start', {
    projectId: project.projectId,
    project,
    request,
    terminal,
    requestId,
  })

export const reviewRead = (projectId: string, branch: string) =>
  invoke<import('../types').ReviewFindings | null>('review_read', { projectId, branch })

export const reviewPrune = (projectId: string) => invoke<void>('review_prune', { projectId })
