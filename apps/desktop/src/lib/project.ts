import { invoke } from '@tauri-apps/api/core'
import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { useStore } from '../store'
import type { Added } from '../types'
import { addFolder, openProject, rescanProject, saveProject } from './ipc'
import { acceptOpened, projectFromState } from './workspace'
import { syncCurrentRoots } from './access'

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
          ? `Detected ${project.components.length} component(s). Review, then Save to create patchbay.json.`
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
  const s = useStore.getState()
  if (!s.project) return
  const captured = s.toProject()
  try {
    const path = await saveProject(captured)
    const current = useStore.getState()
    if (
      current.project?.id === s.project.id &&
      JSON.stringify(current.toProject()) === JSON.stringify(captured)
    )
      s.markSaved()
    const fingerprint = await invoke<string>('project_fingerprint', { projectId: s.project.id })
    useStore.setState((current) => ({
      projects: {
        ...current.projects,
        [s.project!.id]: { ...current.projects[s.project!.id], fingerprint },
      },
    }))
    s.setMessage(`Saved ${path.split(/[\\/]/).pop()}`)
  } catch (e) {
    s.setMessage(String(e))
  }
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
  const s = useStore.getState()
  const state = projectId ? s.captureProjects()[projectId]?.state : undefined
  if (!state?.project) return 0
  const current = projectFromState(state)
  const taken = new Set(current.components.map((c) => c.id))
  const paths = new Set(current.components.map((c) => c.path))
  const components = added.components.filter((c) => !taken.has(c.id) && !paths.has(c.path))
  if (components.length === 0) {
    s.setMessage(none)
    return 0
  }
  const fresh = new Set(added.components.map((c) => c.id))
  const kept = new Set(components.map((c) => c.id))
  // An end is either a component added now or one already on the map before the call.
  const valid = (id: string) => kept.has(id) || (!fresh.has(id) && taken.has(id))
  const linkIds = new Set(current.links.map((l) => l.id))
  const links = added.links.filter((l) => valid(l.source) && valid(l.target) && !linkIds.has(l.id))
  s.syncProject({
    ...current,
    components: [...current.components, ...components],
    links: [...current.links, ...links],
  })
  if (s.activeProjectId === projectId) useStore.setState({ dirty: true })
  s.setMessage(`Added ${components.length} component(s)`)
  return components.length
}

/** Add components for folders that appeared since the map was made, here or in added repos. */
export function useRescanProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const s = useStore.getState()
    if (!s.project) return
    try {
      const added = await rescanProject(s.toProject())
      if (applyAdded(added, 'No new components found', s.project.id)) fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
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
