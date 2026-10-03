import { open } from '@tauri-apps/plugin-dialog'
import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { useStore } from '../store'
import type { Project } from '../types'
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
      const { project, detected } = await openProject(root)
      await closeComponentWindows()
      resetSessions(await terminalReset())
      s.loadProject(project)
      s.setMessage(
        detected
          ? `Detected ${project.components.length} component(s). Review, then Save to create patchbay.json.`
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
 * Add the components and links that `result` has beyond `before` (the map sent to the backend)
 * to the map as it is now, so edits made while the backend worked (or its dialog was open)
 * survive. Keeps live session and git state. Returns how many components were added.
 */
function applyAdded(before: Project, result: Project, none: string): number {
  const s = useStore.getState()
  const current = s.toProject()
  const oldIds = new Set(before.components.map((c) => c.id))
  const taken = new Set(current.components.map((c) => c.id))
  const paths = new Set(current.components.map((c) => c.path))
  const components = result.components.filter(
    (c) => !oldIds.has(c.id) && !taken.has(c.id) && !paths.has(c.path),
  )
  const ids = new Set([...taken, ...components.map((c) => c.id)])
  const added = new Set(components.map((c) => c.id))
  const linkIds = new Set(current.links.map((l) => l.id))
  const links = result.links.filter(
    (l) =>
      (added.has(l.source) || added.has(l.target)) &&
      ids.has(l.source) &&
      ids.has(l.target) &&
      !linkIds.has(l.id),
  )
  if (components.length === 0) {
    s.setMessage(none)
    return 0
  }
  const { sessions, gitChanges, repos, activeSession } = s
  s.loadProject({
    ...current,
    components: [...current.components, ...components],
    links: [...current.links, ...links],
  })
  useStore.setState({ sessions, gitChanges, repos, activeSession, dirty: true })
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
      const before = s.toProject()
      const { project } = await rescanProject(before)
      if (applyAdded(before, project, 'No new components found')) fitSoon(fitView)
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
      const before = s.toProject()
      const result = await addFolder(before)
      if (!result) return
      const none = 'Everything in that folder is already on the map'
      if (applyAdded(before, result.project, none)) fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}
