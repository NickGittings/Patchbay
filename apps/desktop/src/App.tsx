import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import Canvas from './components/Canvas'
import Hierarchy from './components/Hierarchy'
import Inspector from './components/Inspector'
import TerminalDock from './components/TerminalDock'
import Toolbar from './components/Toolbar'
import { gitChanges, listDevices, onTerminalEvent } from './lib/ipc'
import { handleTerminalEvent } from './lib/sessions'
import { useStore } from './store'

const GIT_POLL_MS = 5000

/** Poll uncommitted changes per component while a project is open. */
function useGitPolling() {
  const root = useStore((s) => s.project?.root)
  useEffect(() => {
    if (!root) return
    const poll = () => {
      const comps = useStore.getState().nodes.map((n): [string, string] => [n.id, n.data.path])
      void gitChanges(root, comps)
        .then(useStore.getState().setGitChanges)
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, GIT_POLL_MS)
    return () => clearInterval(timer)
  }, [root])
}

export default function App() {
  useEffect(() => {
    void listDevices().then(useStore.getState().setDevices)
    const unlisten = onTerminalEvent(handleTerminalEvent)
    return () => void unlisten.then((f) => f())
  }, [])
  useGitPolling()

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
