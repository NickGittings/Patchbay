import { useEffect } from 'react'
import UnifiedSearch from './UnifiedSearch'
import Toast from './Toast'
import { useWorkspaceActions, runWorkspaceAction } from '../lib/workspaceActions'
import { railViews, selectRailView } from '../lib/rail'
import { useNativeMenus } from '../lib/nativeMenus'

/** The only top-bar control is the combined file and command search. */
export default function Toolbar() {
  const actions = useWorkspaceActions()
  useNativeMenus(actions)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return
      if (!e.shiftKey && !e.altKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        selectRailView(railViews[Number(e.key) - 1].id)
      }
      // macOS owns Cmd+S in its native menu. Other platforms use this handler.
      if (!/mac/i.test(navigator.userAgent) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        e.stopPropagation()
        runWorkspaceAction(actions.find((a) => a.id === 'save'))
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [actions])
  return (
    <div className="top-bar">
      <UnifiedSearch actions={actions} />
      <Toast />
    </div>
  )
}
