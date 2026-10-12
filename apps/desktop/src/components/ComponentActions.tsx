import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ExtensionMenu from '../extensions/ExtensionMenu'
import { resolvePath, revealPath } from '../lib/ipc'
import { navigationError, openInEditor, revealLabel } from '../lib/navigation'
import { startTerminal } from '../lib/sessions'
import { activeWorktree } from '../lib/tasks'
import { absolutePath, openComponentWindow } from '../lib/windows'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'

/**
 * Copy `text`. A path still being resolved goes to the clipboard as a promise, so the write keeps
 * the click's user activation (WebKit refuses a clipboard write made after an await).
 */
function copyText(text: string | Promise<string>) {
  if (typeof text === 'string') return navigator.clipboard.writeText(text)
  if (typeof ClipboardItem === 'undefined')
    return text.then((value) => navigator.clipboard.writeText(value))
  const blob = text.then((value) => new Blob([value], { type: 'text/plain' }))
  return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
}

export function ContextMenu({
  at,
  onClose,
  children,
}: {
  at: { x: number; y: number }
  onClose: () => void
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  // Where focus was before the menu took it, handed back when the menu closes unless an action
  // moved it elsewhere (a terminal it started, say).
  useLayoutEffect(() => {
    const previous = document.activeElement
    const el = menu.current
    return () => {
      const active = document.activeElement
      const stranded = !active || active === document.body || !!el?.contains(active)
      if (stranded && previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const place = () => {
      const rect = el.getBoundingClientRect()
      el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8))}px`
      el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8))}px`
    }
    place()
    el.querySelector('button')?.focus()
    // Extension commands appear once their `when` clauses are read, after the menu opened, so it
    // can grow; keep it on screen.
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => observer.disconnect()
  }, [at])
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onClose])
  return createPortal(
    <div
      className="node-menu-overlay nodrag"
      // React events bubble out of the portal to the component that rendered it; on the canvas
      // that is a React Flow node, which would move with the arrow keys or open on a double-click.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        const buttons = [...(menu.current?.querySelectorAll('button') ?? [])]
        if (!buttons.length) return
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          e.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : e.key === 'ArrowUp'
              ? (current <= 0 ? buttons.length : current) - 1
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : -1
        if (next < 0) return
        e.preventDefault()
        buttons[next].focus()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        ref={menu}
        className="node-extension-menu"
        style={{ left: at.x, top: at.y }}
        role="dialog"
        aria-label="Component actions"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function ComponentMenuItems({
  id,
  name,
  path,
  terminals,
  onDone,
}: {
  id: string
  name: string
  path: string
  terminals: TerminalSpec[]
  onDone: () => void
}) {
  const planning = useStore((s) => s.view === 'plan')
  const projectRoot = useStore((s) => s.project?.root)
  // Only these terminals' running flags, so other sessions' output doesn't re-render the menu.
  const running = useStore(
    useShallow((s) =>
      terminals.map((t) => !!s.sessions[sessionId(id, t.id, s.activeTask)]?.running),
    ),
  )
  const act = (action: () => void) => {
    action()
    onDone()
  }
  return (
    <>
      <button onClick={() => act(() => void openInEditor({ path }))}>Open in editor</button>
      <button onClick={() => act(() => void revealPath(path).catch(navigationError))}>
        {revealLabel}
      </button>
      <button
        onClick={() =>
          act(() => {
            // In a task's worktree only the backend knows where the component's folder is.
            const text = activeWorktree(useStore.getState())
              ? resolvePath(path)
              : projectRoot
                ? absolutePath(projectRoot, path)
                : path
            void copyText(text).catch(navigationError)
          })
        }
      >
        Copy path
      </button>
      <button onClick={() => act(() => void openComponentWindow(id, name))}>Open in window</button>
      {!planning && (
        <>
          {terminals.length > 0 && <hr />}
          {terminals.map((t, i) => (
            <button
              key={t.id}
              onClick={() =>
                act(() => {
                  const s = useStore.getState()
                  const sid = sessionId(id, t.id, s.activeTask)
                  s.select(id)
                  s.setActiveSession(sid)
                  if (!s.sessions[sid]?.running) void startTerminal(id, t.id)
                })
              }
            >
              {running[i] ? 'Show' : 'Start'} {t.name}
            </button>
          ))}
        </>
      )}
      <ExtensionMenu slot="component/actions" componentId={id} separator />
    </>
  )
}
