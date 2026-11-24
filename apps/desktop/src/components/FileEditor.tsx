import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Panel, Separator, useGroupRef } from 'react-resizable-panels'
import PersistedGroup from './PersistedGroup'
import { useCollapsed } from '../lib/useCollapsed'
import { INSPECTOR_PANEL } from '../lib/panelLayout'
import { listen, emitTo } from '@tauri-apps/api/event'
import {
  EDITOR_CLOSE_REQUEST_EVENT,
  FILE_EDITOR_EVENT,
  readTextFile,
  saveTextFile,
  registerEditorGuard,
  type FileRequest,
  type TextFile,
} from '../lib/fileEditor'
import { editorOpen } from '../lib/ipc'
import { MAIN_WINDOW_LABEL } from '../lib/mainWindow'

interface Tab extends FileRequest {
  id: string
  file?: TextFile
  draft: string
  error?: string
  busy?: boolean
}
const normalized = (text: string) => text.replace(/\r\n/g, '\n')
const dirty = (tab: Tab) => !!tab.file && tab.draft !== normalized(tab.file.text)

/** Keep drafts mounted across project and view changes, beside the workspace. */
export default function FileEditor({
  children,
  sidebar,
}: {
  children: ReactNode
  sidebar?: { content: ReactNode; shown: boolean; onClose: () => void }
}) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState('')
  const [reveal, setReveal] = useState(0)
  const group = useGroupRef()
  const panel = useCollapsed('file-editor-pane', tabs.length > 0, reveal, undefined, undefined, {
    group,
    panel: 'file-editor-content',
    defaultSize: 40,
    minSize: 24,
  })
  const sidebarPanel = useCollapsed(
    INSPECTOR_PANEL,
    !!sidebar?.shown,
    undefined,
    sidebar?.onClose,
    undefined,
    { group, panel: 'file-editor-content', defaultSize: 24 },
  )
  const [prompt, setPrompt] = useState<{ id: string; resolve: (value: string) => void }>()
  const current = useRef(tabs)
  current.current = tabs
  const area = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const pendingGuard = useRef<Promise<boolean> | null>(null)
  const update = (id: string, changes: Partial<Tab>) => {
    current.current = current.current.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab))
    setTabs(current.current)
  }
  const load = async (tab: Tab) => {
    update(tab.id, { busy: true, error: undefined })
    try {
      const file = await readTextFile(tab, tab.target.path)
      update(tab.id, { file, draft: normalized(file.text), busy: false })
    } catch (error) {
      update(tab.id, { busy: false, error: String(error) })
    }
  }
  const save = async (tab: Tab) => {
    if (!tab.file || tab.busy) return false
    update(tab.id, { busy: true, error: undefined })
    try {
      const text = tab.file.text.includes('\r\n') ? tab.draft.replace(/\n/g, '\r\n') : tab.draft
      const file = await saveTextFile(tab, tab.file, text)
      update(tab.id, { file, busy: false })
      return true
    } catch (error) {
      update(tab.id, { busy: false, error: String(error) })
      return false
    }
  }
  const allowClose = async (ids: string[]) => {
    for (const id of ids) {
      const tab = current.current.find((t) => t.id === id)
      if (!tab) continue
      if (tab.busy) return false
      if (!dirty(tab)) continue
      setReveal((n) => n + 1)
      void getCurrentWindow().setFocus()
      setActive(id)
      const answer = await new Promise<string>((resolve) => setPrompt({ id, resolve }))
      setPrompt(undefined)
      if (answer === 'cancel') return false
      if (answer === 'save' && !(await save(tab))) return false
      if (answer === 'discard') update(id, { draft: normalized(tab.file!.text) })
    }
    return true
  }
  const guard = () => {
    if (!pendingGuard.current) {
      pendingGuard.current = allowClose(current.current.map((t) => t.id)).finally(() => {
        pendingGuard.current = null
      })
    }
    return pendingGuard.current
  }
  const close = async (id?: string) => {
    if (prompt || pendingGuard.current) return
    if (!(await allowClose(id ? [id] : current.current.map((t) => t.id)))) return
    current.current = id ? current.current.filter((t) => t.id !== id) : []
    setTabs(current.current)
    setActive((selected) =>
      current.current.some((tab) => tab.id === selected)
        ? selected
        : (current.current[0]?.id ?? ''),
    )
  }
  useEffect(() => {
    const open = (event: Event) => {
      const request = (event as CustomEvent<FileRequest>).detail
      const id = JSON.stringify([
        request.projectId,
        request.task,
        request.worktree,
        request.target.path,
      ])
      const existing = current.current.find((tab) => tab.id === id)
      if (!existing) {
        const tab: Tab = { ...request, id, draft: '' }
        current.current = [...current.current, tab]
        setTabs(current.current)
        void load(tab)
      } else update(id, { target: request.target })
      setActive(id)
      setReveal((n) => n + 1)
    }
    window.addEventListener(FILE_EDITOR_EVENT, open)
    const unregister = registerEditorGuard(guard)
    let disposed = false
    let unlisten: (() => void) | undefined
    let stopRequests: (() => void) | undefined
    void listen<{ reply: string; requester: string }>(EDITOR_CLOSE_REQUEST_EVENT, async (event) => {
      const allowed = await guard()
      await emitTo(event.payload.requester, event.payload.reply, allowed)
    }).then((cleanup) => {
      if (disposed) cleanup()
      else stopRequests = cleanup
    })
    // Main-window close is coordinated by workspace.ts; pop-outs need their own guard.
    if (getCurrentWindow().label !== MAIN_WINDOW_LABEL) {
      void getCurrentWindow()
        .onCloseRequested((event) => {
          if (!current.current.some((tab) => dirty(tab) || tab.busy)) return
          event.preventDefault()
          void guard().then((allowed) => {
            if (allowed) void getCurrentWindow().destroy()
          })
        })
        .then((cleanup) => {
          if (disposed) cleanup()
          else unlisten = cleanup
        })
    }
    return () => {
      disposed = true
      unlisten?.()
      stopRequests?.()
      unregister()
      window.removeEventListener(FILE_EDITOR_EVENT, open)
    }
    // Handlers read current tabs through a ref, including during asynchronous saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const tab = tabs.find((t) => t.id === active)
  const loaded = !!tab?.file
  const target = tab?.target
  useEffect(() => {
    if (!loaded || !target || !area.current) return
    const element = area.current
    const lines = element.value.split('\n')
    const line = Math.min(lines.length - 1, Math.max(0, (target.line ?? 1) - 1))
    const offset =
      lines.slice(0, line).reduce((n, text) => n + text.length + 1, 0) +
      Math.min(lines[line].length, Math.max(0, (target.column ?? 1) - 1))
    element.focus()
    element.setSelectionRange(offset, offset)
    element.scrollTop = Math.max(0, line * 20 - element.clientHeight / 2)
    if (gutter.current) gutter.current.scrollTop = element.scrollTop
  }, [active, loaded, target])
  const editor = tab && (
    <aside className="file-editor" aria-label="File editor">
      <header className="file-editor-header">
        <span className="panel-title">File editor</span>
        <button
          aria-label="Close File editor"
          title="Close"
          disabled={!!prompt}
          onClick={() => void close()}
        >
          ×
        </button>
      </header>
      <div className="file-editor-tabs" role="tablist" aria-label="Open files">
        {tabs.map((item) => (
          <div key={item.id} className={`file-editor-tab ${active === item.id ? 'active' : ''}`}>
            <button
              role="tab"
              aria-selected={active === item.id}
              title={item.file?.path ?? item.target.path}
              disabled={!!prompt}
              onClick={() => setActive(item.id)}
            >
              <span className="file-tab-label">{item.target.path.split(/[\\/]/).pop()}</span>
              {dirty(item) && <span aria-label="Unsaved changes">•</span>}
            </button>
            <button
              disabled={!!prompt}
              aria-label={`Close ${item.target.path}`}
              title="Close file"
              onClick={() => void close(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="file-editor-path" title={tab.file?.path ?? tab.target.path}>
        {tab.file?.path ?? tab.target.path}
      </div>
      {tab.error && <p role="alert">{tab.error}</p>}
      {prompt && (
        <div className="file-editor-prompt" role="alertdialog" aria-label="Unsaved changes">
          <p>Save changes before continuing?</p>
          <button onClick={() => prompt.resolve('discard')}>Don’t Save</button>
          <span className="grow" />
          <button onClick={() => prompt.resolve('cancel')}>Cancel</button>
          <button autoFocus className="primary" onClick={() => prompt.resolve('save')}>
            Save
          </button>
        </div>
      )}
      {tab.file && (
        <div className="file-editor-code" role="tabpanel" aria-label={tab.target.path}>
          <pre ref={gutter} aria-hidden="true">
            {tab.draft
              .split('\n')
              .map((_, i) => i + 1)
              .join('\n')}
          </pre>
          <textarea
            key={tab.id}
            ref={area}
            aria-label={`Edit ${tab.target.path}`}
            spellCheck={false}
            wrap="off"
            value={tab.draft}
            readOnly={tab.busy || !!prompt}
            onScroll={(event) => {
              if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop
            }}
            onChange={(event) => update(tab.id, { draft: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                if (!prompt) void save(tab)
              }
            }}
          />
        </div>
      )}
      <footer className="file-editor-footer">
        <span className="hint">
          {tab.busy ? 'Working…' : dirty(tab) ? 'Unsaved changes' : 'Saved'}
        </span>
        <button
          disabled={tab.busy || !!prompt}
          onClick={() =>
            void editorOpen(tab.target, tab.projectId, tab.task, tab.worktree).catch((error) =>
              update(tab.id, { error: String(error) }),
            )
          }
        >
          Open in external editor
        </button>
        <button
          disabled={tab.busy || !!prompt}
          onClick={async () => {
            if (await allowClose([tab.id])) await load(tab)
          }}
        >
          Reload
        </button>
        <button
          className="primary"
          disabled={!dirty(tab) || tab.busy || !!prompt}
          onClick={() => void save(tab)}
        >
          Save
        </button>
      </footer>
    </aside>
  )
  const contentPane = (
    <Panel id="file-editor-content" defaultSize={sidebar ? '76%' : '100%'} minSize="30%">
      <div className="file-editor-content">{children}</div>
    </Panel>
  )
  const editorPane = (
    <Panel id="file-editor-pane" defaultSize="0%" minSize="24%" {...panel.props}>
      {editor}
    </Panel>
  )
  return (
    <PersistedGroup
      layoutId={sidebar ? 'Workspace-panels' : 'FileEditor'}
      group={group}
      orientation="horizontal"
      className="workspace"
    >
      {sidebar && (
        <>
          <Panel id={INSPECTOR_PANEL} defaultSize="24%" minSize="16%" {...sidebarPanel.props}>
            {sidebar.content}
          </Panel>
          <Separator
            className={`separator ${sidebar.shown ? '' : 'hidden'}`}
            disabled={!sidebar.shown}
          />
        </>
      )}
      {sidebar ? editorPane : contentPane}
      <Separator className={`separator ${tabs.length ? '' : 'hidden'}`} disabled={!tabs.length} />
      {sidebar ? contentPane : editorPane}
    </PersistedGroup>
  )
}
