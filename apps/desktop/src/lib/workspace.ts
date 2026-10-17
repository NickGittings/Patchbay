import {
  mergeRestoredNotifications,
  restoredNotifications,
  sameNotifications,
} from './notificationSettings'
import { restoredAgentRoles } from './agentRoles'
import { restoredAuto } from './autoRestore'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emptyTaskWorkspace, projectFrom, useStore, type ProjectState } from '../store'
import type { OpenedProject, Project, WorkspaceDocument } from '../types'
import { quitPatchbay, workspaceLoad, workspaceSave } from './ipc'
import { openComponentWindow } from './windows'
import { reconcileSessions } from './sessions'
import { flushMapSaves, initializeMapAutosave } from './mapSave'

let initialized: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let writing = Promise.resolve()
let recoveryBlocked = false
export function acceptOpened(opened: OpenedProject) {
  const s = useStore.getState()
  s.loadProject({ ...opened.project, projectId: opened.id })
  useStore.setState((s) => ({
    projects: {
      ...s.projects,
      [opened.id]: {
        ...s.projects[opened.id],
        fingerprint: s.projects[opened.id].fingerprint || opened.fingerprint,
      },
    },
  }))
  if (opened.detected) useStore.setState({ dirty: true })
}
export function projectFromState(state: ProjectState): Project {
  return projectFrom(state)
}
export function workspaceDocument(): WorkspaceDocument {
  const s = useStore.getState()
  const projects = s.captureProjects()
  return {
    version: 1,
    activeProject: s.activeProjectId,
    windows: {},
    settings: { ...s.workspaceSettings, notifications: s.notifications },
    projects: s.projectOrder.map((id) => {
      const p = projects[id]
      const state = p.state
      return {
        id,
        root: p.root,
        name: p.name,
        savedFingerprint: p.conflict ? (p.draftFingerprint ?? p.fingerprint) : p.fingerprint,
        draft: p.conflict ?? (state?.dirty && state.project ? projectFromState(state) : null),
        layout: state
          ? {
              selectedId: state.selectedId,
              selectedEdgeId: state.selectedEdgeId,
              activeSession: state.activeSession,
              view: state.view,
              highlighted: state.highlighted,
              implementationComponents: state.implementationComponents,
              planActive: state.planActive,
              planStartedWith: state.planStartedWith,
              agentRoles: state.agentRoles,
              validatorDeclined: state.validatorDeclined,
              viewport: state.viewport,
              panels: state.panels,
              activeTask: state.activeTask,
              closedTaskIds: state.closedTaskIds,
              taskWorkspaces: state.taskWorkspaces,
              rootTerminals: state.rootTerminals,
              componentTerminals: state.componentTerminals,
              maximizedTerminal: state.maximizedTerminal,
              auto: state.auto,
              graphActionReport: state.graphActionReport,
              plannedFromProject: state.plannedFromProject,
            }
          : (p.unavailableLayout ?? {}),
      }
    }),
  }
}
export function flushWorkspace() {
  clearTimeout(timer)
  if (useStore.getState().restoring || recoveryBlocked) return writing
  const document = workspaceDocument()
  writing = writing
    .catch(() => {})
    .then(() => workspaceSave(document))
    .catch((e) => useStore.getState().setMessage(String(e)))
  return writing
}
export function restoredLayout(
  layout: Record<string, unknown>,
  nested = false,
): Partial<ProjectState> {
  const out: Partial<ProjectState> = {}
  out.auto = restoredAuto(layout.auto)
  if (!nested)
    out.closedTaskIds = Array.isArray(layout.closedTaskIds)
      ? [...new Set(layout.closedTaskIds.filter((id): id is string => typeof id === 'string'))]
      : []
  if (['navigation', 'plan', 'implementation', 'review'].includes(String(layout.view)))
    out.view = layout.view as ProjectState['view']
  // The active session belongs to the active task's scope, so both are restored together;
  // loading the task list drops a task that no longer exists.
  for (const key of [
    'selectedId',
    'selectedEdgeId',
    'activeSession',
    'planActive',
    'activeTask',
  ] as const)
    if (typeof layout[key] === 'string' || layout[key] === null)
      out[key] = layout[key] as string | null
  if (Array.isArray(layout.highlighted))
    out.highlighted = layout.highlighted.filter((i) => typeof i === 'string')
  if (layout.implementationComponents === null) out.implementationComponents = null
  else if (Array.isArray(layout.implementationComponents)) {
    const seen = new Set<string>()
    out.implementationComponents = layout.implementationComponents.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const c = value as { id?: unknown; visible?: unknown }
      if (typeof c.id !== 'string' || typeof c.visible !== 'boolean' || seen.has(c.id)) return []
      seen.add(c.id)
      return [{ id: c.id, visible: c.visible }]
    })
    out.highlighted = out.implementationComponents.filter((c) => c.visible).map((c) => c.id)
  }
  if (layout.viewport && typeof layout.viewport === 'object') {
    const v = layout.viewport as ProjectState['viewport']
    if (v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0) out.viewport = v
  }
  if (layout.panels && typeof layout.panels === 'object')
    out.panels = layout.panels as ProjectState['panels']
  if (layout.planStartedWith && typeof layout.planStartedWith === 'object')
    out.planStartedWith = layout.planStartedWith as Record<string, string>
  if (!nested) out.agentRoles = restoredAgentRoles(layout.agentRoles)
  if (!nested)
    out.validatorDeclined = Array.isArray(layout.validatorDeclined)
      ? [...new Set(layout.validatorDeclined.filter((k): k is string => typeof k === 'string'))]
      : []
  if (layout.graphActionReport && typeof layout.graphActionReport === 'object') {
    const report = layout.graphActionReport as ProjectState['graphActionReport']
    if (
      report &&
      Array.isArray(report.results) &&
      report.plan &&
      Array.isArray(report.plan.sessions) &&
      Array.isArray(report.plan.skipped)
    )
      out.graphActionReport = report
  }
  if (Array.isArray(layout.rootTerminals))
    out.rootTerminals = layout.rootTerminals.filter(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof t.id === 'string' &&
        typeof t.name === 'string' &&
        typeof t.command === 'string' &&
        ['shell', 'task', 'agent'].includes(t.kind),
    )
  if (Array.isArray(layout.componentTerminals))
    out.componentTerminals = layout.componentTerminals.filter(
      (t) =>
        t &&
        typeof t === 'object' &&
        typeof t.componentId === 'string' &&
        typeof t.terminalId === 'string',
    )
  if (typeof layout.maximizedTerminal === 'string' || layout.maximizedTerminal === null)
    out.maximizedTerminal = layout.maximizedTerminal
  if (typeof layout.plannedFromProject === 'boolean')
    out.plannedFromProject = layout.plannedFromProject
  if (!nested && layout.taskWorkspaces && typeof layout.taskWorkspaces === 'object') {
    out.taskWorkspaces = {}
    for (const [key, value] of Object.entries(layout.taskWorkspaces)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const restored = restoredLayout(value as Record<string, unknown>, true)
      out.taskWorkspaces[key] = { ...emptyTaskWorkspace(), ...restored }
    }
  }
  if (!nested)
    out.taskWorkspaces = {
      ...out.taskWorkspaces,
      [out.activeTask ?? '']: {
        ...emptyTaskWorkspace(),
        ...(out.taskWorkspaces?.[out.activeTask ?? ''] ?? {}),
        ...Object.fromEntries(
          Object.entries(out).filter(
            ([key]) =>
              ![
                'taskWorkspaces',
                'view',
                'activeTask',
                'closedTaskIds',
                'selectedId',
                'selectedEdgeId',
                'viewport',
                'planStartedWith',
                'agentRoles',
                'validatorDeclined',
              ].includes(key),
          ),
        ),
      },
    }
  return out
}
export function initializeWorkspace() {
  initialized ??= (async () => {
    // Settings changed during restore win over the saved ones and are saved once it ends.
    const initialNotifications = useStore.getState().notifications
    let restoredSettings: unknown
    // Listen before restoring: the backend defers every quit to this listener, so a slow
    // restore must not swallow Cmd+Q. Flushing is a no-op until restore finishes.
    await listen('patchbay://quit-request', async () => {
      await flushMapSaves()
      await flushWorkspace()
      await quitPatchbay()
    })
    await getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      await flushMapSaves()
      await flushWorkspace()
      await getCurrentWindow().destroy()
    })
    let loaded: Awaited<ReturnType<typeof workspaceLoad>> | undefined
    try {
      loaded = await workspaceLoad()
    } catch (e) {
      // Keep an invalid document on disk for explicit recovery instead of autosaving over it.
      recoveryBlocked = true
      useStore.getState().setMessage(String(e))
    }
    try {
      if (!loaded) return
      const { document, opened, errors } = loaded
      restoredSettings = document.settings?.notifications
      useStore.setState((s) => ({
        workspaceSettings: document.settings ?? {},
        notifications: mergeRestoredNotifications(
          restoredSettings,
          s.notifications,
          initialNotifications,
        ),
      }))
      for (const entry of document.projects) {
        const project = opened.find((p) => p.id === entry.id)
        if (!project) {
          useStore.setState((s) => ({
            projects: {
              ...s.projects,
              [entry.id]: {
                id: entry.id,
                root: entry.root,
                name: entry.name,
                fingerprint: entry.savedFingerprint,
                unavailable: errors[entry.id] ?? 'Folder unavailable',
                conflict: entry.draft ?? undefined,
                draftFingerprint: entry.savedFingerprint,
                unavailableLayout: entry.layout,
              },
            },
            projectOrder: [...s.projectOrder, entry.id],
          }))
          continue
        }
        acceptOpened(project)
        const matching = entry.draft && entry.savedFingerprint === project.fingerprint
        if (matching) {
          useStore
            .getState()
            .syncProject({ ...entry.draft!, root: project.project.root, projectId: project.id })
          useStore.setState({ dirty: true })
        }
        const conflict = entry.draft && !matching ? entry.draft : undefined
        useStore.setState((s) => ({
          ...restoredLayout(entry.layout),
          projects: {
            ...s.projects,
            [entry.id]: {
              ...s.projects[entry.id],
              conflict,
              draftFingerprint: entry.savedFingerprint,
            },
          },
        }))
      }
      if (document.activeProject && useStore.getState().projects[document.activeProject])
        useStore.getState().activateProject(document.activeProject)
      // The service may still be starting; the periodic reconcile catches up later.
      await reconcileSessions().catch(() => {})
      useStore.setState({ restoring: false })
      for (const saved of Object.values(document.windows ?? {})) {
        if (!saved.projectId || !saved.componentId) continue
        const entry = useStore.getState().captureProjects()[saved.projectId]
        const component = entry?.state?.nodes.find((n) => n.id === saved.componentId)
        if (component)
          await openComponentWindow(component.id, component.data.name, saved.projectId).catch((e) =>
            useStore.getState().setMessage(String(e)),
          )
      }
    } catch (e) {
      useStore.getState().setMessage(String(e))
    } finally {
      useStore.setState({ restoring: false })
      if (!recoveryBlocked) initializeMapAutosave()
    }
    useStore.subscribe((s, prev) => {
      if (
        s.restoring ||
        (s.nodes === prev.nodes &&
          s.edges === prev.edges &&
          s.dirty === prev.dirty &&
          s.activeProjectId === prev.activeProjectId &&
          s.projects === prev.projects &&
          s.selectedId === prev.selectedId &&
          s.selectedEdgeId === prev.selectedEdgeId &&
          s.activeSession === prev.activeSession &&
          s.view === prev.view &&
          s.highlighted === prev.highlighted &&
          s.implementationComponents === prev.implementationComponents &&
          s.planActive === prev.planActive &&
          s.planStartedWith === prev.planStartedWith &&
          s.agentRoles === prev.agentRoles &&
          s.validatorDeclined === prev.validatorDeclined &&
          s.notifications === prev.notifications &&
          s.workspaceSettings === prev.workspaceSettings &&
          s.viewport === prev.viewport &&
          s.panels === prev.panels &&
          s.groups === prev.groups &&
          s.activeTask === prev.activeTask &&
          s.closedTaskIds === prev.closedTaskIds &&
          s.auto === prev.auto &&
          s.taskWorkspaces === prev.taskWorkspaces &&
          s.rootTerminals === prev.rootTerminals &&
          s.componentTerminals === prev.componentTerminals &&
          s.maximizedTerminal === prev.maximizedTerminal &&
          s.plannedFromProject === prev.plannedFromProject)
      )
        return
      clearTimeout(timer)
      timer = setTimeout(() => void flushWorkspace(), 500)
    })
    // The subscription above missed edits made while restoring.
    if (
      !sameNotifications(useStore.getState().notifications, restoredNotifications(restoredSettings))
    ) {
      clearTimeout(timer)
      timer = setTimeout(() => void flushWorkspace(), 500)
    }
  })()
  return initialized
}
