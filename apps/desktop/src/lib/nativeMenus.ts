import { useShallow } from 'zustand/react/shallow'
import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { useExtensionCommands } from '../extensions/commands'
import { runWorkspaceAction, type WorkspaceAction } from './workspaceActions'

export function useNativeMenus(actions: WorkspaceAction[]) {
  const workspace = useStore(useShallow((s) => [s.gitChanges, s.activeTask]))
  const extensions = useExtensionCommands('toolbar', undefined, workspace)
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
    if (!/mac/i.test(navigator.userAgent)) return
    void invoke('update_native_menu', { entries: JSON.parse(entries) }).catch((e) =>
      useStore.getState().setMessage(String(e)),
    )
  }, [entries])
  useEffect(() => {
    if (!/mac/i.test(navigator.userAgent)) return
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
