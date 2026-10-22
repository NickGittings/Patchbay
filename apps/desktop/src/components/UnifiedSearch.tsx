import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { fileSearch } from '../lib/ipc'
import { FILE_SEARCH_EVENT, openInEditor } from '../lib/navigation'
import { commandVisible, useWhenContext } from '../extensions/whenContext'
import { executeExtensionCommand } from '../extensions/host'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'
import type { FileSearchResult } from '../types'
import { mod, shiftMod } from '../lib/platform'

export default function UnifiedSearch({
  actions = [],
  filesOnly = false,
}: {
  actions?: WorkspaceAction[]
  filesOnly?: boolean
}) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const worktree = useStore((s) => s.tasks.find((t) => t.id === s.activeTask)?.worktree)
  const commands = useStore((s) => s.commands)
  const [open, setOpen] = useState(false)
  const [priority, setPriority] = useState<'Files' | 'Commands'>('Files')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState({ scope: '', id: '' })
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const context = useWhenContext(undefined, open)
  // Only what `fileSearch` reads, so switching priority keeps its results.
  const scope = JSON.stringify([projectId, task, query])
  const [response, setResponse] = useState<{
    scope: string
    items: FileSearchResult[]
    error?: string
  }>()
  const close = (restore = false) => {
    setOpen(false)
    const store = useStore.getState()
    if (store.paletteOpen) store.setPaletteOpen(false)
    if (restore) previousFocus.current?.focus()
  }
  useEffect(() => {
    const show = (group: 'Files' | 'Commands') => {
      if (document.activeElement !== input.current)
        previousFocus.current = document.activeElement as HTMLElement
      setPriority(group)
      setQuery('')
      setSelection({ scope: '', id: '' })
      setOpen(true)
      input.current?.focus()
    }
    const files = () => show('Files')
    const key = (e: KeyboardEvent) => {
      // Pop-outs have no command search, so Shift variants reach the terminal.
      if (filesOnly && e.shiftKey) return
      const terminal = e.target instanceof Element && !!e.target.closest('.xterm')
      if ((e.metaKey || (e.ctrlKey && (!terminal || e.shiftKey))) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        show(e.shiftKey && !filesOnly ? 'Commands' : 'Files')
      }
    }
    window.addEventListener(FILE_SEARCH_EVENT, files)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener(FILE_SEARCH_EVENT, files)
      window.removeEventListener('keydown', key, true)
    }
  }, [filesOnly])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false)
        const store = useStore.getState()
        if (store.paletteOpen) store.setPaletteOpen(false)
      }
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {
    if (filesOnly) return
    const sync = () => {
      if (useStore.getState().paletteOpen) {
        setPriority('Commands')
        setQuery('')
        setSelection({ scope: '', id: '' })
        setOpen(true)
        if (document.activeElement !== input.current)
          previousFocus.current = document.activeElement as HTMLElement
        input.current?.focus()
      } else setOpen(false)
    }
    sync()
    return useStore.subscribe((s, previous) => {
      if (s.paletteOpen !== previous.paletteOpen) sync()
    })
  }, [filesOnly])
  useEffect(() => {
    if (!open || !projectId) return
    let disposed = false
    const timer = setTimeout(() => {
      void fileSearch(query, projectId, task).then(
        (items) => {
          if (!disposed) setResponse({ scope, items })
        },
        (error: unknown) => {
          if (!disposed) setResponse({ scope, items: [], error: String(error) })
        },
      )
    }, 120)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [open, projectId, task, query, scope])
  const current = response?.scope === scope ? response : undefined
  const fileItems = (current?.items ?? []).map((file) => ({
    id: `file:${file.path}`,
    title: file.name,
    detail: file.path,
    group: 'Files',
    run: () => {
      if (projectId) void openInEditor({ path: file.path }, { projectId, task, worktree })
    },
  }))
  const commandItems = filesOnly
    ? []
    : [
        ...actions
          .filter((a) => a.enabled)
          .map((a) => ({ id: a.id, title: a.title, run: () => runWorkspaceAction(a) })),
        ...commands
          .filter((c) => commandVisible(c, context))
          .map((c) => ({
            id: c.id,
            title: c.title,
            run: () => executeExtensionCommand(c.id, [], context.component?.id),
          })),
      ]
        .filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(query.toLowerCase()))
        .map((c) => ({ ...c, detail: c.id, group: 'Commands' }))
  const items =
    priority === 'Files' ? [...fileItems, ...commandItems] : [...commandItems, ...fileItems]
  // Files mode never falls back to an implicit command selection, even on an empty/error result.
  // Remember explicit selections by identity so late file results cannot change the action.
  const explicit = selection.scope === scope ? items.findIndex((i) => i.id === selection.id) : -1
  const selected = explicit >= 0 ? explicit : items.findIndex((i) => i.group === priority)
  useEffect(() => {
    if (open)
      document.getElementById(`search-result-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])
  const execute = (item: (typeof items)[number]) => {
    close()
    input.current?.blur()
    void Promise.resolve()
      .then(item.run)
      .catch((e) => useStore.getState().setMessage(String(e)))
  }
  return (
    <div className="unified-search" ref={root}>
      <input
        ref={input}
        role="combobox"
        aria-label={filesOnly ? 'Search files' : 'Search files and commands'}
        aria-expanded={open}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && items[selected] ? `search-result-${selected}` : undefined}
        placeholder={
          filesOnly
            ? `Search files…  ${mod}P`
            : `Search files and commands…  ${mod}P / ${shiftMod}P`
        }
        value={query}
        onPointerDown={() => {
          if (document.activeElement !== input.current)
            previousFocus.current = document.activeElement as HTMLElement
        }}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true)
          setQuery(e.target.value)
          setSelection({ scope: '', id: '' })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close(true)
            input.current?.blur()
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const next =
              selected < 0
                ? e.key === 'ArrowDown'
                  ? 0
                  : items.length - 1
                : Math.max(
                    0,
                    Math.min(items.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)),
                  )
            setSelection({ scope, id: items[next]?.id ?? '' })
          }
          if (e.key === 'Enter' && open) {
            e.preventDefault()
            if (items[selected]) execute(items[selected])
          }
          if (e.key === 'Tab') close()
        }}
      />
      {open && (
        <div
          className="search-results"
          id="search-results"
          role="listbox"
          aria-label={filesOnly ? 'Files' : 'Files and Commands'}
        >
          {(priority === 'Files' ? ['Files', 'Commands'] : ['Commands', 'Files'])
            .filter((g) => !filesOnly || g === 'Files')
            .map((group) => (
              <div role="group" aria-label={group} key={group}>
                <h3>{group}</h3>
                {items.map(
                  (item, i) =>
                    item.group === group && (
                      <button
                        key={item.id}
                        id={`search-result-${i}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={i === selected}
                        className={i === selected ? 'active' : ''}
                        data-command-id={group === 'Commands' ? item.id : undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => execute(item)}
                      >
                        {item.title}
                        <small>{item.detail}</small>
                      </button>
                    ),
                )}
                {group === 'Files' &&
                  (!projectId ? (
                    <p>Open a project to search files.</p>
                  ) : current?.error ? (
                    <p role="alert">{current.error}</p>
                  ) : !current ? (
                    <p role="status">Searching…</p>
                  ) : (
                    !fileItems.length && <p>No matching files.</p>
                  ))}
                {group === 'Commands' && !commandItems.length && <p>No matching commands.</p>}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
