import CommandPalette from './components/CommandPalette'
import ExtensionsPanel from './components/ExtensionsPanel'
import { startExtensionHost, refreshExtensions } from './extensions/host'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Group, Panel, Separator } from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Hierarchy from './components/Hierarchy'
import Inspector from './components/Inspector'
import ImplementationView from './components/ImplementationView'
import PlanView from './components/PlanView'
import TerminalDock from './components/TerminalDock'
import Toolbar from './components/Toolbar'
import { GIT_DIRTY_EVENT } from './lib/ipc'
import { invalidateGitRefresh, requestGitRefresh } from './lib/git'
import { syncCurrentRoots } from './lib/access'
import { listenForTerminals } from './lib/sessions'
import { syncComponentWindows } from './lib/windows'
import { useStore } from './store'

/** Refresh on project changes, file mutations and focus in any app window. */
function useGitRefresh() {
  const project = useStore((s) => s.project)
  useEffect(() => {
    if (!project) return
    let stopped = false
    const unlisten = listen(GIT_DIRTY_EVENT, () => {
      if (!stopped) void requestGitRefresh()
    })
    void unlisten.catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      stopped = true
      invalidateGitRefresh()
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [project])
}

/** Keep the backend's readable folders in step with the component folders on the map. */
function useRootSync() {
  useEffect(() => {
    let last: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (!s.project || (s.nodes === prev.nodes && s.project === prev.project)) return
      // A drag replaces nodes every frame but keeps their paths: compare without allocating.
      if (
        s.project === prev.project &&
        s.nodes.length === last.length &&
        s.nodes.every((n, i) => n.data.path === last[i])
      )
        return
      last = s.nodes.map((n) => n.data.path)
      clearTimeout(timer)
      timer = setTimeout(() => void syncCurrentRoots(false).catch(() => {}), 150)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])
}

export default function App() {
  const view = useStore((s) => s.view)
  useEffect(() => {
    const stopHost = startExtensionHost()
    void refreshExtensions().catch((e) => useStore.getState().setMessage(String(e)))
    void listenForTerminals().catch((e) => useStore.getState().setMessage(String(e)))
    const stopWindows = syncComponentWindows()
    return () => {
      stopHost()
      stopWindows()
    }
  }, [])
  useGitRefresh()
  useRootSync()

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <CommandPalette />
        <ExtensionsPanel />
        {view === 'plan' ? (
          <PlanView />
        ) : view === 'implementation' ? (
          <ImplementationView />
        ) : (
          <Group orientation="horizontal" className="workspace">
            <Panel defaultSize="14" minSize="10">
              <Hierarchy />
            </Panel>
            <Separator className="separator" />
            <Panel defaultSize="62">
              <Group orientation="vertical">
                <Panel defaultSize="58" minSize="20">
                  <Canvas />
                </Panel>
                <Separator className="separator horizontal" />
                <Panel defaultSize="42" minSize="10">
                  <TerminalDock />
                </Panel>
              </Group>
            </Panel>
            <Separator className="separator" />
            <Panel defaultSize="24" minSize="16">
              <Inspector />
            </Panel>
          </Group>
        )}
      </div>
    </ReactFlowProvider>
  )
}
