import { isMac, titleBarMouseDown } from '../lib/platform'
import { useEffect } from 'react'
import UnifiedSearch from './UnifiedSearch'
import Toast from './Toast'
import type { WorkspaceAction } from '../lib/workspaceActions'
import { railViews, selectRailShortcut } from '../lib/rail'

/** The only top-bar control is the combined file and command search. */
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
      className={`top-bar${isMac ? ' mac-titlebar' : ''}`}
      data-tauri-drag-region
      onMouseDown={titleBarMouseDown}
    >
      <UnifiedSearch actions={actions} />
      <Toast />
    </div>
  )
}
