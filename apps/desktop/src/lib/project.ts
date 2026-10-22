import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { appendToMap, useStore } from '../store'
import type { Added } from '../types'
import { addFolder, openProject, projectClose } from './ipc'
import { acceptOpened, flushWorkspace } from './workspace'
import { syncCurrentRoots } from './access'
import { reviewRescan } from './maintenance'
import { flushMapSaves, saveMapNow } from './mapSave'
import { closeComponentWindows } from './windows'
import { forgetMainWorktree } from './mainWorktree'
import { runningInProject } from './sessionList'

const fitSoon = (fitView: ReturnType<typeof useReactFlow>['fitView']) =>
  requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1 }))

/**
 * Pick a folder and select its workspace tab, preserving running work.
 */
export function useOpenProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const s = useStore.getState()
    try {
      const opened = await openProject()
      if (!opened) return
      const { project, detected, locked } = opened
      acceptOpened(opened)
      s.setMessage(
        detected
          ? `Detected ${project.components.length} component(s). Review, then choose Project → Create map configuration. Later map edits save automatically.`
          : locked.length
            ? `Locked (folder missing or not allowed): ${locked.join(', ')}. Pick their folders with Browse… or Add repo….`
            : '',
      )
      if (detected) useStore.setState({ dirty: true })
      fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}

export async function saveCurrentProject() {
  const id = useStore.getState().activeProjectId
  if (id) await saveMapNow(id)
}

/**
 * Append what the backend added to the map as it is now, so edits made while it worked (or its
 * folder dialog was open) survive. A component whose id or folder the user took meanwhile is
 * dropped, with its links. Keeps live session and git state. Returns how many were added.
 */
export function applyAdded(
  added: Added,
  none: string,
  projectId = useStore.getState().activeProjectId,
): number {
  const applied = appendToMap(projectId, (current) => {
    const taken = new Set(current.components.map((c) => c.id))
    const paths = new Set(current.components.map((c) => c.path))
    const components = added.components.filter((c) => !taken.has(c.id) && !paths.has(c.path))
    if (components.length === 0) {
      useStore.getState().setMessage(none, true)
      return null
    }
    const fresh = new Set(added.components.map((c) => c.id))
    const kept = new Set(components.map((c) => c.id))
    // An end is either a component added now or one already on the map before the call.
    const valid = (id: string) => kept.has(id) || (!fresh.has(id) && taken.has(id))
    const linkIds = new Set(current.links.map((l) => l.id))
    const links = added.links.filter(
      (l) => valid(l.source) && valid(l.target) && !linkIds.has(l.id),
    )
    return { components, links }
  })
  if (!applied) return 0
  useStore.getState().setMessage(`Added ${applied.components.length} component(s)`, true)
  return applied.components.length
}

/** Review structural proposals; application remains explicit; existing configurations autosave. */
export function useRescanProject() {
  return useCallback(() => reviewRescan(), [])
}

/** Pick a repo beside the project (or a subfolder detection missed) and add its components. */
export function useAddFolder() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const s = useStore.getState()
    if (!s.project) return
    try {
      const added = await addFolder(s.toProject())
      if (!added) return
      if (applyAdded(added, 'Everything in that folder is already on the map', s.project.id))
        fitSoon(fitView)
      await syncCurrentRoots()
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}

/** Confirm running work, save the project's map, close its windows and remove its tab. */
export async function closeProjectTab(id: string) {
  const s = useStore.getState()
  const entry = s.projects[id]
  if (!entry) return
  const running = runningInProject(s.sessionRecords, s.sessions, id)
  if (
    running &&
    !window.confirm(
      `Close ${entry.name}? ${running} terminal(s) will keep running and remain available in Sessions.`,
    )
  )
    return
  try {
    if (!(await flushMapSaves(id))) {
      useStore
        .getState()
        .setMessage(
          'Map could not be saved. Retry or resolve the map conflict before closing this project.',
        )
      return
    }
    // Keep the tab available for retry if any pop-out or the backend's access and watcher
    // cannot close, so nothing is left running without a tab to close it from.
    await closeComponentWindows(id)
    await projectClose(id)
    useStore.getState().closeProject(id)
    forgetMainWorktree(id)
  } catch (e) {
    useStore.getState().setMessage(`Project close failed: ${e}`)
  } finally {
    try {
      await flushWorkspace()
    } catch (e) {
      useStore.getState().setMessage(`Workspace could not be saved: ${e}`)
    }
  }
}
