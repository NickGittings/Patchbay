import { open } from '@tauri-apps/plugin-dialog'
import { useReactFlow } from '@xyflow/react'
import { useCallback } from 'react'
import { useStore } from '../store'
import { openProject, rescanProject, saveProject, terminalStopAll } from './ipc'
import { disposeAll } from './terminals'

const fitSoon = (fitView: ReturnType<typeof useReactFlow>['fitView']) =>
  requestAnimationFrame(() => void fitView({ padding: 0.25, maxZoom: 1 }))

/** Pick a folder, stop the current project's terminals, and load the new map. */
export function useOpenProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const root = await open({ directory: true, multiple: false })
    if (typeof root !== 'string') return
    const s = useStore.getState()
    try {
      const { project, detected } = await openProject(root)
      await terminalStopAll()
      disposeAll()
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

/** Add components for folders that appeared since the map was made. */
export function useRescanProject() {
  const { fitView } = useReactFlow()
  return useCallback(async () => {
    const s = useStore.getState()
    if (!s.project) return
    try {
      const { project, added } = await rescanProject(s.toProject())
      if (added === 0) return s.setMessage('No new components found')
      const { sessions, gitChanges, activeSession } = useStore.getState()
      s.loadProject(project)
      useStore.setState({ sessions, gitChanges, activeSession, dirty: true })
      s.setMessage(`Added ${added} component(s)`)
      fitSoon(fitView)
    } catch (e) {
      s.setMessage(String(e))
    }
  }, [fitView])
}
