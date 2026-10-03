import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { useEffect, useState, type CSSProperties } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR } from '../lib/display'
import { revealPath } from '../lib/ipc'
import { listenForTerminals } from '../lib/sessions'
import { absolutePath, GIT_EVENT, PROJECT_EVENT, READY_EVENT } from '../lib/windows'
import { useStore } from '../store'
import { type Project } from '../types'
import FileTree from './FileTree'
import TerminalGrid from './TerminalGrid'

export default function ComponentWindow({ id }: { id: string }) {
  const project = useStore((s) => s.project)
  const component = useStore((s) => s.nodes.find((n) => n.id === id))
  const changes = useStore((s) => s.gitChanges[id] ?? 0)
  const message = useStore((s) => s.message)
  const [received, setReceived] = useState(false)

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
      await register(
        listen<Project>(PROJECT_EVENT, (e) => {
          useStore.getState().syncProject(e.payload)
          setReceived(true)
        }),
      )
      await register(
        listen<Record<string, number>>(GIT_EVENT, (e) => {
          useStore.getState().setGitChanges(e.payload)
        }),
      )
      if (!disposed) {
        await emitTo('main', READY_EVENT, { label: getCurrentWebviewWindow().label })
      }
    })().catch((e) => useStore.getState().setMessage(String(e)))
    return () => {
      disposed = true
      for (const unlisten of cleanup) unlisten()
    }
  }, [])

  const name = component?.data.name
  useEffect(() => {
    if (project && name) {
      void getCurrentWebviewWindow()
        .setTitle(`${project.name} · ${name}`)
        .catch((e) => useStore.getState().setMessage(String(e)))
    }
  }, [project, name])

  if (!project || !component) {
    return (
      <div className="component-window hint">
        {message ||
          (received ? 'This component is no longer in the project.' : 'Loading component…')}
      </div>
    )
  }
  const { data } = component
  const path = absolutePath(project.root, data.path)
  return (
    <div className="component-window" style={{ '--kind': KIND_COLOR[data.kind] } as CSSProperties}>
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
        <button
          onClick={() =>
            void revealPath(data.path).catch((e) => useStore.getState().setMessage(String(e)))
          }
        >
          Reveal in Finder
        </button>
      </header>
      {message && (
        <div className="window-message" role="status">
          {message}
        </div>
      )}
      <Group orientation="horizontal" className="workspace">
        <Panel defaultSize="24" minSize="15">
          <FileTree key={`${project.root}/${data.path}`} root={project.root} path={data.path} />
        </Panel>
        <Separator className="separator" />
        <Panel defaultSize="76" minSize="30">
          <TerminalGrid componentId={id} terminals={data.terminals} />
        </Panel>
      </Group>
    </div>
  )
}
