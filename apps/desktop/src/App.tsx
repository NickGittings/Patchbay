import StoryBoard from './components/stories/StoryBoard'
import { storyProgressPoll } from './lib/storyProgress'
import WorkspaceRail from './components/WorkspaceRail'
import RecoveryBanners from './components/RecoveryBanners'
import { useMapActivityFeedback } from './lib/mapActivity'
import SimpleDiff from './components/SimpleDiff'
import { useSimpleData } from './lib/useSimpleData'
import { simpleKey, useSimpleUi } from './lib/simpleUi'
import SimpleChat from './components/SimpleChat'
import { followNotifications } from './lib/notifications'
import PersistedGroup from './components/PersistedGroup'
import { initializeWorkspace } from './lib/workspace'
import NavigationDialogs from './components/NavigationDialogs'
import MapMaintenanceReview from './components/MapMaintenanceReview'
import DependencyDialog from './components/DependencyDialog'
import { initializeDependencyDetection } from './lib/dependencies'
import { initializeStackProposals } from './lib/stackAgent'
import { startMaintenanceChecks } from './lib/maintenance'
import ExtensionsPanel from './components/ExtensionsPanel'
import { startExtensionHost, refreshExtensions } from './extensions/host'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { useCollapsed } from './lib/useCollapsed'
import { listen } from '@tauri-apps/api/event'
import { Panel, Separator, useGroupRef } from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Inspector from './components/Inspector'
import ImplementationView from './components/ImplementationView'
import PlanView from './components/PlanView'
import ReviewView from './components/ReviewView'
import NewTaskDialog from './components/tasks/NewTaskDialog'
import TerminalDock from './components/TerminalDock'
import { closeInspector, hasDockTabs, showsInspector } from './lib/panels'
import { useExtensionViews } from './extensions/useExtensionViews'
import Toolbar from './components/Toolbar'
import { useWorkspaceActions } from './lib/workspaceActions'
import { useNativeMenus } from './lib/nativeMenus'
import { syncAgentProject, GIT_DIRTY_EVENT } from './lib/ipc'
import { invalidateGitRefresh, requestGitRefresh } from './lib/git'
import { syncCurrentRoots } from './lib/access'
import { listenForTerminals } from './lib/sessions'
import { followAuto } from './lib/auto'
import { followActiveTask, refreshTasks } from './lib/tasks'
import { syncComponentWindows } from './lib/windows'
import { projectOf, useStore } from './store'

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

/**
 * The canvas, with the Inspector while something is selected (or it is opened) and the
 * dock while terminals run. Hidden panels collapse rather than unmount, so the canvas stays put
 * and their tabs keep their state.
 */
function NavigationView() {
  const group = useGroupRef()
  const simple = useStore((s) => s.simpleMode)
  const scopeKey = useStore((s) => simpleKey(s.project?.id, s.activeTask))
  const diff = useSimpleUi((s) => s.worktrees[scopeKey]?.diff)
  useMapActivityFeedback()
  useEffect(
    () => () => {
      useSimpleUi.getState().patch(scopeKey, { diff: null })
    },
    [scopeKey],
  )
  const chatPanel = useCollapsed('App-simple-chat', simple, simple, undefined, 'App-simple-open', {
    group,
    panel: 'App-pane-2',
    defaultSize: 35,
  })
  // An open diff reads the same data, so it keeps refreshing while the chat is collapsed.
  const reader = useSimpleData(simple && (!chatPanel.collapsed || !!diff))
  const storyBoard = useStore((s) => s.storyBoard) && !simple
  const inspector = useStore(showsInspector)
  const dockViews = useExtensionViews('dock').views.length > 0
  const dock = useStore(hasDockTabs) || dockViews
  const activeSession = useStore((s) => s.activeSession)
  // Dragged shut: close it, so the canvas's Inspector button comes back.
  const inspectorPanel = useCollapsed(
    'App-pane-5',
    inspector,
    undefined,
    closeInspector,
    undefined,
    {
      group,
      panel: 'App-pane-2',
      defaultSize: 24,
    },
  )
  // Dragged shut, the dock stays so until it is dragged open or a terminal is revealed in it.
  const dockPanel = useCollapsed('App-pane-4', dock, activeSession)
  return (
    <PersistedGroup
      layoutId={simple ? 'App-simple' : 'App-1'}
      group={group}
      orientation="horizontal"
      className="workspace"
    >
      <Panel id="App-pane-2" defaultSize="76">
        <PersistedGroup layoutId="App-2" orientation="vertical">
          <Panel id="App-pane-3" defaultSize="58" minSize="20">
            <div className="simple-canvas">
              <div
                className={`navigation-map ${storyBoard ? 'story-map-hidden' : ''}`}
                aria-hidden={storyBoard}
                inert={storyBoard}
              >
                <Canvas />
              </div>
              {storyBoard && <StoryBoard />}
              {simple && chatPanel.collapsed && (
                <button className="simple-show-chat" onClick={chatPanel.expand}>
                  Show chat
                </button>
              )}
              {simple && diff && (
                <SimpleDiff scopeKey={scopeKey} selection={diff} reader={reader} />
              )}
            </div>
          </Panel>
          <Separator className={`separator horizontal ${dock ? '' : 'hidden'}`} disabled={!dock} />
          <Panel id="App-pane-4" defaultSize="42" minSize="10" {...dockPanel.props}>
            <TerminalDock collapsed={dockPanel.collapsed} />
          </Panel>
        </PersistedGroup>
      </Panel>
      <Separator className={`separator ${simple ? '' : 'hidden'}`} disabled={!simple} />
      <Panel id="App-simple-chat" defaultSize="35" minSize="20" {...chatPanel.props}>
        {simple && !chatPanel.collapsed && <SimpleChat key={scopeKey} reader={reader} />}
      </Panel>
      <Separator className={`separator ${inspector ? '' : 'hidden'}`} disabled={!inspector} />
      <Panel id="App-pane-5" defaultSize="24" minSize="16" {...inspectorPanel.props}>
        <Inspector />
      </Panel>
    </PersistedGroup>
  )
}

function AppWorkspace() {
  const view = useStore((s) => s.view)
  const simple = useStore((s) => s.simpleMode)
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
    const stopAuto = followAuto()
    const stopNotifications = followNotifications()
    const stopDependencies = initializeDependencyDetection()
    const stopStack = initializeStackProposals()
    return () => {
      stopHost()
      stopMaintenance()
      stopWindows()
      stopTasks()
      stopAuto()
      stopNotifications()
      stopDependencies()
      stopStack()
    }
  }, [])
  useEffect(() => {
    const signatures = new Map<string, string>()
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const sync = () => {
      timer = undefined
      for (const id of pending) {
        const project = projectOf(id)
        if (!project) continue
        const signature = JSON.stringify({
          ...project,
          components: project.components.map(({ position: _position, ...component }) => component),
        })
        if (signatures.get(id) === signature) continue
        signatures.set(id, signature)
        void syncAgentProject(project).catch((e) => {
          if (signatures.get(id) === signature) signatures.delete(id)
          if (useStore.getState().project?.id === project.projectId)
            useStore.getState().setMessage(String(e))
        })
      }
      pending.clear()
    }
    const schedule = (id: string | undefined, delay: number) => {
      if (!id) return
      pending.add(id)
      clearTimeout(timer)
      timer = setTimeout(sync, delay)
    }
    for (const id of Object.keys(useStore.getState().captureProjects())) schedule(id, 0)
    // Edits arrive per keystroke and drag frame, so agents get the map once they settle.
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.projects !== prev.projects || (prev.restoring && !s.restoring))
        for (const id of Object.keys(s.captureProjects())) schedule(id, 0)
      if (s.project !== prev.project) {
        schedule(prev.project?.id, 0)
        schedule(s.project?.id, 0)
      } else if (s.nodes !== prev.nodes || s.edges !== prev.edges || s.groups !== prev.groups)
        schedule(s.project?.id, 250)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])
  // Tasks belong to the repo, so each project loads its own when its tab opens.
  useEffect(() => {
    if (projectId) {
      void refreshTasks()
      // Completion must be saved even while the board is closed (for example during Merge).
      const progress = storyProgressPoll(projectId)
      void progress.poll()
      const timer = setInterval(() => void progress.poll(), 5000)
      return () => {
        progress.dispose()
        clearInterval(timer)
      }
    }
  }, [projectId])
  useGitRefresh()
  useRootSync()
  // One set of actions serves the search, the rail and the native menus.
  const actions = useWorkspaceActions()
  useNativeMenus(actions)

  return (
    <div className="app">
      <Toolbar actions={actions} />
      <NavigationDialogs settingsOnly />
      <MapMaintenanceReview />
      <DependencyDialog />
      <ExtensionsPanel />
      <NewTaskDialog />
      <div className="workspace-body">
        <WorkspaceRail actions={actions} />
        <main className="workspace-main">
          <RecoveryBanners />
          {!restoring && (simple || view === 'navigation') && (
            <div className="navigation-shell">
              <NavigationView key={projectId} />
            </div>
          )}
          {restoring ? (
            <div className="hint">Restoring workspace…</div>
          ) : !simple && view === 'plan' ? (
            <PlanView key={projectId} />
          ) : !simple && view === 'implementation' ? (
            <ImplementationView key={projectId} />
          ) : !simple && view === 'review' ? (
            <ReviewView key={projectId} />
          ) : null}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <AppWorkspace />
    </ReactFlowProvider>
  )
}
