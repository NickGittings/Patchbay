import { configureEditor, showFileSearch } from '../lib/navigation'
import ExtensionMenu from '../extensions/ExtensionMenu'
import { useReactFlow } from '@xyflow/react'
import { useEffect, useState } from 'react'
import AgentIntegrationsPanel from './AgentIntegrationsPanel'
import { saveCurrentProject, useAddFolder, useOpenProject, useRescanProject } from '../lib/project'
import { useStore } from '../store'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import Toast from './Toast'
import AttentionMenu from './status/AttentionMenu'
import WorktreePicker from './tasks/WorktreePicker'
import type { View } from '../types'
import { mod, shiftMod } from '../lib/platform'

const views: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'review', label: 'Review' },
]

export default function Toolbar() {
  const [integrationsOpen, setIntegrationsOpen] = useState(false)
  const project = useStore((s) => s.project)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const dirty = useStore((s) => s.dirty)
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
    <>
      {integrationsOpen && <AgentIntegrationsPanel onClose={() => setIntegrationsOpen(false)} />}
      <div className="toolbar">
        <div className="toolbar-group">
          <Menu label="Project">
            <MenuItem onClick={() => void openFolder()}>Open folder…</MenuItem>
            {project && (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => void rescan()}
                  title="Review detected structural changes before applying them"
                >
                  Rescan
                </MenuItem>
                <MenuItem
                  onClick={() => void addRepo()}
                  title="Add a repo beside this project, or a folder Rescan missed"
                >
                  Add repo…
                </MenuItem>
                {view === 'navigation' && <MenuItem onClick={addComponent}>New component</MenuItem>}
              </>
            )}
          </Menu>
          <Menu label="Tools" keepMounted>
            <MenuItem onClick={showFileSearch} shortcut={`${mod}P`}>
              Search files…
            </MenuItem>
            <MenuItem onClick={() => configureEditor()}>Preferred editor…</MenuItem>
            <MenuItem
              onClick={() => useStore.getState().setPaletteOpen(true)}
              shortcut={`${shiftMod}P`}
            >
              Commands…
            </MenuItem>
            <MenuItem onClick={() => useStore.getState().setExtensionsPanelOpen(true)}>
              Extensions…
            </MenuItem>
            <MenuItem onClick={() => setIntegrationsOpen(true)}>Agent status integration…</MenuItem>
            <ExtensionMenu slot="toolbar" asMenuItems />
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
              {/* Plan and Implementation carry the picker in their own headers. */}
              {(view === 'navigation' || view === 'review') && <WorktreePicker align="right" />}
              <AttentionMenu />
              <button
                className={dirty ? 'primary' : undefined}
                title={`${dirty ? 'Unsaved changes. ' : ''}Save patchbay.json (${mod}S)`}
                onClick={() => void saveCurrentProject()}
              >
                Save
              </button>
            </>
          )}
        </div>
        <Toast />
      </div>
    </>
  )
}
