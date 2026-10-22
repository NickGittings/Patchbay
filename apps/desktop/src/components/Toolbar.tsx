import { isMac } from '../lib/platform'
import { useEffect, useRef } from 'react'
import UnifiedSearch from './UnifiedSearch'
import Toast from './Toast'
import { runWorkspaceAction, useWorkspaceActions } from '../lib/workspaceActions'
import { railViews, selectRailShortcut } from '../lib/rail'
import { useNativeMenus } from '../lib/nativeMenus'

/** The only top-bar control is the combined file and command search. */
export default function Toolbar() {
  const actions = useWorkspaceActions()
  const latestActions = useRef(actions)
  useEffect(() => {
    latestActions.current = actions
  }, [actions])
  useNativeMenus(actions)
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
      // macOS owns Cmd+S in its native menu. Other platforms use this handler.
      if (!isMac && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        runWorkspaceAction(latestActions.current.find((a) => a.id === 'save'))
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  return (
    <div className={`top-bar${isMac ? ' mac-titlebar' : ''}`} data-tauri-drag-region>
      <UnifiedSearch actions={actions} />
      <Toast />
    </div>
  )
}
