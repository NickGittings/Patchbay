import { create } from 'zustand'
import { projectOf, useStore } from '../store'
import type { MapEdit, MapIssue, Project, ReconciliationPreview } from '../types'
import {
  applyReconciliation,
  cleanupComponentScopes,
  editMapComponents,
  mapIssues,
  onFileAccessChanged,
  releaseMapEdit,
  rescanProject,
} from './ipc'
import { syncProjectRoots } from './access'

interface ReviewState {
  projectId: string
  draft: string
  preview: ReconciliationPreview
}
interface MaintenanceState {
  issues: Record<string, MapIssue[]>
  review: ReviewState | null
  busy: boolean
}
export const useMaintenance = create<MaintenanceState>(() => ({
  issues: {},
  review: null,
  busy: false,
}))
const signature = (project: Project) => JSON.stringify(project)
function messageFor(projectId: string | undefined, text: string, transient = false) {
  if (projectId && useStore.getState().project?.id === projectId)
    useStore.getState().setMessage(text, transient)
}
const issueRequests = new Map<string, number>()
export async function refreshMapIssues(projectId = useStore.getState().project?.id) {
  if (!projectId) return
  const project = projectOf(projectId)
  if (!project) return
  const request = (issueRequests.get(projectId) ?? 0) + 1
  issueRequests.set(projectId, request)
  const issues = await mapIssues(project)
  const current = projectOf(projectId)
  if (
    request !== issueRequests.get(projectId) ||
    !current ||
    signature(current) !== signature(project)
  )
    return
  useMaintenance.setState((s) => ({ issues: { ...s.issues, [projectId]: issues } }))
}
export async function reviewRescan() {
  const project = useStore.getState().toProject()
  if (!project.projectId || useMaintenance.getState().busy) return
  useMaintenance.setState({ busy: true })
  try {
    const preview = await rescanProject(project)
    const current = projectOf(project.projectId)
    if (!current || signature(current) !== signature(project))
      throw new Error('The draft changed; rescan again')
    useMaintenance.setState((s) => ({
      issues: { ...s.issues, [project.projectId!]: preview.issues },
      review: { projectId: project.projectId!, draft: signature(project), preview },
    }))
  } catch (e) {
    messageFor(project.projectId, String(e))
  } finally {
    useMaintenance.setState({ busy: false })
  }
}
export function closeMapReview() {
  useMaintenance.setState({ review: null })
}

/**
 * Apply a checked edit. The map changes in one synchronous step right after the draft is checked,
 * so no other edit can slip in between; follow-ups after that only report their errors. A failed
 * scope cleanup leaves only ids of components that no longer exist in `tasks.json`.
 */
async function acceptEdit(before: Project, edit: MapEdit) {
  const id = before.projectId!
  try {
    const current = projectOf(id)
    if (!current || signature(current) !== signature(before))
      throw new Error('The draft changed while checking work; retry the edit')
    const draft = { ...edit.project, projectId: id }
    const removed = before.components
      .filter((c) => !draft.components.some((n) => n.id === c.id))
      .map((c) => c.id)
    const s = useStore.getState()
    const state = s.captureProjects()[id]?.state
    s.syncProject(draft)
    s.patchProject(id, {
      dirty: true,
      ...(state
        ? {
            tasks: state.tasks.map((t) => ({
              ...t,
              components: t.components.filter((c) => !removed.includes(c)),
            })),
            highlighted: state.highlighted.filter((c) => !removed.includes(c)),
            selectedId: removed.includes(state.selectedId ?? '') ? null : state.selectedId,
          }
        : {}),
    })
    await (removed.length ? cleanupComponentScopes(draft, removed) : Promise.resolve())
      .catch((e) => messageFor(id, `Couldn't update task scopes: ${String(e)}`))
      .then(() => syncProjectRoots(id))
      .then(() => refreshMapIssues(id))
      .catch((e) => messageFor(id, String(e)))
  } finally {
    if (edit.lease) await releaseMapEdit(id, edit.lease)
  }
}
export async function applyMapReview(selected: string[]) {
  const review = useMaintenance.getState().review
  if (!review || useMaintenance.getState().busy) return
  useMaintenance.setState({ busy: true })
  try {
    const before = projectOf(review.projectId)
    if (!before || signature(before) !== review.draft)
      throw new Error('The draft changed; refresh the preview')
    const edit = await applyReconciliation(before, review.preview.id, selected)
    await acceptEdit(before, edit)
    closeMapReview()
    messageFor(
      review.projectId,
      'Applied selected map changes. Existing map configurations save automatically.',
      true,
    )
  } catch (e) {
    messageFor(review.projectId, String(e))
  } finally {
    useMaintenance.setState({ busy: false })
  }
}
export async function repairComponentPath(
  componentId: string,
  path: string,
  projectId = useStore.getState().project?.id,
) {
  const before = projectId ? projectOf(projectId) : null
  if (!before?.projectId) return false
  try {
    const edit = await editMapComponents(before, [], componentId, path)
    await acceptEdit(before, edit)
    return true
  } catch (e) {
    messageFor(before.projectId, String(e))
    return false
  }
}
export async function removeComponents(
  ids: string[],
  projectId = useStore.getState().project?.id,
): Promise<boolean> {
  const before = projectId ? projectOf(projectId) : null
  if (!before?.projectId) return false
  try {
    const edit = await editMapComponents(before, ids)
    await acceptEdit(before, edit)
    return true
  } catch (e) {
    messageFor(before.projectId, String(e))
    return false
  }
}

/** Check on workspace open and folder/access changes, never replacing the map. */
export function startMaintenanceChecks() {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    const id = useStore.getState().project?.id
    timer = setTimeout(() => void refreshMapIssues(id).catch((e) => messageFor(id, String(e))), 200)
  }
  const stop = useStore.subscribe((s, prev) => {
    if (
      s.project?.id !== prev.project?.id ||
      (s.nodes !== prev.nodes &&
        JSON.stringify(s.nodes.map((n) => [n.id, n.data.path])) !==
          JSON.stringify(prev.nodes.map((n) => [n.id, n.data.path])))
    )
      schedule()
  })
  const listener = onFileAccessChanged(schedule)
  schedule()
  return () => {
    stop()
    clearTimeout(timer)
    void listener.then((unlisten) => unlisten())
  }
}
export const provenanceLabel = (detector?: string) =>
  detector === 'builtin'
    ? 'Built-in detector'
    : detector === 'manual'
      ? 'Manual'
      : detector?.startsWith('extension:')
        ? detector.slice('extension:'.length)
        : (detector ?? 'Unclassified')
