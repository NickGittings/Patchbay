import { isMac, titleBarMouseDown } from '../lib/platform'
import { useEffect } from 'react'
import UnifiedSearch from './UnifiedSearch'
import Toast from './Toast'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'
import Menu, { MenuItem } from './Menu'
import WindowControls from './WindowControls'
import { railViews, selectRailShortcut } from '../lib/rail'

/** Main-window title bar; macOS keeps its native menus and traffic lights. */
export default function Toolbar({ actions }: { actions: WorkspaceAction[] }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return
      // Ctrl combinations belong to the focused terminal, including flow control and TUIs.
      if (e.ctrlKey && !e.metaKey && e.target instanceof Element && e.target.closest('.xterm'))
        return
      if (!e.shiftKey && !e.altKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        selectRailShortcut(railViews[Number(e.key) - 1].id)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  return (
    <div
      className={`top-bar${isMac ? ' mac-titlebar' : ' custom-titlebar'}`}
      data-tauri-drag-region
      onMouseDown={titleBarMouseDown}
    >
      {!isMac && (
        <div className="toolbar-menus">
          {(['project', 'settings'] as const).map((group) => {
            const label = group === 'project' ? 'Project' : 'Settings'
            return (
              <Menu key={group} label={label} title={label} triggerLabel={label} portal>
                {actions
                  .filter((action) => action.group === group)
                  .map((action) => (
                    <MenuItem
                      key={action.id}
                      disabled={!action.enabled}
                      onClick={() => runWorkspaceAction(action)}
                    >
                      {action.title}
                    </MenuItem>
                  ))}
              </Menu>
            )
          })}
        </div>
      )}
      <UnifiedSearch actions={actions} />
      {!isMac && <WindowControls />}
      <Toast />
    </div>
  )
}
