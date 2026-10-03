import { useReactFlow } from '@xyflow/react'
import { useEffect } from 'react'
import { saveCurrentProject, useOpenProject, useRescanProject } from '../lib/project'
import { useStore } from '../store'

export default function Toolbar() {
  const project = useStore((s) => s.project)
  const dirty = useStore((s) => s.dirty)
  const message = useStore((s) => s.message)
  const openFolder = useOpenProject()
  const rescan = useRescanProject()
  const { screenToFlowPosition } = useReactFlow()

  const addComponent = () =>
    useStore
      .getState()
      .addComponent(screenToFlowPosition({ x: window.innerWidth / 2.5, y: window.innerHeight / 3 }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
          <button onClick={addComponent}>+ Component</button>
        </>
      )}
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
