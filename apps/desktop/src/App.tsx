import PersistedGroup from './components/PersistedGroup'
import WorkspaceTabs from './components/WorkspaceTabs'
import SessionsPanel from './components/SessionsPanel'
import TaskActivityPanel from './components/tasks/TaskActivityPanel'
import { initializeWorkspace } from './lib/workspace'
import NavigationDialogs from './components/NavigationDialogs'
import CommandPalette from './components/CommandPalette'
import MapMaintenanceReview from './components/MapMaintenanceReview'
import { startMaintenanceChecks } from './lib/maintenance'
import ExtensionsPanel from './components/ExtensionsPanel'
import { startExtensionHost, refreshExtensions } from './extensions/host'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Panel,
  Separator,
  usePanelRef,
  type PanelImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Hierarchy from './components/Hierarchy'
import Inspector from './components/Inspector'
import ImplementationView from './components/ImplementationView'
import PlanView from './components/PlanView'
import ReviewView from './components/ReviewView'
import NewTaskDialog from './components/tasks/NewTaskDialog'
import TerminalDock from './components/TerminalDock'
import { closeInspector, hasDockTabs, showsInspector } from './lib/panels'
import { useExtensionViews } from './extensions/useExtensionViews'
import Toolbar from './components/Toolbar'
import { syncAgentProject, GIT_DIRTY_EVENT } from './lib/ipc'
import { invalidateGitRefresh, requestGitRefresh } from './lib/git'
import { syncCurrentRoots } from './lib/access'
import { listenForTerminals } from './lib/sessions'
import { followActiveTask, refreshTasks } from './lib/tasks'
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

/** Where Navigation's collapsible panels remember their open sizes, in the project's `panels`. */
const OPEN_SIZES = 'App-open'

function openPanel(p: PanelImperativeHandle, id: string) {
  p.expand()
  const size = useStore.getState().panels[OPEN_SIZES]?.[id]
  if (size) p.resize(`${size}%`)
}

/**
 * Collapse panel `id` while it has nothing to show and expand it, at the size it had when it was
 * last collapsed, once it does or `reveal` changes. Returns the panel's props and whether it is
 * collapsed, including by the user dragging it shut; `onDragShut` runs then.
 */
function useCollapsed(id: string, shown: boolean, reveal?: unknown, onDragShut?: () => void) {
  const panelRef = usePanelRef()
  const shownRef = useRef(shown)
  const [collapsed, setCollapsed] = useState(true)
  useLayoutEffect(() => {
    shownRef.current = shown
    const p = panelRef.current
    if (!p) return
    if (shown && p.isCollapsed()) openPanel(p, id)
    else if (!shown && !p.isCollapsed()) {
      const size = p.getSize().asPercentage
      const s = useStore.getState()
      if (size > 0) s.setPanelLayout(OPEN_SIZES, { ...s.panels[OPEN_SIZES], [id]: size })
      p.collapse()
    }
  }, [panelRef, id, shown, reveal])
  const onResize = (size: PanelSize, _: unknown, prev: PanelSize | undefined) => {
    setCollapsed(size.asPercentage === 0)
    if (size.asPercentage === 0 && prev?.asPercentage && shownRef.current) onDragShut?.()
  }
  return { props: { panelRef, onResize, collapsible: true }, collapsed }
}

/**
 * Hierarchy and canvas, with the Inspector while something is selected (or it is opened) and the
 * dock while terminals run. Hidden panels collapse rather than unmount, so the canvas stays put
 * and their tabs keep their state.
 */
function NavigationView() {
  const inspector = useStore(showsInspector)
  const dockViews = useExtensionViews('dock').views.length > 0
  const dock = useStore(hasDockTabs) || dockViews
  const activeSession = useStore((s) => s.activeSession)
  // Dragged shut: close it, so the canvas's Inspector button comes back.
  const inspectorPanel = useCollapsed('App-pane-5', inspector, undefined, closeInspector)
  // Dragged shut, the dock stays so until it is dragged open or a terminal is revealed in it.
  const dockPanel = useCollapsed('App-pane-4', dock, activeSession)
  return (
    <PersistedGroup layoutId="App-1" orientation="horizontal" className="workspace">
      <Panel id="App-pane-1" defaultSize="14" minSize="10">
        <Hierarchy />
      </Panel>
      <Separator className="separator" />
      <Panel id="App-pane-2" defaultSize="62">
        <PersistedGroup layoutId="App-2" orientation="vertical">
          <Panel id="App-pane-3" defaultSize="58" minSize="20">
            <Canvas />
          </Panel>
          <Separator className={`separator horizontal ${dock ? '' : 'hidden'}`} disabled={!dock} />
          <Panel id="App-pane-4" defaultSize="42" minSize="10" {...dockPanel.props}>
            <TerminalDock collapsed={dockPanel.collapsed} />
          </Panel>
        </PersistedGroup>
      </Panel>
      <Separator className={`separator ${inspector ? '' : 'hidden'}`} disabled={!inspector} />
      <Panel id="App-pane-5" defaultSize="24" minSize="16" {...inspectorPanel.props}>
        <Inspector />
      </Panel>
    </PersistedGroup>
  )
}

export default function App() {
  const view = useStore((s) => s.view)
  const projectId = useStore((s) => s.project?.id)
  const restoring = useStore((s) => s.restoring)
  useEffect(() => {
    void initializeWorkspace()
    const stopHost = startExtensionHost()
    const stopMaintenance = startMaintenanceChecks()
    void refreshExtensions().catch((e) => useStore.getState().setMessage(String(e)))
    void listenForTerminals().catch((e) => useStore.getState().setMessage(String(e)))
    const stopWindows = syncComponentWindows()
    const stopTasks = followActiveTask()
    return () => {
      stopHost()
      stopMaintenance()
      stopWindows()
      stopTasks()
    }
  }, [])
  useEffect(() => {
    const signatures = new Map<string, string>()
    const sync = () => {
      const s = useStore.getState()
      if (!s.project) return
      const project = s.toProject()
      const signature = JSON.stringify({
        ...project,
        components: project.components.map(({ position: _position, ...component }) => component),
      })
      if (signatures.get(s.project.id) === signature) return
      signatures.set(s.project.id, signature)
      void syncAgentProject(project).catch((e) => {
        if (useStore.getState().project?.id === project.projectId)
          useStore.getState().setMessage(String(e))
      })
    }
    sync()
    return useStore.subscribe((s, prev) => {
      if (
        s.project !== prev.project ||
        s.nodes !== prev.nodes ||
        s.edges !== prev.edges ||
        s.groups !== prev.groups
      )
        sync()
    })
  }, [])
  // Tasks belong to the repo, so each project loads its own when its tab opens.
  useEffect(() => {
    if (projectId) void refreshTasks()
  }, [projectId])
  useGitRefresh()
  useRootSync()

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <WorkspaceTabs />
        <SessionsPanel />
        <TaskActivityPanel />
        <CommandPalette />
        <NavigationDialogs />
        <MapMaintenanceReview />
        <ExtensionsPanel />
        <NewTaskDialog />
        {restoring ? (
          <div className="hint">Restoring workspace…</div>
        ) : view === 'plan' ? (
          <PlanView key={projectId} />
        ) : view === 'implementation' ? (
          <ImplementationView key={projectId} />
        ) : view === 'review' ? (
          <ReviewView key={projectId} />
        ) : (
          <NavigationView key={projectId} />
        )}
      </div>
    </ReactFlowProvider>
  )
}
