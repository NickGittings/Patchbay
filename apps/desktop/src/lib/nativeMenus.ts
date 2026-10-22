import { isMac } from './platform'
import { useEffect, useRef } from 'react'
import { updateNativeMenu } from './ipc'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { useExtensionCommands } from '../extensions/commands'
import { runWorkspaceAction, type WorkspaceAction } from './workspaceActions'

/** The macOS Project and Settings menus, and Cmd/Ctrl+S on every platform. */
export function useNativeMenus(actions: WorkspaceAction[]) {
  const task = useStore((s) => s.activeTask)
  // Only macOS shows these, so elsewhere no component means no file reads. Git refreshes don't
  // re-read the selected component's files for a menu; selection and worktree changes do.
  const extensions = useExtensionCommands('toolbar', isMac ? undefined : null, task)
  const latest = useRef({ actions, extensions })
  useEffect(() => {
    latest.current = { actions, extensions }
  }, [actions, extensions])
  const entries = JSON.stringify([
    ...actions
      .filter((a) => a.group === 'project' || a.group === 'settings')
      .map((a) => ({ id: `action:${a.id}`, title: a.title, group: a.group, enabled: a.enabled })),
    { id: 'commands', title: 'Commands…', group: 'project', enabled: true },
    ...extensions.entries.map((e) => ({
      ...e,
      id: `extension:${e.id}`,
      group: 'project',
      enabled: true,
    })),
  ])
  useEffect(() => {
    if (!isMac) return
    void updateNativeMenu(JSON.parse(entries)).catch((e) =>
      useStore.getState().setMessage(String(e)),
    )
  }, [entries])
  useEffect(() => {
    // macOS owns Cmd+S in its native menu. Other platforms use this handler.
    if (isMac) return
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 's') return
      // Ctrl combinations belong to the focused terminal, including flow control and TUIs.
      if (e.ctrlKey && !e.metaKey && e.target instanceof Element && e.target.closest('.xterm'))
        return
      e.preventDefault()
      e.stopPropagation()
      runWorkspaceAction(latest.current.actions.find((a) => a.id === 'save'))
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  useEffect(() => {
    if (!isMac) return
    const unlisten = listen<string>('patchbay://menu-action', ({ payload }) => {
      if (payload === 'commands') useStore.getState().setPaletteOpen(true)
      else if (payload.startsWith('action:'))
        runWorkspaceAction(latest.current.actions.find((a) => a.id === payload.slice(7)))
      else if (
        payload.startsWith('extension:') &&
        latest.current.extensions.entries.some((e) => e.id === payload.slice(10))
      )
        latest.current.extensions.run(payload.slice(10))
    })
    void unlisten.catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [])
}
