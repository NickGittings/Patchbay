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
  const [selection, setSelection] = useState({ scope: '', index: 0 })
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const context = useWhenContext(undefined, open)
  const scope = JSON.stringify([projectId, task, worktree, query])
  const index = selection.scope === scope ? selection.index : 0
  const [response, setResponse] = useState<{
    scope: string
    items: FileSearchResult[]
    error?: string
  }>()
  const close = (restore = false) => {
    setOpen(false)
    useStore.getState().setPaletteOpen(false)
    if (restore) previousFocus.current?.focus()
  }
  useEffect(() => {
    const show = (group: 'Files' | 'Commands') => {
      if (document.activeElement !== input.current)
        previousFocus.current = document.activeElement as HTMLElement
      setPriority(group)
      setQuery('')
      setSelection({ scope: '', index: 0 })
      setOpen(true)
      input.current?.focus()
    }
    const files = () => show('Files')
    const key = (e: KeyboardEvent) => {
      const terminal = e.target instanceof Element && !!e.target.closest('.xterm')
      if ((e.metaKey || (e.ctrlKey && (!terminal || e.shiftKey))) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        e.stopPropagation()
        show(e.shiftKey && !filesOnly ? 'Commands' : 'Files')
      }
    }
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    window.addEventListener(FILE_SEARCH_EVENT, files)
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener(FILE_SEARCH_EVENT, files)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', outside)
    }
  }, [filesOnly])
  useEffect(() => {
    if (filesOnly) return
    const sync = () => {
      if (useStore.getState().paletteOpen) {
        setPriority('Commands')
        setQuery('')
        setSelection({ scope: '', index: 0 })
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
  const selected = Math.min(index, Math.max(0, items.length - 1))
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
        aria-label="Search files and commands"
        aria-expanded={open}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && items[selected] ? `search-result-${selected}` : undefined}
        placeholder={`Search files and commands…  ${mod}P / ${shiftMod}P`}
        value={query}
        onPointerDown={() => {
          if (document.activeElement !== input.current)
            previousFocus.current = document.activeElement as HTMLElement
        }}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelection({ scope: '', index: 0 })
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
            setSelection({
              scope,
              index: Math.max(
                0,
                Math.min(items.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)),
              ),
            })
          }
          if (e.key === 'Enter' && items[selected]) {
            e.preventDefault()
            execute(items[selected])
          }
          if (e.key === 'Tab') close()
        }}
      />
      {open && (
        <div
          className="search-results"
          id="search-results"
          role="listbox"
          aria-label="Files and Commands"
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
