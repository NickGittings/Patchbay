import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Hierarchy from './components/Hierarchy'
import Inspector from './components/Inspector'
import TerminalDock from './components/TerminalDock'
import Toolbar from './components/Toolbar'
import { gitStatus, listDevices, syncRoots } from './lib/ipc'
import { listenForTerminals } from './lib/sessions'
import { syncComponentWindows } from './lib/windows'
import { useStore } from './store'

const GIT_POLL_MS = 5000

/**
 * Poll uncommitted changes per component (across every repo on the map) while a project is open.
 * The next poll is scheduled only once the last one finishes, so slow repos can't pile up git
 * processes, and results arriving after the project changed are dropped.
 */
function useGitPolling() {
  const root = useStore((s) => s.project?.root)
  useEffect(() => {
    if (!root) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const s = useStore.getState()
      try {
        const status = await gitStatus(s.nodes.map((n) => ({ id: n.id, path: n.data.path })))
        if (!stopped) useStore.getState().setGitStatus(status)
      } catch {
        // Not a repo, or git missing: leave the last status as is.
      }
      if (!stopped) timer = setTimeout(() => void poll(), GIT_POLL_MS)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [root])
}

/** Keep the backend's readable folders in step with the component folders on the map. */
function useRootSync() {
  useEffect(() => {
    let last: string[] = []
    return useStore.subscribe((s, prev) => {
      if (!s.project || s.nodes === prev.nodes) return
      // A drag replaces nodes every frame but keeps their paths: compare without allocating.
      if (s.nodes.length === last.length && s.nodes.every((n, i) => n.data.path === last[i])) return
      last = s.nodes.map((n) => n.data.path)
      void syncRoots(last).catch(() => {})
    })
  }, [])
}

export default function App() {
  useEffect(() => {
    void listDevices().then(useStore.getState().setDevices)
    void listenForTerminals().catch((e) => useStore.getState().setMessage(String(e)))
    return syncComponentWindows()
  }, [])
  useGitPolling()
  useRootSync()

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
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
      </div>
    </ReactFlowProvider>
  )
}
