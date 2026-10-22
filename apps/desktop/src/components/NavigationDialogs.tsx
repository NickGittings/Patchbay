import UnifiedSearch from './UnifiedSearch'
import { useEffect, useState } from 'react'
import { editorDiscover, editorPreferences, editorSavePreferences } from '../lib/ipc'
import { EDITOR_SETTINGS_EVENT } from '../lib/navigation'
import type { EditorKind, EditorLauncher, EditorPreferences } from '../types'

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
/** Also mounted in pop-outs for editor settings. */
export default function NavigationDialogs({ settingsOnly = false }: { settingsOnly?: boolean }) {
  return (
    <>
      {!settingsOnly && <UnifiedSearch filesOnly />}
      <PreferredEditorDialog />
    </>
  )
}
