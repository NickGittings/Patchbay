import { Group, type GroupProps } from 'react-resizable-panels'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useStore } from '../store'

export default function PersistedGroup({ layoutId, ...props }: GroupProps & { layoutId: string }) {
  const panels = useStore((s) => s.panels)
  const saved = panels[layoutId]
  const valid = saved && Object.values(saved).every((n) => Number.isFinite(n) && n >= 0 && n <= 100)
  return (
    <Group
      {...props}
      defaultLayout={valid ? saved : undefined}
      onLayoutChanged={(layout) => {
        useStore.getState().setPanelLayout(layoutId, layout)
        if (getCurrentWebviewWindow().label !== 'main')
          void invoke('window_panels', { panels: useStore.getState().panels })
      }}
    />
  )
}
