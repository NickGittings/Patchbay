import { open } from '@tauri-apps/plugin-dialog'
import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { useStore } from '../store'
import type { Added } from '../types'
import { addFolder, openProject, rescanProject, saveProject, terminalReset } from './ipc'
import { resetSessions } from './sessions'
import { closeComponentWindows } from './windows'

const fitSoon = (fitView: ReturnType<typeof useReactFlow>['fitView']) =>
  requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1 }))

/**
 * Pick a folder, close the current project's pop-outs and terminals (session ids aren't
 * project-scoped, so no history may carry over), and load the new map.
 */
export function useOpenProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const root = await open({ directory: true, multiple: false })
    if (typeof root !== 'string') return
    const s = useStore.getState()
    try {
      const { project, detected, locked } = await openProject(root)
      await closeComponentWindows()
      resetSessions(await terminalReset())
      s.loadProject(project)
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
  try {
    const path = await saveProject(s.toProject())
    s.markSaved()
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
function applyAdded(added: Added, none: string): number {
  const s = useStore.getState()
  const current = s.toProject()
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
  const { sessions, gitChanges, repos, activeSession, view, highlighted, planStartedWith } = s
  s.loadProject({
    ...current,
    components: [...current.components, ...components],
    links: [...current.links, ...links],
  })
  useStore.setState({
    sessions,
    gitChanges,
    repos,
    activeSession,
    view,
    highlighted,
    planStartedWith,
    dirty: true,
  })
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
      if (applyAdded(added, 'No new components found')) fitSoon(fitView)
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
      if (applyAdded(added, 'Everything in that folder is already on the map')) fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}
