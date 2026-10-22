import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { mergeNotificationToast, removeNotificationSession } from './lib/notificationToast'
import { liveDeclined } from './lib/validators'
import { forgetAutoDrafts } from './lib/autoDrafts'
import type {
  AgentRoles,
  NotificationSettings,
  NotificationToast,
  ExtensionRegistry,
  CommandContribution,
  MenuContribution,
  ExtensionBadge,
  RuntimeTerminal,
  Component,
  ComponentGroup,
  ActionReport,
  ActionRequest,
  ComponentData,
  DeviceManifest,
  GitStatus,
  Link,
  DetectionProvenance,
  Project,
  SessionState,
  Task,
  TerminalSpec,
  View,
  TaskActivity,
} from './types'
import {
  DEFAULT_NOTIFICATIONS,
  TASK_ROOT_SCOPE,
  isReviewAgentScope,
  isSubagentCount,
  showsInDock,
  sessionId,
  sessionTask,
  sessionMetadata,
  setProjectIdentity,
  type SessionRecord,
} from './types'

function sessionScope(s: Pick<State, 'runtimeTerminals' | 'sessionRecords'>, id: string) {
  return (
    sessionMetadata.get(id)?.componentId ??
    s.runtimeTerminals[id]?.componentId ??
    s.sessionRecords.find((r) => r.id === id)?.metadata.componentId ??
    ''
  )
}

export type FlowNode = Node<ComponentData, 'component'>
export type FlowEdge = Edge<{ label?: string | null; detection?: DetectionProvenance }>

/** A button on the app message (`setMessage`). */
export interface MessageAction {
  label: string
  run: () => void
  /** A project action is only available while its originating tab is active. */
  projectId?: string
  /**
   * Keep offering it beside later messages without an action of their own (an error that follows
   * a layout change must not take its Undo away), until the toast hides or is dismissed.
   */
  persist?: boolean
}

export interface ImplementationComponent {
  id: string
  visible: boolean
}

export interface TaskComponentTerminal {
  componentId: string
  terminalId: string
}

/** Saved per task. Processes and output remain service-owned. */
export interface TaskWorkspace {
  simple: import('./lib/simple').SimpleState | null
  highlighted: string[]
  implementationComponents: ImplementationComponent[] | null
  activeSession: string | null
  planActive: string | null
  panels: Record<string, Record<string, number>>
  rootTerminals: TerminalSpec[]
  /** Saved component terminals the user added to this task, in order. */
  componentTerminals: TaskComponentTerminal[]
  maximizedTerminal: string | null
  graphActionBusy: boolean
  graphAction: ActionRequest | null
  auto: import('./types').AutoRun | null
  graphActionReport: ActionReport | null
}
export function emptyTaskWorkspace(components: string[] = []): TaskWorkspace {
  return {
    simple: null,
    highlighted: components,
    implementationComponents: components.map((id) => ({ id, visible: true })),
    activeSession: null,
    planActive: null,
    panels: {},
    rootTerminals: [{ id: 'shell', name: 'Shell', command: '', kind: 'shell' }],
    componentTerminals: [],
    maximizedTerminal: null,
    graphActionBusy: false,
    graphAction: null,
    auto: null,
    graphActionReport: null,
  }
}
export function taskWorkspace(s: TaskWorkspace): TaskWorkspace {
  const {
    simple,
    highlighted,
    implementationComponents,
    activeSession,
    planActive,
    panels,
    rootTerminals,
    componentTerminals,
    maximizedTerminal,
    graphActionBusy,
    graphAction,
    auto,
    graphActionReport,
  } = s
  return {
    simple,
    highlighted,
    implementationComponents,
    activeSession,
    planActive,
    panels,
    rootTerminals,
    componentTerminals,
    maximizedTerminal,
    graphActionBusy,
    graphAction,
    auto,
    graphActionReport,
  }
}

export interface ProjectState {
  taskWorkspaces: Record<string, TaskWorkspace>
  rootTerminals: TerminalSpec[]
  componentTerminals: TaskComponentTerminal[]
  maximizedTerminal: string | null

  project: { id: string; name: string; root: string } | null
  nodes: FlowNode[]
  edges: FlowEdge[]
  selectedId: string | null
  selectedEdgeId: string | null
  activeSession: string | null
  /** Navigation's Inspector: `null` follows the selection, else opened or closed (UI only). */
  inspector: boolean | null
  simpleMode: boolean
  simple: import('./lib/simple').SimpleState | null
  view: View
  highlighted: string[]
  /** Components kept in Implementation's header, including hidden ones (UI only). */
  implementationComponents: ImplementationComponent[] | null
  planStartedWith: Record<string, string>
  agentRoles: AgentRoles
  /** Parallel subagents requested by Implement; 0 disables it (workspace layout only). */
  implementSubagents: number
  /** Validator suggestions the user declined (`validatorKey`; workspace layout only). */
  validatorDeclined: string[]
  /** "Not now" on the offer to detect dependencies (workspace layout only). */
  dependencyPromptDismissed: boolean
  planActive: string | null
  dirty: boolean
  gitChanges: Record<string, number>
  repos: Record<string, string>
  extensionBadges: Record<string, ExtensionBadge[]>
  extensionViews: Record<string, string>
  viewport?: { x: number; y: number; zoom: number }
  panels: Record<string, Record<string, number>>
  groups: ComponentGroup[]
  graphActionBusy: boolean
  graphAction: ActionRequest | null
  auto: import('./types').AutoRun | null
  graphActionReport: ActionReport | null
  tasks: Task[]
  activeTask: string | null
  closedTaskIds: string[]
}
export interface MapSaveState {
  status: 'pending' | 'saving' | 'error' | 'conflict'
  error?: string
}
export interface ProjectEntry {
  mapSave?: MapSaveState
  id: string
  name: string
  root: string
  fingerprint: string
  state?: ProjectState
  unavailable?: string
  conflict?: Project
  draftFingerprint?: string
  unavailableLayout?: Record<string, unknown>
}
interface State {
  workspaceSettings: Record<string, unknown>
  notificationToast: NotificationToast | null
  notificationToastId: number
  setNotificationToast: (toast: State['notificationToast']) => void
  dismissNotificationSession: (sid: string) => void
  notifications: NotificationSettings
  setNotifications: (settings: NotificationSettings) => void
  taskWorkspaces: Record<string, TaskWorkspace>
  rootTerminals: TerminalSpec[]
  componentTerminals: TaskComponentTerminal[]
  maximizedTerminal: string | null

  project: { id: string; name: string; root: string } | null
  projects: Record<string, ProjectEntry>
  activeProjectId: string | null
  projectOrder: string[]
  taskActivities: Record<string, TaskActivity>
  seenActivities: string[]
  sessionRecords: SessionRecord[]
  serviceInstance: string
  serviceConnected: boolean
  /** Why the last connection to the session service failed, if it did. */
  serviceError?: string
  serviceRetirement: 'idle' | 'stopping' | 'reconnecting'
  serviceRetirementError?: string
  sessionsPanelOpen: boolean
  activityPanelOpen: boolean
  /**
   * Sessions Navigation's dock keeps listing after they exit, until closed there: ones revealed,
   * failed, or exited while active (UI only).
   */
  dockKept: string[]
  /** Explicit merge selection and Hide state survive Review remounts, per project. */
  reviewAgents: Record<string, { sid: string; hidden: boolean }>
  /** One-shot component filter for Review (UI only, never saved). */
  reviewFocus: string | null
  /** One-shot request for Review to open on the findings pane (UI only, never saved). */
  reviewFindingsFocus: boolean
  hideReviewAgent: (sid: string) => void
  keepInDock: (id: string) => void
  dropFromDock: (id: string) => void
  restoring: boolean
  viewport?: { x: number; y: number; zoom: number }
  panels: Record<string, Record<string, number>>
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void
  setPanelLayout: (id: string, layout: Record<string, number>) => void
  activateProject: (id: string) => void
  closeProject: (id: string) => void
  captureProjects: () => Record<string, ProjectEntry>
  /** Apply `patch` to open project `id`'s state, whether or not its tab is active. */
  patchProject: (id: string, patch: Partial<ProjectState>) => void
  patchTask: (projectId: string, task: string | null, patch: Partial<TaskWorkspace>) => void
  addRootTerminal: (device: DeviceManifest | null) => string
  addTaskComponentTerminal: (componentId: string, terminalId: string) => void
  /** Drops a terminal from the active task's list; component terminals stay on the map. */
  removeTaskTerminal: (componentId: string, terminalId: string) => void
  setMaximizedTerminal: (id: string | null) => void
  nodes: FlowNode[]
  edges: FlowEdge[]
  groups: ComponentGroup[]
  addGroup: (name: string, componentIds: string[]) => void
  updateGroup: (id: string, patch: Partial<ComponentGroup>) => void
  removeGroup: (id: string) => void
  graphActionBusy: boolean
  /** The action running, while `graphActionBusy`. */
  graphAction: ActionRequest | null
  auto: import('./types').AutoRun | null
  graphActionReport: ActionReport | null
  extensions: ExtensionRegistry
  commands: CommandContribution[]
  menus: Record<string, MenuContribution[]>
  extensionBadges: Record<string, ExtensionBadge[]>
  extensionViews: Record<string, string>
  runtimeTerminals: Record<string, RuntimeTerminal>
  extensionsPanelOpen: boolean
  paletteOpen: boolean
  setExtensions: (registry: ExtensionRegistry) => void
  setExtensionBadges: (badges: Record<string, ExtensionBadge[]>) => void
  setExtensionView: (id: string, html: string) => void
  /** `focus` makes it the dock's active tab (user-started commands only). */
  addRuntimeTerminal: (sid: string, terminal: RuntimeTerminal, focus?: boolean) => void
  setExtensionsPanelOpen: (open: boolean) => void
  setPaletteOpen: (open: boolean) => void
  devices: DeviceManifest[]
  sessions: Record<string, SessionState>
  gitChanges: Record<string, number>
  /** Repo folder name for components outside the project root's repo. */
  repos: Record<string, string>
  selectedId: string | null
  selectedEdgeId: string | null
  activeSession: string | null
  inspector: boolean | null
  simpleMode: boolean
  simple: import('./lib/simple').SimpleState | null
  view: View
  highlighted: string[]
  implementationComponents: ImplementationComponent[] | null
  setImplementationScope: (components: ImplementationComponent[]) => void
  planStartedWith: Record<string, string>
  /** The agent preset assigned to each role in this project (workspace layout only). */
  agentRoles: AgentRoles
  /** Parallel subagents requested by Implement; 0 disables it (workspace layout only). */
  implementSubagents: number
  setAgentRoles: (roles: AgentRoles) => void
  setImplementSubagents: (subagents: number) => void
  /** Validator suggestions the user declined in this project (workspace layout only). */
  validatorDeclined: string[]
  /** Declines suggestions, dropping keys of terminals no longer on the map. */
  declineValidators: (keys: string[]) => void
  /** "Not now" on the offer to detect dependencies (workspace layout only). */
  dependencyPromptDismissed: boolean
  /** Offers every declined suggestion again. */
  restoreValidators: () => void
  /** The planner's shown terminal id (UI only). */
  planActive: string | null
  setPlanActive: (id: string | null) => void
  /**
   * A terminal Implementation should bring on screen (UI only): its component is shown beside the
   * highlighted ones without joining them, and no other tile stays maximized.
   */
  revealed: { componentId: string; sid: string } | null
  setRevealed: (revealed: { componentId: string; sid: string } | null) => void
  setSimpleMode: (enabled: boolean) => void
  setView: (view: View) => void
  toggleHighlight: (id: string) => void
  clearHighlights: () => void
  markPlanStarted: (sid: string, ids: string[]) => void
  /** The repo's tasks (stored per user by the backend, never in `patchbay.json`). */
  tasks: Task[]
  /** The task whose worktree terminals, changes and review follow; `null` for the open one. */
  activeTask: string | null
  /** Task tabs hidden by the user; their workspaces and processes are retained. */
  closedTaskIds: string[]
  setTasks: (tasks: Task[]) => void
  setActiveTask: (id: string | null, exact?: boolean) => void
  closeTaskTab: (id: string) => void
  /** Components and goal title to seed the new-task dialog with while it is open (UI only). */
  newTask: { components: string[]; title?: string } | null
  setNewTask: (seed: { components: string[]; title?: string } | null) => void
  /** Bumped to open the toolbar's Auto panel, from the attention list (UI only). */
  autoPanelRequest: number
  showAutoPanel: () => void
  /** Components the planner's pending proposal names, outlined in Plan until applied (UI only). */
  proposedScope: string[]
  setProposedScope: (ids: string[]) => void
  dirty: boolean
  /** The latest app message, shown by `Toast`; `messageId` changes on every `setMessage`. */
  message: string
  messageId: number
  /** Hide the message on its own after a few seconds (confirmations, not errors or hints). */
  messageTransient: boolean
  /** A button the message offers, such as Undo; dropped by the next message. */
  messageAction: MessageAction | null

  loadProject: (p: Project) => void
  syncProject: (p: Project) => void
  toProject: () => Project
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<FlowEdge>[]) => void
  onConnect: (c: Connection) => void
  addComponent: (position: { x: number; y: number }) => void
  updateComponent: (id: string, patch: Partial<ComponentData>) => void
  /** Adds a saved terminal to the component and returns its id; `focus` makes it the active session. */
  addTerminal: (componentId: string, device: DeviceManifest | null, focus?: boolean) => string
  updateTerminal: (componentId: string, terminalId: string, patch: Partial<TerminalSpec>) => void
  removeTerminal: (componentId: string, terminalId: string, projectId?: string) => void
  setEdgeLabel: (id: string, label: string) => void
  select: (id: string | null) => void
  selectEdge: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  setSession: (id: string, s: SessionState) => void
  setGitChanges: (c: Record<string, number>) => void
  setGitStatus: (s: GitStatus) => void
  setDevices: (d: DeviceManifest[]) => void
  setMessage: (m: string, transient?: boolean, action?: MessageAction) => void
  markSaved: () => void
}

let counter = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`

const linkToEdge = (l: Link): FlowEdge => ({
  id: l.id,
  source: l.source,
  target: l.target,
  label: l.label ?? undefined,
  data: { label: l.label, detection: l.detection },
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
})

const componentToNode = ({ id, position, ...data }: Component): FlowNode => ({
  id,
  type: 'component',
  position,
  data,
})

const mapNode = (nodes: FlowNode[], id: string, f: (d: ComponentData) => ComponentData) =>
  nodes.map((n) => (n.id === id ? { ...n, data: f(n.data) } : n))

type TaskState = Pick<
  State,
  keyof TaskWorkspace | 'tasks' | 'activeTask' | 'taskWorkspaces' | 'closedTaskIds'
>

/** Restore layout and reopen its tab without stopping or retargeting processes. */
export function switchTaskWorkspace(
  s: TaskState,
  requested: string | null,
  exact = false,
): Partial<ProjectState> & { revealed?: null } {
  const activeTask = exact
    ? requested
    : (requested ?? s.tasks.find((t) => t.current && !t.missing)?.id ?? null)
  const task = s.tasks.find((t) => t.id === activeTask)
  if (activeTask && (!task || task.missing)) return {}
  const reopened =
    activeTask && s.closedTaskIds.includes(activeTask)
      ? { closedTaskIds: s.closedTaskIds.filter((id) => id !== activeTask) }
      : {}
  if (s.activeTask === activeTask) return reopened
  const taskWorkspaces = { ...s.taskWorkspaces, [s.activeTask ?? '']: taskWorkspace(s) }
  const restored = taskWorkspaces[activeTask ?? ''] ?? emptyTaskWorkspace(task?.components)
  return { activeTask, taskWorkspaces, ...restored, ...reopened, revealed: null }
}

/** Refresh task metadata while retaining closed tabs and dropping vanished or pinned ids. */
export function reconcileTaskList(s: TaskState, tasks: Task[]): Partial<ProjectState> {
  const closable = new Set(tasks.filter((t) => !t.current).map((t) => t.id))
  const closedTaskIds = s.closedTaskIds.filter((id) => closable.has(id))
  const keep = tasks.some((t) => t.id === s.activeTask && !t.missing)
  const switched = switchTaskWorkspace(
    { ...s, tasks, closedTaskIds },
    keep ? s.activeTask : null,
    s.activeTask === null && !!s.activeSession && sessionTask(s.activeSession) === null,
  )
  // Removed tasks' layouts would otherwise stay in the saved workspace for good.
  const known = new Set(['', ...tasks.map((t) => t.id)])
  const taskWorkspaces = Object.fromEntries(
    Object.entries(switched.taskWorkspaces ?? s.taskWorkspaces).filter(([id]) => known.has(id)),
  )
  return { tasks, closedTaskIds, ...switched, taskWorkspaces }
}

/** Where each node being dragged was before its drag, to tell whether the drag moved it. */
const dragOrigins = new Map<string, Component['position']>()

export const useStore = create<State>((set, get) => ({
  taskWorkspaces: {},
  rootTerminals: emptyTaskWorkspace().rootTerminals,
  componentTerminals: [],
  maximizedTerminal: null,
  addTaskComponentTerminal: (componentId, terminalId) =>
    set((s) => ({
      componentTerminals: s.componentTerminals.some(
        (t) => t.componentId === componentId && t.terminalId === terminalId,
      )
        ? s.componentTerminals
        : [...s.componentTerminals, { componentId, terminalId }],
      activeSession: sessionId(componentId, terminalId, s.activeTask),
      maximizedTerminal: null,
    })),
  removeTaskTerminal: (componentId, terminalId) =>
    set((s) => ({
      rootTerminals:
        componentId === TASK_ROOT_SCOPE
          ? s.rootTerminals.filter((t) => t.id !== terminalId)
          : s.rootTerminals,
      componentTerminals: s.componentTerminals.filter(
        (t) => t.componentId !== componentId || t.terminalId !== terminalId,
      ),
      maximizedTerminal:
        s.maximizedTerminal === sessionId(componentId, terminalId, s.activeTask)
          ? null
          : s.maximizedTerminal,
    })),
  setMaximizedTerminal: (maximizedTerminal) => set({ maximizedTerminal }),
  addRootTerminal: (device) => {
    const terminal: TerminalSpec = {
      id: newId(device?.id ?? 'shell'),
      name: device?.name ?? 'Shell',
      command: device?.command ?? '',
      kind: device?.kind ?? 'shell',
      ...(device?.adapter ? { adapter: device.adapter } : {}),
    }
    set((s) => ({
      rootTerminals: [...s.rootTerminals, terminal],
      activeSession: sessionId(TASK_ROOT_SCOPE, terminal.id, s.activeTask),
      maximizedTerminal: null,
    }))
    return terminal.id
  },
  patchTask: (projectId, task, patch) => {
    const s = get()
    const state = s.captureProjects()[projectId]?.state
    if (!state) return
    if (state.activeTask === task) s.patchProject(projectId, patch)
    else
      s.patchProject(projectId, {
        taskWorkspaces: {
          ...state.taskWorkspaces,
          [task ?? '']: {
            ...(state.taskWorkspaces[task ?? ''] ??
              emptyTaskWorkspace(state.tasks.find((t) => t.id === task)?.components)),
            ...patch,
          },
        },
      })
  },
  project: null,
  activeProjectId: null,
  projects: {},
  projectOrder: [],
  taskActivities: {},
  seenActivities: [],
  sessionRecords: [],
  serviceInstance: '',
  serviceConnected: false,
  serviceRetirement: 'idle',
  sessionsPanelOpen: false,
  activityPanelOpen: false,
  dockKept: [],
  reviewAgents: {},
  reviewFocus: null,
  reviewFindingsFocus: false,
  hideReviewAgent: (sid) =>
    set((s) =>
      s.project
        ? {
            reviewAgents: { ...s.reviewAgents, [s.project.id]: { sid, hidden: true } },
          }
        : {},
    ),
  keepInDock: (id) =>
    set((s) =>
      !showsInDock(sessionScope(s, id)) || s.dockKept.includes(id)
        ? {}
        : { dockKept: [...s.dockKept, id] },
    ),
  dropFromDock: (id) => set((s) => ({ dockKept: s.dockKept.filter((k) => k !== id) })),
  restoring: true,
  panels: {},
  setViewport: (viewport) => set({ viewport }),
  setPanelLayout: (id, layout) => set((s) => ({ panels: { ...s.panels, [id]: layout } })),
  captureProjects: () => {
    const s = get()
    if (!s.project) return s.projects
    return {
      ...s.projects,
      [s.project.id]: { ...s.projects[s.project.id], state: projectState(s) },
    }
  },
  patchProject: (id, patch) => {
    const s = get()
    if (s.project?.id === id) {
      set(patch as Partial<State>)
      return
    }
    const entry = s.projects[id]
    if (!entry?.state) return
    set({ projects: { ...s.projects, [id]: { ...entry, state: { ...entry.state, ...patch } } } })
  },
  activateProject: (id) => {
    const projects = get().captureProjects()
    const entry = projects[id]
    if (!entry) return
    setProjectIdentity(id)
    set({
      projects,
      ...(entry.state ?? emptyProjectState()),
      project: entry.state?.project ?? null,
      activeProjectId: id,
    } as Partial<State>)
  },
  closeProject: (id) => {
    forgetAutoDrafts(id)
    const projects = get().captureProjects()
    delete projects[id]
    const projectOrder = get().projectOrder.filter((p) => p !== id)
    const current = get().project?.id === id || get().activeProjectId === id
    if (current) {
      setProjectIdentity('')
      set({
        ...emptyProjectState(),
        activeProjectId: null,
        projects,
        projectOrder,
      })
      if (projectOrder[0]) get().activateProject(projectOrder[0])
    } else set({ projects, projectOrder })
  },
  nodes: [],
  edges: [],
  groups: [],
  graphActionBusy: false,
  graphAction: null,
  auto: null,
  graphActionReport: null,
  addGroup: (name, componentIds) =>
    set((s) => ({
      groups: [
        ...s.groups,
        {
          id: newId('group'),
          name,
          componentIds,
          orderedStartup: false,
          readinessTimeoutSeconds: 30,
        },
      ],
      dirty: true,
    })),
  updateGroup: (id, patch) =>
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
      dirty: true,
    })),
  removeGroup: (id) => set((s) => ({ groups: s.groups.filter((g) => g.id !== id), dirty: true })),
  extensions: { extensions: [], errors: [] },
  commands: [],
  menus: {},
  extensionBadges: {},
  extensionViews: {},
  workspaceSettings: {},
  notificationToast: null,
  notificationToastId: 0,
  setNotificationToast: (notificationToast) =>
    set((s) => ({
      notificationToast: mergeNotificationToast(s.notificationToast, notificationToast),
      notificationToastId: s.notificationToastId + 1,
    })),
  dismissNotificationSession: (sid) =>
    set((s) => ({ notificationToast: removeNotificationSession(s.notificationToast, sid) })),
  notifications: { ...DEFAULT_NOTIFICATIONS },
  setNotifications: (notifications) => set({ notifications }),
  runtimeTerminals: {},
  extensionsPanelOpen: false,
  paletteOpen: false,
  setExtensions: (extensions) => {
    const active = extensions.extensions.filter((e) => e.enabled && !e.errors.length)
    const menus: Record<string, MenuContribution[]> = {}
    for (const e of active)
      for (const [slot, entries] of Object.entries(e.manifest.contributes.menus))
        menus[slot] = [...(menus[slot] ?? []), ...entries]
    set({
      extensions,
      commands: active.flatMap((e) => e.manifest.contributes.commands),
      menus,
      extensionBadges: {},
      extensionViews: {},
    })
  },
  setExtensionBadges: (extensionBadges) => set({ extensionBadges }),
  setExtensionView: (id, html) =>
    set((s) => ({ extensionViews: { ...s.extensionViews, [id]: html } })),
  addRuntimeTerminal: (sid, terminal, focus = false) =>
    set((s) => ({
      runtimeTerminals: {
        ...s.runtimeTerminals,
        [sid]: { ...terminal, projectId: terminal.projectId ?? s.project?.id },
      },
      activeSession:
        focus && (!terminal.projectId || terminal.projectId === s.project?.id)
          ? sid
          : s.activeSession,
    })),
  setExtensionsPanelOpen: (extensionsPanelOpen) => set({ extensionsPanelOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  devices: [],
  sessions: {},
  gitChanges: {},
  repos: {},
  selectedId: null,
  selectedEdgeId: null,
  activeSession: null,
  inspector: null,
  dirty: false,
  message: '',
  messageId: 0,
  messageTransient: false,
  messageAction: null,
  simpleMode: false,
  simple: null,
  view: 'navigation',
  highlighted: [],
  implementationComponents: null,
  setImplementationScope: (implementationComponents) =>
    set({
      implementationComponents,
      highlighted: implementationComponents.filter((c) => c.visible).map((c) => c.id),
      revealed: null,
    }),
  planStartedWith: {},
  agentRoles: {},
  setAgentRoles: (agentRoles) => set({ agentRoles }),
  implementSubagents: 0,
  setImplementSubagents: (n) => set({ implementSubagents: isSubagentCount(n) ? n : 0 }),
  validatorDeclined: [],
  declineValidators: (keys) =>
    set((s) => ({
      validatorDeclined: liveDeclined(s.nodes, [...new Set([...s.validatorDeclined, ...keys])]),
    })),
  restoreValidators: () => set({ validatorDeclined: [] }),
  dependencyPromptDismissed: false,
  planActive: null,
  setPlanActive: (planActive) => set({ planActive }),
  revealed: null,
  setRevealed: (revealed) => set({ revealed }),
  tasks: [],
  activeTask: null,
  closedTaskIds: [],
  setTasks: (tasks) => set((s) => reconcileTaskList(s, tasks)),
  setActiveTask: (id, exact) => set((s) => switchTaskWorkspace(s, id, exact)),
  closeTaskTab: (id) =>
    set((s) => {
      const task = s.tasks.find((t) => t.id === id)
      if (!task || task.current || s.closedTaskIds.includes(id)) return {}
      const closedTaskIds = [...s.closedTaskIds, id]
      if (s.activeTask !== id) return { closedTaskIds }
      const visible = s.tasks.filter((t) => !t.missing && !s.closedTaskIds.includes(t.id))
      const index = visible.findIndex((t) => t.id === id)
      const next = visible[index + 1] ?? visible[index - 1]
      return { closedTaskIds, ...switchTaskWorkspace(s, next?.id ?? null) }
    }),
  newTask: null,
  setNewTask: (newTask) => set({ newTask }),
  autoPanelRequest: 0,
  showAutoPanel: () => set((s) => ({ autoPanelRequest: s.autoPanelRequest + 1 })),
  proposedScope: [],
  setProposedScope: (proposedScope) => set({ proposedScope }),

  loadProject: (p) => {
    const id = p.projectId ?? p.root
    if (get().projects[id]?.state) {
      get().activateProject(id)
      return
    }
    const projects = get().captureProjects()
    const state = {
      ...emptyProjectState(),
      project: { id, name: p.name, root: p.root },
      nodes: p.components.map(componentToNode),
      edges: p.links.map(linkToEdge),
      groups: p.groups ?? [],
    }
    setProjectIdentity(id)
    set({
      ...state,
      projects: { ...projects, [id]: { id, root: p.root, name: p.name, fingerprint: '', state } },
      projectOrder: [...get().projectOrder.filter((p) => p !== id), id],
      activeProjectId: id,
    })
  },

  syncProject: (p) =>
    set((s) => {
      if (p.projectId && p.projectId !== s.activeProjectId) {
        const entry = s.projects[p.projectId]
        if (!entry?.state) return {}
        return {
          projects: {
            ...s.projects,
            [p.projectId]: {
              ...entry,
              state: {
                ...entry.state,
                project: { id: p.projectId, name: p.name, root: p.root },
                nodes: p.components.map(componentToNode),
                edges: p.links.map(linkToEdge),
                groups: p.groups ?? [],
                dirty: true,
              },
            },
          },
        }
      }
      const selected = new Set(s.nodes.filter((n) => n.selected).map((n) => n.id))
      const selectedEdges = new Set(s.edges.filter((e) => e.selected).map((e) => e.id))
      return {
        project: { id: p.projectId ?? get().project?.id ?? p.root, name: p.name, root: p.root },
        nodes: p.components.map((c) => ({ ...componentToNode(c), selected: selected.has(c.id) })),
        edges: p.links.map((l) => ({ ...linkToEdge(l), selected: selectedEdges.has(l.id) })),
        groups: p.groups ?? [],
      }
    }),

  toProject: () => projectFrom(get()),

  onNodesChange: (changes) => {
    // Removal is a reviewed map edit: Canvas.onBeforeDelete runs removeComponents and
    // cancels React Flow's own removal, so a remove change never applies directly.
    changes = changes.filter((c) => c.type !== 'remove')
    set((s) => {
      const current = new Map(s.nodes.map((n) => [n.id, n.position]))
      let edits = false
      for (const c of changes) {
        if (c.type !== 'position') continue
        const now = current.get(c.id)
        if (!now) continue
        // A drag dirties the map once it ends away from where it started, so nothing keyed on
        // `dirty` (autosave, the workspace draft) sees a half-dragged position. A drag stop may
        // repeat the current position or only clear `dragging`.
        if (c.dragging) {
          if (!dragOrigins.has(c.id)) dragOrigins.set(c.id, now)
          continue
        }
        const from = dragOrigins.get(c.id) ?? now
        dragOrigins.delete(c.id)
        const to = c.position ?? now
        if (from.x !== to.x || from.y !== to.y) edits = true
      }
      return { nodes: applyNodeChanges(changes, s.nodes), dirty: s.dirty || edits }
    })
  },
  onEdgesChange: (changes) =>
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      dirty: s.dirty || changes.some((c) => c.type === 'remove'),
      selectedEdgeId: changes.some((c) => c.type === 'remove' && c.id === s.selectedEdgeId)
        ? null
        : s.selectedEdgeId,
    })),
  onConnect: (c) =>
    set((s) => ({
      edges: addEdge<FlowEdge>(
        linkToEdge({
          id: newId('link'),
          source: c.source,
          target: c.target,
          detection: { detector: 'manual' },
        }),
        s.edges,
      ),
      dirty: true,
    })),

  addComponent: (position) => {
    const id = newId('component')
    const node: FlowNode = {
      id,
      type: 'component',
      position,
      data: {
        name: 'New component',
        detection: { detector: 'manual' },
        kind: 'other',
        path: '.',
        notes: '',
        terminals: [{ id: 'shell', name: 'Shell', command: '', kind: 'shell' }],
      },
    }
    set((s) => ({
      nodes: [...s.nodes, node],
      selectedId: id,
      selectedEdgeId: null,
      inspector: null,
      dirty: true,
    }))
  },
  updateComponent: (id, patch) =>
    set((s) => ({ nodes: mapNode(s.nodes, id, (d) => ({ ...d, ...patch })), dirty: true })),

  addTerminal: (componentId, device, focus = true) => {
    const terminal: TerminalSpec = {
      id: newId(device?.id ?? 'task'),
      name: device?.name ?? 'Task',
      command: device?.command ?? '',
      kind: device?.kind ?? 'task',
      ...(device?.adapter ? { adapter: device.adapter } : {}),
      ...(device?.readyWhen ? { readyWhen: device.readyWhen } : {}),
    }
    set((s) => ({
      nodes: mapNode(s.nodes, componentId, (d) => ({
        ...d,
        terminals: [...d.terminals, terminal],
      })),
      activeSession: focus ? sessionId(componentId, terminal.id, s.activeTask) : s.activeSession,
      maximizedTerminal: focus ? null : s.maximizedTerminal,
      dirty: true,
    }))
    return terminal.id
  },
  updateTerminal: (componentId, terminalId, patch) =>
    set((s) => ({
      nodes: mapNode(s.nodes, componentId, (d) => ({
        ...d,
        terminals: d.terminals.map((t) => (t.id === terminalId ? { ...t, ...patch } : t)),
      })),
      dirty: true,
    })),
  removeTerminal: (componentId, terminalId, projectId = get().project?.id) => {
    if (!projectId) return
    const s = get()
    const state = s.captureProjects()[projectId]?.state
    if (!state) return
    const matches = (sid: string | null) => {
      const identity = sid ? sessionMetadata.get(sid) : undefined
      return (
        identity?.projectId === projectId &&
        identity.componentId === componentId &&
        identity.terminalId === terminalId
      )
    }
    s.patchProject(projectId, {
      nodes: mapNode(state.nodes, componentId, (d) => ({
        ...d,
        terminals: d.terminals.filter((t) => t.id !== terminalId),
      })),
      activeSession: matches(state.activeSession) ? null : state.activeSession,
      dirty: true,
    })
    if (s.project?.id === projectId && matches(s.revealed?.sid ?? null)) s.setRevealed(null)
  },

  setEdgeLabel: (id, label) =>
    set((s) => ({
      edges: s.edges.map((e) =>
        e.id === id ? { ...e, label: label || undefined, data: { ...e.data, label } } : e,
      ),
      dirty: true,
    })),

  // Highlights are the active task's saved scope, so switching views never changes them.
  setSimpleMode: (simpleMode) =>
    set((s) => ({
      simpleMode,
      simple: simpleMode ? (s.simple ?? { startedMs: Date.now(), log: [] }) : s.simple,
    })),
  setView: (view) =>
    set((s) => ({ view, simpleMode: view === 'navigation' ? s.simpleMode : false })),
  toggleHighlight: (id) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === id)) return {}
      const components =
        s.implementationComponents ?? s.highlighted.map((id) => ({ id, visible: true }))
      const implementationComponents = components.some((c) => c.id === id)
        ? components.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c))
        : [...components, { id, visible: true }]
      return {
        implementationComponents,
        highlighted: implementationComponents.filter((c) => c.visible).map((c) => c.id),
        revealed: null,
      }
    }),
  clearHighlights: () =>
    set((s) => ({
      highlighted: [],
      implementationComponents:
        s.implementationComponents?.map((c) => ({ ...c, visible: false })) ?? null,
      revealed: null,
    })),
  markPlanStarted: (sid, ids) =>
    set((s) => ({
      planStartedWith: { ...s.planStartedWith, [sid]: [...ids].sort().join(',') },
    })),

  select: (id) => {
    if (!id) return set({ selectedId: null })
    const current = get().activeSession
    const node = get().nodes.find((n) => n.id === id)
    const keep = current && sessionMetadata.get(current)?.componentId === id
    const first = node?.data.terminals[0]
    set({
      selectedId: id,
      selectedEdgeId: null,
      inspector: id === get().selectedId ? get().inspector : null,
      activeSession: keep ? current : first ? sessionId(id, first.id, get().activeTask) : null,
    })
  },
  selectEdge: (selectedEdgeId) =>
    set(
      selectedEdgeId && selectedEdgeId !== get().selectedEdgeId
        ? { selectedEdgeId, selectedId: null, inspector: null }
        : { selectedEdgeId, selectedId: null },
    ),
  // Revealing a session keeps it in the dock, even once it has exited.
  setActiveSession: (activeSession) =>
    set((s) => ({
      activeSession,
      reviewAgents:
        activeSession && s.project && isReviewAgentScope(sessionScope(s, activeSession))
          ? { ...s.reviewAgents, [s.project.id]: { sid: activeSession, hidden: false } }
          : s.reviewAgents,
      dockKept:
        activeSession &&
        showsInDock(sessionScope(s, activeSession)) &&
        !s.dockKept.includes(activeSession)
          ? [...s.dockKept, activeSession]
          : s.dockKept,
    })),
  setSession: (id, st) => set((s) => ({ sessions: { ...s.sessions, [id]: st } })),
  setGitChanges: (gitChanges) => set({ gitChanges }),
  setGitStatus: ({ changes, repos }) => set({ gitChanges: changes, repos }),
  setDevices: (devices) => set({ devices }),
  setMessage: (message, transient = false, action) =>
    set((s) => {
      const projectId = action?.projectId ?? s.project?.id
      const kept =
        message && s.messageAction?.persist && s.messageAction.projectId === s.project?.id
          ? s.messageAction
          : null
      return {
        message,
        messageTransient: transient,
        messageAction: action
          ? {
              ...action,
              projectId,
              run: () => {
                if (projectId && get().project?.id !== projectId) return
                // Its own feedback replaces it, rather than offering it again.
                set({ messageAction: null })
                action.run()
              },
            }
          : kept,
        messageId: s.messageId + 1,
      }
    }),
  markSaved: () => set({ dirty: false }),
}))

/** The live state for the active project, or its saved state for an inactive tab. */
export function projectStateOf(id: string, s = useStore.getState()): ProjectState | undefined {
  return s.project?.id === id ? s : s.projects[id]?.state
}

/** The map of open project `id`, whether or not its tab is active. */
export function projectOf(id: string): Project | null {
  const state = projectStateOf(id)
  return state?.project ? projectFrom(state) : null
}

/** Apply an ordinary map edit, keeping live state and marking either tab dirty for autosave. */
function editMap<T>(
  projectId: string | null | undefined,
  edit: (
    state: ProjectState,
  ) => { patch: Pick<Partial<ProjectState>, 'nodes' | 'edges'>; result: T } | null,
): T | null {
  const state = projectId ? projectStateOf(projectId) : undefined
  if (!projectId || !state?.project) return null
  const edited = edit(state)
  if (!edited) return null
  useStore.getState().patchProject(projectId, { ...edited.patch, dirty: true })
  return edited.result
}

/**
 * Append to open project `projectId`'s map as it is now, as an ordinary edit that autosaves and
 * keeps live session and git state. `extend` gets the current map and returns what to add, or null
 * for nothing; that is returned, else null when the project isn't open.
 */
export function appendToMap<T extends { components?: Component[]; links?: Link[] }>(
  projectId: string | null | undefined,
  extend: (current: Project) => T | null,
): T | null {
  return editMap(projectId, (state) => {
    const added = extend(projectFrom(state))
    return added
      ? {
          patch: {
            nodes: [...state.nodes, ...(added.components ?? []).map(componentToNode)],
            edges: [...state.edges, ...(added.links ?? []).map(linkToEdge)],
          },
          result: added,
        }
      : null
  })
}

/**
 * Move open project `projectId`'s components to `positions` (others stay), as an ordinary edit
 * that autosaves. Returns the positions the moved ones had, or null when none moved.
 */
export function moveComponents(
  projectId: string,
  positions: Record<string, Component['position']>,
): Record<string, Component['position']> | null {
  return editMap(projectId, (state) => {
    const previous: Record<string, Component['position']> = {}
    const nodes = state.nodes.map((c) => {
      const to = positions[c.id]
      if (!to || (to.x === c.position.x && to.y === c.position.y)) return c
      previous[c.id] = c.position
      return { ...c, position: to }
    })
    return Object.keys(previous).length ? { patch: { nodes }, result: previous } : null
  })
}

/** A project state as a `Project` (the map `patchbay.json` holds). */
export function projectFrom({
  project,
  nodes,
  edges,
  groups,
}: Pick<ProjectState, 'project' | 'nodes' | 'edges' | 'groups'>): Project {
  return {
    projectId: project?.id,
    schemaVersion: 4,
    name: project?.name ?? 'project',
    root: project?.root ?? '',
    components: nodes.map((n) => ({
      id: n.id,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      detection: n.data.detection,
      name: n.data.name,
      kind: n.data.kind,
      path: n.data.path,
      notes: n.data.notes,
      terminals: n.data.terminals,
    })),
    links: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.data?.label || null,
      detection: e.data?.detection,
    })),
    groups,
  }
}

function emptyProjectState(): ProjectState {
  return {
    taskWorkspaces: {},
    rootTerminals: emptyTaskWorkspace().rootTerminals,
    componentTerminals: [],
    maximizedTerminal: null,
    project: null,
    // Explicit, so loading a project without one doesn't keep the previous viewport.
    viewport: undefined,
    nodes: [],
    edges: [],
    selectedId: null,
    selectedEdgeId: null,
    activeSession: null,
    inspector: null,
    simpleMode: false,
    simple: null,
    view: 'navigation',
    highlighted: [],
    implementationComponents: null,
    planStartedWith: {},
    agentRoles: {},
    implementSubagents: 0,
    validatorDeclined: [],
    dependencyPromptDismissed: false,
    planActive: null,
    dirty: false,
    gitChanges: {},
    repos: {},
    extensionBadges: {},
    extensionViews: {},
    panels: {},
    groups: [],
    graphActionBusy: false,
    graphAction: null,
    auto: null,
    graphActionReport: null,
    tasks: [],
    activeTask: null,
    closedTaskIds: [],
  }
}
function projectState(s: State): ProjectState {
  const {
    project,
    nodes,
    edges,
    selectedId,
    selectedEdgeId,
    activeSession,
    inspector,
    simpleMode,
    simple,
    view,
    highlighted,
    implementationComponents,
    planStartedWith,
    agentRoles,
    implementSubagents,
    validatorDeclined,
    dependencyPromptDismissed,
    planActive,
    dirty,
    gitChanges,
    repos,
    extensionBadges,
    extensionViews,
    viewport,
    panels,
    groups,
    graphActionBusy,
    graphAction,
    auto,
    graphActionReport,
    tasks,
    activeTask,
    closedTaskIds,
    taskWorkspaces,
    rootTerminals,
    componentTerminals,
    maximizedTerminal,
  } = s
  return {
    project,
    nodes,
    edges,
    selectedId,
    selectedEdgeId,
    activeSession,
    inspector,
    simpleMode,
    simple,
    view,
    highlighted,
    implementationComponents,
    planStartedWith,
    agentRoles,
    implementSubagents,
    validatorDeclined,
    dependencyPromptDismissed,
    planActive,
    dirty,
    gitChanges,
    repos,
    extensionBadges,
    extensionViews,
    viewport,
    panels,
    groups,
    graphActionBusy,
    graphAction,
    auto,
    graphActionReport,
    tasks,
    activeTask,
    closedTaskIds,
    taskWorkspaces: { ...taskWorkspaces, [activeTask ?? '']: taskWorkspace(s) },
    rootTerminals,
    componentTerminals,
    maximizedTerminal,
  }
}

useStore.subscribe((s) => setProjectIdentity(s.project?.id ?? s.activeProjectId ?? ''))
