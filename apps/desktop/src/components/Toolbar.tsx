import { mapEditsBlocked } from '../lib/mapSave'
import NotificationsPanel from './NotificationsPanel'
import { configureEditor, showFileSearch } from '../lib/navigation'
import ExtensionMenu from '../extensions/ExtensionMenu'
import { useReactFlow } from '@xyflow/react'
import { useEffect, useState } from 'react'
import AgentIntegrationsPanel from './AgentIntegrationsPanel'
import AgentRolesPanel from './AgentRolesPanel'
import {
  closeProjectTab,
  saveCurrentProject,
  useAddFolder,
  useOpenProject,
  useRescanProject,
} from '../lib/project'
import { offerDependencies } from '../lib/dependencies'
import { arrangeNow } from '../lib/arrange'
import { useStore } from '../store'
import Menu, { MenuItem, MenuSeparator } from './Menu'
import Toast from './Toast'
import MapSaveStatus from './MapSaveStatus'
import AutoPanel from './auto/AutoPanel'
import AttentionMenu from './status/AttentionMenu'
import WorktreePicker from './tasks/WorktreePicker'
import type { View } from '../types'
import { mod, shiftMod } from '../lib/platform'
import ProjectSwitcher from './ProjectSwitcher'
import { ActivityButton } from './tasks/TaskActivityPanel'

const views: { id: View; label: string }[] = [
  { id: 'navigation', label: 'Navigation' },
  { id: 'plan', label: 'Plan' },
  { id: 'implementation', label: 'Build' },
  { id: 'review', label: 'Review' },
]

export default function Toolbar() {
  const [integrationsOpen, setIntegrationsOpen] = useState(false)
  const [rolesOpen, setRolesOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const project = useStore((s) => s.project)
  const simpleMode = useStore((s) => s.simpleMode)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const nodeCount = useStore((s) => s.nodes.length)
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
      {rolesOpen && <AgentRolesPanel onClose={() => setRolesOpen(false)} />}
      {notificationsOpen && <NotificationsPanel onClose={() => setNotificationsOpen(false)} />}
      <div className="toolbar">
        <div className="toolbar-group">
          <Menu label="Project" caret={false} keepMounted>
            <MenuItem onClick={() => void openFolder()}>Open folder</MenuItem>
            {project && (
              <>
                <MenuSeparator />
                <MenuItem
                  onClick={() => void saveCurrentProject()}
                  shortcut={`${mod}S`}
                  title="Saves the component map and terminal presets to patchbay.json"
                  disabled={
                    !!entry?.conflict ||
                    !!entry?.unavailable ||
                    entry?.mapSave?.status === 'conflict' ||
                    entry?.mapSave?.status === 'saving'
                  }
                >
                  {entry?.fingerprint === 'absent'
                    ? 'Create map configuration'
                    : 'Save map configuration now'}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onClick={() => void rescan()}
                  title="Review detected structural changes before applying them"
                >
                  Rescan
                </MenuItem>
                <MenuItem
                  disabled={mapEditsBlocked(entry)}
                  onClick={() => {
                    const id = useStore.getState().project?.id
                    if (id) offerDependencies(id)
                  }}
                  title="Find how components depend on each other, from manifests or with an agent"
                >
                  Detect dependencies…
                </MenuItem>
                <MenuItem
                  disabled={mapEditsBlocked(entry) || nodeCount < 2}
                  onClick={() => {
                    const id = useStore.getState().project?.id
                    if (id) arrangeNow(id)
                  }}
                  title="Lay the map out by dependencies: dependents on the left, foundations on the right"
                >
                  Arrange map
                </MenuItem>
                <MenuItem
                  onClick={() => void addRepo()}
                  title="Add a repo beside this project, or a folder Rescan missed"
                >
                  Add repo
                </MenuItem>
                {view === 'navigation' && <MenuItem onClick={addComponent}>New component</MenuItem>}
              </>
            )}
            <MenuSeparator />
            <MenuItem
              onClick={() => useStore.getState().setPaletteOpen(true)}
              shortcut={`${shiftMod}P`}
            >
              Commands
            </MenuItem>
            <ExtensionMenu slot="toolbar" asMenuItems />
            {project && (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void closeProjectTab(project.id)}>Close project</MenuItem>
              </>
            )}
          </Menu>
          <Menu label="Settings" caret={false}>
            <MenuItem onClick={() => configureEditor()}>Preferred editor</MenuItem>
            <MenuItem onClick={() => useStore.getState().setExtensionsPanelOpen(true)}>
              Extensions
            </MenuItem>
            <MenuItem onClick={() => setIntegrationsOpen(true)}>Agent status integration</MenuItem>
            <MenuItem disabled={!project} onClick={() => setRolesOpen(true)}>
              Agent roles
            </MenuItem>
            <MenuItem onClick={() => setNotificationsOpen(true)}>Notifications</MenuItem>
            <MenuSeparator />
            <MenuItem
              disabled={!project}
              checked={simpleMode}
              title="A worktree chat beside a read-only map, in place of the views"
              onClick={() => useStore.getState().setSimpleMode(!simpleMode)}
            >
              Chat mode
            </MenuItem>
          </Menu>
          <button
            className="toolbar-search"
            aria-label="Search files"
            title={`Search files (${mod}P)`}
            onClick={showFileSearch}
          >
            ⌕
          </button>
          <ProjectSwitcher />
          {project && <WorktreePicker caret={false} copyPlan={!simpleMode && view === 'plan'} />}
        </div>
        {/* The center slot holds Full's views or Chat mode's label, so the ends never move. */}
        {project && simpleMode && <span className="toolbar-mode">Chat mode</span>}
        {project && !simpleMode && (
          <div className="view-tabs view-switcher" role="group" aria-label="Workspace view">
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
        )}
        <div className="toolbar-group end">
          {project && (
            <>
              <AutoPanel simple={simpleMode} onIntegrations={() => setIntegrationsOpen(true)} />
              <AttentionMenu />
              <ActivityButton />
            </>
          )}
          <button onClick={() => useStore.setState({ sessionsPanelOpen: true })}>Sessions</button>
          {project && <MapSaveStatus />}
        </div>
        <Toast />
      </div>
    </>
  )
}
