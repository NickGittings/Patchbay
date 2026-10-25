import NavigationDialogs from './NavigationDialogs'
import { openInEditor, revealLabel } from '../lib/navigation'
import PersistedGroup from './PersistedGroup'
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect, useState, type CSSProperties } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR } from '../lib/display'
import { isMac, titleBarMouseDown } from '../lib/platform'
import { invoke } from '@tauri-apps/api/core'
import { reconcileSessions } from '../lib/sessions'
import { revealPath } from '../lib/ipc'
import { listenForTerminals } from '../lib/sessions'
import {
  absolutePath,
  GIT_EVENT,
  PROJECT_EVENT,
  READY_EVENT,
  TASKS_EVENT,
  type TasksPayload,
} from '../lib/windows'
import { useStore } from '../store'
import { type Project } from '../types'
import ChangesPanel from './changes/ChangesPanel'
import FileTree from './FileTree'
import TerminalGrid from './TerminalGrid'

/** Panel sizes saved for this window, applied once the project model has loaded. */
let savedPanels: Record<string, Record<string, number>> | undefined

export default function ComponentWindow({ id }: { id: string }) {
  const project = useStore((s) => s.project)
  const component = useStore((s) => s.nodes.find((n) => n.id === id))
  const changes = useStore((s) => s.gitChanges[id] ?? 0)
  const message = useStore((s) => s.message)
  const [received, setReceived] = useState(false)
  const [tab, setTab] = useState<'files' | 'changes'>('files')

  useEffect(() => {
    let disposed = false
    const cleanup: UnlistenFn[] = []
    const register = async (request: Promise<UnlistenFn>) => {
      const unlisten = await request
      if (disposed) unlisten()
      else cleanup.push(unlisten)
    }
    void (async () => {
      await listenForTerminals()
      await reconcileSessions().catch(() => {})
      await register(
        listen<Project>(PROJECT_EVENT, (e) => {
          if (!useStore.getState().project) {
            useStore.getState().loadProject(e.payload)
            // Loading resets panel sizes; put back the ones saved for this window.
            if (savedPanels) useStore.setState({ panels: savedPanels })
          } else useStore.getState().syncProject(e.payload)
          setReceived(true)
        }),
      )
      await register(
        listen<TasksPayload>(TASKS_EVENT, (e) => {
          const s = useStore.getState()
          s.setTasks(e.payload.tasks)
          s.setActiveTask(e.payload.activeTask)
          useStore.setState({ highlighted: e.payload.highlighted })
        }),
      )
      await register(
        listen<Record<string, number>>(GIT_EVENT, (e) => {
          useStore.getState().setGitChanges(e.payload)
        }),
      )
      if (!disposed) {
        await emitTo('main', READY_EVENT, {
          label: getCurrentWebviewWindow().label,
          projectId: new URLSearchParams(location.search).get('project'),
        })
      }
    })().catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      disposed = true
      for (const unlisten of cleanup) unlisten()
    }
  }, [])

  useEffect(() => {
    void invoke<{ tab?: 'files' | 'changes'; panels?: Record<string, Record<string, number>> }>(
      'window_layout',
    ).then((layout) => {
      if (layout?.tab === 'files' || layout?.tab === 'changes') setTab(layout.tab)
      if (layout?.panels) {
        savedPanels = layout.panels
        // Before the model arrives, the PROJECT_EVENT handler applies them instead.
        if (useStore.getState().project) useStore.setState({ panels: layout.panels })
      }
    })
  }, [])
  const changeTab = (value: 'files' | 'changes') => {
    setTab(value)
    void invoke('window_tab', { tab: value })
  }
  const name = component?.data.name
  useEffect(() => {
    if (project && name) {
      void getCurrentWebviewWindow()
        .setTitle(`${project.name} · ${name}`)
        .catch((e) => useStore.getState().setMessage(String(e)))
    }
  }, [project, name])

  if (!project || !component) {
    // The overlay title bar hides the native one, so this keeps the window movable and the
    // text clear of the traffic lights.
    return (
      <div className="component-window">
        <div
          className={`top-bar${isMac ? ' mac-titlebar' : ''}`}
          data-tauri-drag-region
          onMouseDown={titleBarMouseDown}
        />
        <div className="hint">
          {message ||
            (received ? 'This component is no longer in the project.' : 'Loading component…')}
        </div>
      </div>
    )
  }
  const { data } = component
  const path = absolutePath(project.root, data.path)
  return (
    <div className="component-window" style={{ '--kind': KIND_COLOR[data.kind] } as CSSProperties}>
      <NavigationDialogs />
      <header className="window-header">
        <span className="kind-badge">{data.kind}</span>
        <strong>{data.name}</strong>
        <code className="window-path" title={path}>
          {path}
        </code>
        {changes > 0 && (
          <span className="git-badge" title={`${changes} uncommitted change(s)`}>
            ±{changes}
          </span>
        )}
        <button onClick={() => void openInEditor({ path: data.path })}>Open in editor</button>
        <button
          onClick={() =>
            void revealPath(data.path).catch((e) => useStore.getState().setMessage(String(e)))
          }
        >
          {revealLabel}
        </button>
      </header>
      {message && (
        <div className="window-message" role="status">
          {message}
        </div>
      )}
      <PersistedGroup layoutId="ComponentWindow-1" orientation="horizontal" className="workspace">
        <Panel id="ComponentWindow-pane-1" defaultSize="28" minSize="15">
          <div className="side-tabs-panel">
            <div className="side-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'files'}
                className={tab === 'files' ? 'active' : ''}
                onClick={() => changeTab('files')}
              >
                Files
              </button>
              <button
                role="tab"
                aria-selected={tab === 'changes'}
                className={tab === 'changes' ? 'active' : ''}
                onClick={() => changeTab('changes')}
              >
                Changes{changes > 0 && <span className="git-badge">±{changes}</span>}
              </button>
            </div>
            <div className="side-tab-content">
              {tab === 'files' ? (
                <FileTree
                  key={`${project.root}/${data.path}`}
                  path={data.path}
                  componentId={id}
                  agentMarks={false}
                />
              ) : (
                <ChangesPanel componentId={id} />
              )}
            </div>
          </div>
        </Panel>
        <Separator className="separator" />
        <Panel id="ComponentWindow-pane-2" defaultSize="72" minSize="30">
          <TerminalGrid
            componentId={id}
            terminals={data.terminals}
            emptyMessage="Add a dev server, test runner or agent in the main window’s Inspector for this component."
          />
        </Panel>
      </PersistedGroup>
    </div>
  )
}
