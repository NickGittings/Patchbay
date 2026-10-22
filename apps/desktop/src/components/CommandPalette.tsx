import { mapEditsBlocked } from '../lib/mapSave'
import { configureEditor, showFileSearch } from '../lib/navigation'
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { saveCurrentProject, useAddFolder, useOpenProject, useRescanProject } from '../lib/project'
import { offerDependencies } from '../lib/dependencies'
import { arrangeNow } from '../lib/arrange'
import { executeExtensionCommand } from '../extensions/host'
import { commandVisible, useWhenContext } from '../extensions/whenContext'

export default function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const commands = useStore((s) => s.commands)
  const project = useStore((s) => s.project)
  const nodeCount = useStore((s) => s.nodes.length)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  // Start clean however it was opened (shortcut, toolbar search button).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }
  const context = useWhenContext(undefined, open)
  const openFolder = useOpenProject()
  const rescan = useRescanProject()
  const addFolder = useAddFolder()
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const builtin = [
    { id: 'open', title: 'Open folder…', run: openFolder },
    { id: 'editor', title: 'Preferred editor…', run: () => configureEditor() },
    { id: 'files', title: 'Search files…', run: showFileSearch },
    {
      id: 'extensions',
      title: 'Extensions',
      run: () => useStore.getState().setExtensionsPanelOpen(true),
    },
    ...(project
      ? [
          {
            id: 'save',
            title:
              entry?.fingerprint === 'absent'
                ? 'Create map configuration'
                : 'Save map configuration now',
            run: saveCurrentProject,
          },
          { id: 'rescan', title: 'Rescan project', run: rescan },
          ...(mapEditsBlocked(entry)
            ? []
            : [
                {
                  id: 'detect-dependencies',
                  title: 'Detect dependencies…',
                  run: () => offerDependencies(project.id),
                },
                ...(nodeCount < 2
                  ? []
                  : [
                      {
                        id: 'arrange-map',
                        title: 'Arrange map',
                        run: () => arrangeNow(project.id),
                      },
                    ]),
              ]),
          { id: 'add-folder', title: 'Add repo…', run: addFolder },
          ...(['navigation', 'plan', 'implementation'] as const).map((view) => ({
            id: view,
            title: `View: ${view}`,
            run: () => useStore.getState().setView(view),
          })),
        ]
      : []),
  ]
  const items = [
    ...builtin,
    ...commands
      .filter((c) => commandVisible(c, context))
      .map((c) => ({ ...c, run: () => executeExtensionCommand(c.id) })),
  ].filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(query.toLowerCase()))
  const selected = Math.min(index, Math.max(0, items.length - 1))
  const execute = (item: (typeof items)[number]) => {
    useStore.getState().setPaletteOpen(false)
    void Promise.resolve()
      .then(item.run)
      .catch((e) => useStore.getState().setMessage(String(e)))
  }
  if (!open) return null
  return (
    <div className="extension-overlay" onClick={() => useStore.getState().setPaletteOpen(false)}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') useStore.getState().setPaletteOpen(false)
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
        <div role="listbox" aria-label="Commands">
          {items.map((item, i) => (
            <button
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'active' : ''}
              key={item.id}
              data-command-id={item.id}
              onClick={() => execute(item)}
            >
              {item.title}
              <small>{item.id}</small>
            </button>
          ))}
        </div>
        {!items.length && <p>No matching commands.</p>}
      </div>
    </div>
  )
}
