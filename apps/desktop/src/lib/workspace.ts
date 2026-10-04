import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useStore, type ProjectState } from '../store'
import type { OpenedProject, Project, WorkspaceDocument } from '../types'
import { quitPatchbay, workspaceLoad, workspaceSave } from './ipc'
import { openComponentWindow } from './windows'
import { reconcileSessions } from './sessions'

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
  return {
    projectId: state.project!.id,
    schemaVersion: 2,
    name: state.project!.name,
    root: state.project!.root,
    components: state.nodes.map(({ id, position, data }) => ({ id, position, ...data })),
    links: state.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.data?.label,
    })),
  }
}
export function workspaceDocument(): WorkspaceDocument {
  const s = useStore.getState()
  const projects = s.captureProjects()
  return {
    version: 1,
    activeProject: s.activeProjectId,
    windows: {},
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
              planActive: state.planActive,
              planStartedWith: state.planStartedWith,
              viewport: state.viewport,
              panels: state.panels,
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
function restoredLayout(layout: Record<string, unknown>): Partial<ProjectState> {
  const out: Partial<ProjectState> = {}
  if (['navigation', 'plan', 'implementation', 'review'].includes(String(layout.view)))
    out.view = layout.view as ProjectState['view']
  for (const key of ['selectedId', 'selectedEdgeId', 'activeSession', 'planActive'] as const)
    if (typeof layout[key] === 'string' || layout[key] === null)
      out[key] = layout[key] as string | null
  if (Array.isArray(layout.highlighted))
    out.highlighted = layout.highlighted.filter((i) => typeof i === 'string')
  if (layout.viewport && typeof layout.viewport === 'object') {
    const v = layout.viewport as ProjectState['viewport']
    if (v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0) out.viewport = v
  }
  if (layout.panels && typeof layout.panels === 'object')
    out.panels = layout.panels as ProjectState['panels']
  if (layout.planStartedWith && typeof layout.planStartedWith === 'object')
    out.planStartedWith = layout.planStartedWith as Record<string, string>
  return out
}
export function initializeWorkspace() {
  initialized ??= (async () => {
    try {
      const { document, opened, errors } = await workspaceLoad()
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
      await reconcileSessions()
      useStore.setState({ restoring: false })
      for (const saved of Object.values(document.windows ?? {})) {
        if (!saved.projectId || !saved.componentId) continue
        const entry = useStore.getState().captureProjects()[saved.projectId]
        const component = entry?.state?.nodes.find((n) => n.id === saved.componentId)
        if (component) await openComponentWindow(component.id, component.data.name, saved.projectId)
      }
    } catch (e) {
      // Keep an invalid document on disk for explicit recovery instead of autosaving over it.
      recoveryBlocked = true
      useStore.getState().setMessage(String(e))
    } finally {
      useStore.setState({ restoring: false })
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
          s.planActive === prev.planActive &&
          s.planStartedWith === prev.planStartedWith &&
          s.viewport === prev.viewport &&
          s.panels === prev.panels)
      )
        return
      clearTimeout(timer)
      timer = setTimeout(() => void flushWorkspace(), 500)
    })
    await listen('patchbay://quit-request', async () => {
      await flushWorkspace()
      await quitPatchbay(false)
    })
    await getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault()
      await flushWorkspace()
      await getCurrentWindow().destroy()
    })
  })()
  return initialized
}
