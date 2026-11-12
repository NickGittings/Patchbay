import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'
import ExtensionMenu from '../extensions/ExtensionMenu'
import MapSaveStatus from './MapSaveStatus'
import Menu, { MenuItem } from './Menu'
import { CloseMenu } from './menuContext'
import ProjectSwitcher from './ProjectSwitcher'
import WorktreePicker from './tasks/WorktreePicker'

export default function WorkspacePopover({
  panel,
  actions,
  onClose,
}: {
  panel: 'project' | 'worktree'
  actions: WorkspaceAction[]
  onClose: () => void
}) {
  const projectId = useStore((s) => s.project?.id)
  const copyPlan = useStore((s) => !s.simpleMode && s.view === 'plan')
  const popup = useRef<HTMLDivElement>(null)
  const label = panel === 'project' ? 'Projects' : 'Worktrees'
  useEffect(() => {
    popup.current?.focus()
  }, [panel])

  return (
    <div
      id={`workspace-${panel}-popover`}
      className="footer-popover workspace-popover"
      data-panel={panel}
      ref={popup}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="footer-popover-header">
        <strong>{label}</strong>
        <button
          className="footer-popover-icon"
          aria-label={`Close ${label.toLowerCase()}`}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="workspace-popover-content">
        <CloseMenu.Provider value={onClose}>
          {panel === 'project' ? (
            <>
              <ProjectSwitcher />
              <MapSaveStatus />
              <div className="rail-toolbar">
                {actions
                  .filter((a) => a.id === 'open')
                  .map((a) => (
                    <button
                      key={a.id}
                      className="primary"
                      disabled={!a.enabled}
                      onClick={() => {
                        onClose()
                        runWorkspaceAction(a)
                      }}
                    >
                      {a.title}
                    </button>
                  ))}
                <Menu label="⋯" triggerLabel="Project actions" caret={false} portal>
                  {actions
                    .filter((a) => a.group === 'project' && !['save', 'open'].includes(a.id))
                    .map((a) => (
                      <MenuItem
                        key={a.id}
                        disabled={!a.enabled}
                        onClick={() => {
                          onClose()
                          runWorkspaceAction(a)
                        }}
                      >
                        {a.title}
                      </MenuItem>
                    ))}
                </Menu>
                <ExtensionMenu slot="toolbar" />
              </div>
            </>
          ) : (
            projectId && <WorktreePicker key={projectId} copyPlan={copyPlan} />
          )}
        </CloseMenu.Provider>
      </div>
    </div>
  )
}
