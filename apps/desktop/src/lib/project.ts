import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { useStore } from '../store'
import type { Added } from '../types'
import { addFolder, openProject } from './ipc'
import { acceptOpened, projectFromState } from './workspace'
import { syncCurrentRoots } from './access'
import { reviewRescan } from './maintenance'
import { saveMapNow } from './mapSave'

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
  const s = useStore.getState()
  const state = projectId ? s.captureProjects()[projectId]?.state : undefined
  if (!state?.project) return 0
  const current = projectFromState(state)
  const taken = new Set(current.components.map((c) => c.id))
  const paths = new Set(current.components.map((c) => c.path))
  const components = added.components.filter((c) => !taken.has(c.id) && !paths.has(c.path))
  if (components.length === 0) {
    s.setMessage(none, true)
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
  s.setMessage(`Added ${components.length} component(s)`, true)
  return components.length
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
