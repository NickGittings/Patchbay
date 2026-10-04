import ExtensionMenu from '../extensions/ExtensionMenu'
import { useReactFlow } from '@xyflow/react'
import { useEffect } from 'react'
import { saveCurrentProject, useAddFolder, useOpenProject, useRescanProject } from '../lib/project'
import { useStore } from '../store'
import type { View } from '../types'

const views: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Implementation' },
]

export default function Toolbar() {
  const project = useStore((s) => s.project)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const dirty = useStore((s) => s.dirty)
  const message = useStore((s) => s.message)
  const openFolder = useOpenProject()
  const rescan = useRescanProject()
  const addRepo = useAddFolder()
  const { screenToFlowPosition } = useReactFlow()

  const addComponent = () =>
    useStore
      .getState()
      .addComponent(screenToFlowPosition({ x: window.innerWidth / 2.5, y: window.innerHeight / 3 }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      if ((e.metaKey || e.ctrlKey) && s.project) {
        const target = views[Number(e.key) - 1]
        if (target && ['1', '2', '3'].includes(e.key)) {
          e.preventDefault()
          s.setView(target.id)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void saveCurrentProject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="toolbar">
      <span className="brand">Patchbay</span>
      <button onClick={() => void openFolder()}>Open folder…</button>
      {project && (
        <>
          <button onClick={() => void rescan()} title="Add components for new folders">
            Rescan
          </button>
          <button
            onClick={() => void addRepo()}
            title="Add a repo beside this project, or a folder Rescan missed"
          >
            Add repo…
          </button>
          {view === 'navigation' && <button onClick={addComponent}>+ Component</button>}
          <div className="view-switcher" role="group" aria-label="Workspace view">
            {views.map((v, i) => (
              <button
                key={v.id}
                aria-pressed={view === v.id}
                className={view === v.id ? 'active' : ''}
                title={`${v.label} (⌘${i + 1} / Ctrl+${i + 1})`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </>
      )}
      <ExtensionMenu slot="toolbar" />
      <button onClick={() => useStore.getState().setPaletteOpen(true)} title="Cmd/Ctrl+Shift+P">
        Commands
      </button>
      <button onClick={() => useStore.getState().setExtensionsPanelOpen(true)}>Extensions</button>
      <span className="spacer" />
      {message && <span className="message">{message}</span>}
      {project && (
        <>
          <span className="file" title={project.root}>
            {project.name}
            {dirty && <span className="dirty" title="Unsaved changes" />}
          </span>
          <button className="primary" onClick={() => void saveCurrentProject()}>
            Save
          </button>
        </>
      )}
    </div>
  )
}
