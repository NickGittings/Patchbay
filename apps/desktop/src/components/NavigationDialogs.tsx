import { useEffect, useState } from 'react'
import { editorDiscover, editorPreferences, editorSavePreferences, fileSearch } from '../lib/ipc'
import {
  configureEditor,
  EDITOR_SETTINGS_EVENT,
  FILE_SEARCH_EVENT,
  openInEditor,
} from '../lib/navigation'
import { useStore } from '../store'
import type { EditorKind, EditorLauncher, EditorPreferences, FileSearchResult } from '../types'

const labels: Record<EditorKind, string> = {
  vsCode: 'VS Code',
  cursor: 'Cursor',
  zed: 'Zed',
  custom: 'Custom executable',
}
function PreferredEditorDialog() {
  const [open, setOpen] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [preferences, setPreferences] = useState<EditorPreferences>()
  const [launchers, setLaunchers] = useState<EditorLauncher[]>([])
  const [argumentsText, setArgumentsText] = useState('[]')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const show = (e: Event) => {
      setExplanation((e as CustomEvent<string>).detail ?? '')
      setPreferences(undefined)
      setError('')
      setOpen(true)
    }
    window.addEventListener(EDITOR_SETTINGS_EVENT, show)
    return () => window.removeEventListener(EDITOR_SETTINGS_EVENT, show)
  }, [])
  useEffect(() => {
    if (!open) return
    let disposed = false
    void Promise.all([editorPreferences(), editorDiscover()])
      .then(([prefs, available]) => {
        if (disposed) return
        setPreferences(prefs)
        setArgumentsText(JSON.stringify(prefs.arguments, null, 2))
        setLaunchers(available)
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [open])
  if (!open) return null
  const save = async () => {
    if (!preferences) return
    setBusy(true)
    try {
      const args: unknown = JSON.parse(argumentsText)
      if (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))
        throw new Error('Arguments must be a JSON array of strings.')
      await editorSavePreferences({ ...preferences, arguments: args })
      setOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="extension-overlay"
      onClick={() => {
        if (!busy) setOpen(false)
      }}
    >
      <div
        className="command-palette editor-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Preferred editor"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) setOpen(false)
        }}
      >
        <h3>Preferred editor</h3>
        {explanation && <p role="status">{explanation}</p>}
        {preferences && (
          <>
            <label>
              Editor
              <select
                autoFocus
                value={preferences.editor}
                onChange={(e) =>
                  setPreferences({ ...preferences, editor: e.target.value as EditorKind })
                }
              >
                {Object.entries(labels).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {preferences.editor === 'custom' ? (
              <>
                <label>
                  Executable
                  <input
                    value={preferences.executable}
                    placeholder="Absolute executable path or launcher name"
                    onChange={(e) => setPreferences({ ...preferences, executable: e.target.value })}
                  />
                </label>
                <label>
                  Argument array (JSON)
                  <textarea
                    rows={5}
                    value={argumentsText}
                    onChange={(e) => setArgumentsText(e.target.value)}
                  />
                </label>
                <p className="hint">
                  Use {'{folder}'}, {'{file}'}, {'{line}'}, and {'{column}'} in separate arguments.
                  A file's folder is its parent. Arguments are passed literally.
                </p>
              </>
            ) : (
              <p className="hint">
                {launchers.find((l) => l.editor === preferences.editor)?.executable ??
                  'Launcher unavailable. Install the editor command-line launcher or choose a custom executable.'}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="file-tree-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !preferences} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
function FileSearchDialog() {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const scope = JSON.stringify([projectId, task, query])
  const [response, setResponse] = useState<{
    scope: string
    items: FileSearchResult[]
    error?: string
  }>()
  useEffect(() => {
    const show = () => {
      setQuery('')
      setIndex(0)
      setOpen(true)
    }
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        show()
      }
    }
    window.addEventListener(FILE_SEARCH_EVENT, show)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener(FILE_SEARCH_EVENT, show)
      window.removeEventListener('keydown', key)
    }
  }, [])
  useEffect(() => {
    if (!open || !projectId) return
    let disposed = false
    const timer = setTimeout(() => {
      void fileSearch(query, projectId, task)
        .then((items) => {
          if (!disposed) {
            setResponse({ scope, items })
            setIndex(0)
          }
        })
        .catch((e) => {
          if (!disposed) setResponse({ scope, items: [], error: String(e) })
        })
    }, 120)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [open, projectId, task, query, scope])
  if (!open) return null
  const current = response?.scope === scope ? response : undefined
  const items = current?.items ?? []
  const selected = Math.min(index, Math.max(0, items.length - 1))
  const execute = (item: FileSearchResult) => {
    if (!projectId || response?.scope !== scope) return
    setOpen(false)
    void openInEditor({ path: item.path }, { projectId, task })
  }
  return (
    <div className="extension-overlay" onClick={() => setOpen(false)}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Quick file search"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          placeholder="Search filenames and paths…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false)
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex(Math.min(selected + 1, items.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex(Math.max(selected - 1, 0))
            }
            if (e.key === 'Enter' && items[selected]) execute(items[selected])
          }}
        />
        <div role="listbox" aria-label="Files">
          {items.map((item, i) => (
            <button
              key={item.path}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'active' : ''}
              onClick={() => execute(item)}
            >
              {item.name}
              <small>{item.path}</small>
            </button>
          ))}
        </div>
        {!projectId ? (
          <p>Open a project to search files.</p>
        ) : current?.error ? (
          <p role="alert">{current.error}</p>
        ) : !current ? (
          <p>Searching…</p>
        ) : !items.length ? (
          <p>No matching files.</p>
        ) : (
          <p className="hint">Up to 100 results · opens in your preferred editor</p>
        )}
        <button onClick={() => configureEditor()}>Preferred editor…</button>
      </div>
    </div>
  )
}
/** Also mounted in component pop-outs so links and file search share the same settings. */
export default function NavigationDialogs() {
  return (
    <>
      <FileSearchDialog />
      <PreferredEditorDialog />
    </>
  )
}
