import { simplePanelLayout } from '../lib/simple'
import { useEffect, useMemo } from 'react'
import { Group, useGroupRef, type GroupProps } from 'react-resizable-panels'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'

type Layout = Record<string, number>

const validLayout = (saved: unknown): saved is Layout =>
  !!saved &&
  typeof saved === 'object' &&
  !Array.isArray(saved) &&
  Object.values(saved).every((n) => Number.isFinite(n) && n >= 0 && n <= 100)

export default function PersistedGroup({ layoutId, ...props }: GroupProps & { layoutId: string }) {
  const panels = useStore((s) => s.panels)
  const original = panels[layoutId]
  const saved = useMemo(
    () => (layoutId === 'App-1' ? simplePanelLayout(original) : original),
    [layoutId, original],
  )
  const valid = validLayout(saved)
  const group = useGroupRef()
  // Another task or project brings its own layout. Apply it in place: remounting the group would
  // remount the canvas and reset the dock and inspector.
  useEffect(() => {
    const handle = group.current
    if (!handle || !valid || !saved) return
    const current = handle.getLayout()
    if (Object.entries(saved).every(([id, size]) => Math.abs((current[id] ?? -1) - size) < 0.01))
      return
    try {
      handle.setLayout(saved)
    } catch {
      // A layout naming panels this group no longer has is left for the user to resize.
    }
  }, [group, saved, valid])
  return (
    <Group
      {...props}
      groupRef={group}
      defaultLayout={valid ? saved : undefined}
      onLayoutChanged={(layout) => {
        useStore.getState().setPanelLayout(layoutId, layout)
        if (getCurrentWebviewWindow().label !== 'main')
          void invoke('window_panels', { panels: useStore.getState().panels })
      }}
    />
  )
}
