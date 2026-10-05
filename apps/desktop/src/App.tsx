import PersistedGroup from './components/PersistedGroup'
import WorkspaceTabs from './components/WorkspaceTabs'
import SessionsPanel from './components/SessionsPanel'
import { initializeWorkspace } from './lib/workspace'
import CommandPalette from './components/CommandPalette'
import ExtensionsPanel from './components/ExtensionsPanel'
import { startExtensionHost, refreshExtensions } from './extensions/host'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Panel, Separator } from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Hierarchy from './components/Hierarchy'
import Inspector from './components/Inspector'
import ImplementationView from './components/ImplementationView'
import PlanView from './components/PlanView'
import ReviewView from './components/ReviewView'
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
  useEffect(() => {
    let stopped = false
    // Watchers name their project; window focus sends no payload (null): refresh the active one.
    const unlisten = listen<string | null>(GIT_DIRTY_EVENT, (event) => {
      if (!stopped) void requestGitRefresh(event.payload ?? undefined)
    })
    void unlisten.catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      stopped = true
      invalidateGitRefresh()
      void unlisten.then((stop) => stop()).catch(() => {})
    }
  }, [])
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
  const projectId = useStore((s) => s.project?.id)
  const restoring = useStore((s) => s.restoring)
  useEffect(() => {
    void initializeWorkspace()
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
        <WorkspaceTabs />
        <SessionsPanel />
        <CommandPalette />
        <ExtensionsPanel />
        {restoring ? (
          <div className="hint">Restoring workspace…</div>
        ) : view === 'plan' ? (
          <PlanView key={projectId} />
        ) : view === 'implementation' ? (
          <ImplementationView key={projectId} />
        ) : view === 'review' ? (
          <ReviewView key={projectId} />
        ) : (
          <PersistedGroup
            layoutId="App-1"
            orientation="horizontal"
            className="workspace"
            key={projectId}
          >
            <Panel id="App-pane-1" defaultSize="14" minSize="10">
              <Hierarchy />
            </Panel>
            <Separator className="separator" />
            <Panel id="App-pane-2" defaultSize="62">
              <PersistedGroup layoutId="App-2" orientation="vertical">
                <Panel id="App-pane-3" defaultSize="58" minSize="20">
                  <Canvas />
                </Panel>
                <Separator className="separator horizontal" />
                <Panel id="App-pane-4" defaultSize="42" minSize="10">
                  <TerminalDock />
                </Panel>
              </PersistedGroup>
            </Panel>
            <Separator className="separator" />
            <Panel id="App-pane-5" defaultSize="24" minSize="16">
              <Inspector />
            </Panel>
          </PersistedGroup>
        )}
      </div>
    </ReactFlowProvider>
  )
}
