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

/** Swap in a map with extra components, keeping live session and git state. */
function applyAdded(project: Project, added: number, none: string) {
  const s = useStore.getState()
  if (added === 0) return s.setMessage(none)
  const { sessions, gitChanges, repos, activeSession } = s
  s.loadProject(project)
  useStore.setState({ sessions, gitChanges, repos, activeSession, dirty: true })
  s.setMessage(`Added ${added} component(s)`)
}

/** Add components for folders that appeared since the map was made, here or in added repos. */
export function useRescanProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const s = useStore.getState()
    if (!s.project) return
    try {
      const { project, added } = await rescanProject(s.toProject())
      applyAdded(project, added, 'No new components found')
      if (added) fitSoon(fitView)
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
      const result = await addFolder(s.toProject())
      if (!result) return
      applyAdded(result.project, result.added, 'Everything in that folder is already on the map')
      if (result.added) fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}
