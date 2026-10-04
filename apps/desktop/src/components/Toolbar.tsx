import { useExtensionCommands } from '../extensions/commands'
import { useReactFlow } from '@xyflow/react'
import { useEffect } from 'react'
import { saveCurrentProject, useAddFolder, useOpenProject, useRescanProject } from '../lib/project'
import { useStore } from '../store'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import Toast from './Toast'
import AttentionMenu from './status/AttentionMenu'
import type { View } from '../types'

const views: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'review', label: 'Review' },
]

const mac = /mac/i.test(navigator.userAgent)
const mod = mac ? '⌘' : 'Ctrl+'
const shiftMod = mac ? '⇧⌘' : 'Ctrl+Shift+'

export default function Toolbar() {
  const project = useStore((s) => s.project)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const dirty = useStore((s) => s.dirty)
  const openFolder = useOpenProject()
  const rescan = useRescanProject()
  const addRepo = useAddFolder()
  const { screenToFlowPosition } = useReactFlow()
  // Kept mounted with the toolbar so `when` contexts are ready before the menu opens.
  const extensionCommands = useExtensionCommands('toolbar')

  const addComponent = () =>
    useStore
      .getState()
      .addComponent(screenToFlowPosition({ x: window.innerWidth / 2.5, y: window.innerHeight / 3 }))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      if ((e.metaKey || e.ctrlKey) && s.project) {
        const target = views[Number(e.key) - 1]
        if (target && /^[1-9]$/.test(e.key)) {
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
      <div className="toolbar-group">
        <Menu label="Project">
          <MenuItem onClick={() => void openFolder()}>Open folder…</MenuItem>
          {project && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => void rescan()} title="Add components for new folders">
                Rescan
              </MenuItem>
              <MenuItem
                onClick={() => void addRepo()}
                title="Add a repo beside this project, or a folder Rescan missed"
              >
                Add repo…
              </MenuItem>
              <MenuItem
                onClick={addComponent}
                disabled={view !== 'navigation'}
                title={
                  view === 'navigation' ? undefined : 'Switch to Navigation to add a component'
                }
              >
                New component
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void saveCurrentProject()} shortcut={`${mod}S`}>
                Save
              </MenuItem>
            </>
          )}
        </Menu>
        <Menu label="Tools">
          <MenuItem
            onClick={() => useStore.getState().setPaletteOpen(true)}
            shortcut={`${shiftMod}P`}
          >
            Commands…
          </MenuItem>
          <MenuItem onClick={() => useStore.getState().setExtensionsPanelOpen(true)}>
            Extensions…
          </MenuItem>
          {extensionCommands.entries.length > 0 && <MenuSeparator />}
          {extensionCommands.entries.map((e) => (
            <MenuItem
              key={e.id}
              data-extension-command={e.id}
              onClick={() => extensionCommands.run(e.id)}
            >
              {e.title}
            </MenuItem>
          ))}
        </Menu>
      </div>
      {project ? (
        <div className="view-switcher" role="group" aria-label="Workspace view">
          {views.map((v, i) => (
            <button
              key={v.id}
              aria-pressed={view === v.id}
              className={view === v.id ? 'active' : ''}
              title={`${v.label} (${mod}${i + 1})`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      ) : (
        <span />
      )}
      <div className="toolbar-group end">
        {project && (
          <>
            <AttentionMenu />
            <span className="file" title={project.root}>
              <span className="file-name">{project.name}</span>
              {dirty && <span className="dirty" title="Unsaved changes" />}
            </span>
            <button className="primary" onClick={() => void saveCurrentProject()}>
              Save
            </button>
          </>
        )}
      </div>
      <Toast />
    </div>
  )
}
