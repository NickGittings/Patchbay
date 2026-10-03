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

/** Poll uncommitted changes per component (across every repo on the map) while a project is open. */
function useGitPolling() {
  const root = useStore((s) => s.project?.root)
  useEffect(() => {
    if (!root) return
    const poll = () => {
      const s = useStore.getState()
      void gitStatus(s.nodes.map((n) => ({ id: n.id, path: n.data.path })))
        .then(s.setGitStatus)
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, GIT_POLL_MS)
    return () => clearInterval(timer)
  }, [root])
}

/** Keep the backend's readable folders in step with the component folders on the map. */
function useRootSync() {
  useEffect(() => {
    let last = ''
    return useStore.subscribe((s, prev) => {
      if (!s.project || s.nodes === prev.nodes) return
      const paths = s.nodes.map((n) => n.data.path)
      const key = paths.join('\n')
      if (key === last) return
      last = key
      void syncRoots(paths).catch(() => {})
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
