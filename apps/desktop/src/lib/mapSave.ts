import { projectFrom, useStore, type MapSaveState, type ProjectEntry } from '../store'
import { reloadProject, saveProject } from './ipc'

const DELAY = 750
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const writing = new Map<string, Promise<boolean>>()
const observed = new Map<string, string>()
let unsubscribe: (() => void) | undefined
let reconciling = false
const created = new Set<(id: string) => void>()

/** A map that needs recovery (conflicted, or its folder unavailable) takes no edits or saves. */
export const mapBlocked = (entry: Pick<ProjectEntry, 'conflict' | 'unavailable'> | undefined) =>
  !!entry?.conflict || !!entry?.unavailable

/** Map edits and dependency reviews must also wait for saved-map conflicts to be resolved. */
export const mapEditsBlocked = (entry: ProjectEntry | undefined) =>
  mapBlocked(entry) || entry?.mapSave?.status === 'conflict'

/** Call `listener` with a project's id once its first `patchbay.json` is written. */
export function onMapCreated(listener: (id: string) => void) {
  created.add(listener)
  return () => void created.delete(listener)
}

function entryFor(id: string) {
  return useStore.getState().captureProjects()[id]
}
function payload(entry: ProjectEntry) {
  return entry.state?.project ? projectFrom(entry.state) : undefined
}
function dragging(entry: ProjectEntry) {
  return entry.state?.nodes.some((n) => n.dragging)
}
function setStatus(id: string, mapSave: MapSaveState | undefined) {
  useStore.setState((s) => {
    const entry = s.projects[id]
    return entry ? { projects: { ...s.projects, [id]: { ...entry, mapSave } } } : {}
  })
}
function clearTimer(id: string) {
  clearTimeout(timers.get(id))
  timers.delete(id)
}

/** Watch persisted map payloads, not terminal output, selection or other workspace layout. */
function reconcile() {
  if (reconciling || useStore.getState().restoring) return
  reconciling = true
  try {
    const entries = useStore.getState().captureProjects()
    for (const id of observed.keys()) {
      if (!entries[id]) {
        clearTimer(id)
        observed.delete(id)
      }
    }
    for (const [id, entry] of Object.entries(entries)) {
      const map = payload(entry)
      if (!map) continue
      if (dragging(entry)) {
        clearTimer(id)
        continue
      }
      const signature = JSON.stringify(map)
      const changed = observed.get(id) !== signature
      observed.set(id, signature)
      if (
        !entry.state?.dirty ||
        !entry.fingerprint ||
        entry.fingerprint === 'absent' ||
        entry.unavailable ||
        entry.conflict ||
        writing.has(id) ||
        entry.mapSave?.status === 'error' ||
        entry.mapSave?.status === 'conflict'
      ) {
        clearTimer(id)
        continue
      }
      if (!changed && timers.has(id)) continue
      clearTimer(id)
      if (entry.mapSave?.status !== 'pending') setStatus(id, { status: 'pending' })
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          void saveMap(id)
        }, DELAY),
      )
    }
  } finally {
    reconciling = false
  }
}

export function initializeMapAutosave() {
  unsubscribe ??= useStore.subscribe((s, previous) => {
    if (
      s.nodes !== previous.nodes ||
      s.edges !== previous.edges ||
      s.groups !== previous.groups ||
      s.project !== previous.project ||
      s.projects !== previous.projects ||
      s.dirty !== previous.dirty ||
      s.restoring !== previous.restoring
    )
      reconcile()
  })
  reconcile()
}

/** Explicit calls may create the first file. Only conflict resolution may replace a changed map. */
export function saveMap(id: string, replace = false): Promise<boolean> {
  clearTimer(id)
  const pending = writing.get(id)
  if (pending) return pending
  const task = Promise.resolve()
    .then(async () => {
      const s = useStore.getState()
      const entry = entryFor(id)
      const captured = entry && payload(entry)
      if (
        s.restoring ||
        !entry ||
        !captured ||
        entry.unavailable ||
        entry.conflict ||
        dragging(entry)
      )
        return false
      if (entry.mapSave?.status === 'conflict' && !replace) return false
      setStatus(id, { status: 'saving' })
      const first = entry.fingerprint === 'absent'
      try {
        const result = await saveProject(captured, replace ? null : entry.fingerprint)
        if (!entryFor(id)) return false
        if (result.status === 'conflict') {
          setStatus(id, {
            status: 'conflict',
            error: 'patchbay.json changed outside Patchbay. Choose which map to keep.',
          })
          return false
        }
        const current = entryFor(id)!
        const matching = JSON.stringify(payload(current)) === JSON.stringify(captured)
        // patchProject updates inactive projects too; completion must never clean another tab.
        useStore.getState().patchProject(id, { dirty: !matching })
        useStore.setState((s) => ({
          projects: {
            ...s.projects,
            [id]: {
              ...s.projects[id],
              fingerprint: result.fingerprint,
              mapSave: matching ? undefined : { status: 'pending' },
            },
          },
        }))
        if (first) for (const listener of created) listener(id)
        return true
      } catch (error) {
        setStatus(id, { status: 'error', error: String(error) })
        return false
      }
    })
    .finally(() => {
      writing.delete(id)
      reconcile()
    })
  writing.set(id, task)
  return task
}

/** Manual Save now includes edits made while an earlier write was still in flight. */
export async function saveMapNow(id: string, replace = false) {
  return (await saveMap(id, replace)) && (await flushMapSaves(id))
}

/** Flush existing configurations; absent files still require the explicit first save. */
export async function flushMapSaves(id?: string): Promise<boolean> {
  const ids = id ? [id] : Object.keys(useStore.getState().projects)
  let success = true
  for (const key of ids) {
    clearTimer(key)
    if (writing.has(key)) await writing.get(key)
    let entry = entryFor(key)
    if (entry?.unavailable) continue
    if (
      entry?.conflict ||
      entry?.mapSave?.status === 'conflict' ||
      (entry?.fingerprint === 'absent' && entry.mapSave?.status === 'error')
    ) {
      success = false
      continue
    }
    while (
      entry?.state?.dirty &&
      entry.fingerprint &&
      entry.fingerprint !== 'absent' &&
      !entry.unavailable
    ) {
      if (!(await saveMap(key))) {
        success = false
        break
      }
      entry = entryFor(key)
    }
  }
  return success
}

export async function reloadSavedMap(id: string) {
  try {
    const opened = await reloadProject(id)
    if (!entryFor(id)) return
    useStore.getState().syncProject({ ...opened.project, projectId: id })
    useStore.getState().patchProject(id, { dirty: opened.detected })
    useStore.setState((s) => ({
      projects: {
        ...s.projects,
        [id]: {
          ...s.projects[id],
          fingerprint: opened.fingerprint,
          mapSave: undefined,
          conflict: undefined,
          draftFingerprint: undefined,
        },
      },
    }))
  } catch (error) {
    // Keep the conflict blocked when reloading an invalid or unavailable saved map.
    const status = entryFor(id)?.mapSave?.status === 'conflict' ? 'conflict' : 'error'
    setStatus(id, { status, error: String(error) })
  }
}

/** Used by tests and hot reload to dispose pending callbacks. */
export function disposeMapAutosave() {
  unsubscribe?.()
  unsubscribe = undefined
  for (const id of timers.keys()) clearTimer(id)
  observed.clear()
}
if (import.meta.hot) import.meta.hot.dispose(disposeMapAutosave)
