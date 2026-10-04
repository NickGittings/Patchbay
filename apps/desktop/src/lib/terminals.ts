import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { terminalResize, terminalWrite } from './ipc'
import { ownsSession } from './windows'

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  replaying: boolean
}

/** One long-lived xterm per session so scrollback survives tab switches and restarts. */
const registry = new Map<string, Entry>()

const theme = {
  background: '#0e0f13',
  foreground: '#d8d8de',
  cursor: '#f5a524',
  selectionBackground: '#3a3f4b',
}

function entry(sessionId: string): Entry {
  let e = registry.get(sessionId)
  if (!e) {
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 10000,
      theme,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const el = document.createElement('div')
    el.className = 'xterm-host'
    const created = { term, fit, el, opened: false, replaying: false }
    // onData carries both typing and xterm's automatic replies to terminal queries. Every
    // window showing the session parses its output, so only one may reply: the focused
    // window (which is where typing happens) or, failing that, the session's owner.
    term.onData((d) => {
      if (created.replaying || !(document.hasFocus() || ownsSession(sessionId))) return
      void terminalWrite(sessionId, d).catch(() => {})
    })
    e = created
    registry.set(sessionId, e)
  }
  return e
}

export function writeOutput(sessionId: string, data: number[] | Uint8Array) {
  entry(sessionId).term.write(data instanceof Uint8Array ? data : new Uint8Array(data))
}

/** Append retained output that already ran, without answering the queries in it. */
export function replayOutput(sessionId: string, data: Uint8Array) {
  const e = entry(sessionId)
  e.term.write('', () => (e.replaying = true))
  e.term.write(data, () => (e.replaying = false))
}

/** Drain previously queued writes before replacing them with retained backend output. */
export function restoreOutput(sessionId: string, data: Uint8Array): Promise<void> {
  const e = entry(sessionId)
  const { term } = e
  return new Promise((resolve) => {
    term.write('', () => {
      // Parsing historical terminal queries must not send replies to the live PTY.
      e.replaying = true
      term.reset()
      term.write(data, () => {
        e.replaying = false
        resolve()
      })
    })
  })
}

export function writeNote(sessionId: string, text: string) {
  entry(sessionId).term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

/** Move the session's terminal into `container` and size it to fit. */
export function attach(sessionId: string, container: HTMLElement, options?: { focus?: boolean }) {
  const e = entry(sessionId)
  if (e.el.parentElement !== container) container.replaceChildren(e.el)
  if (!e.opened) {
    e.term.open(e.el)
    e.opened = true
  }
  fit(sessionId)
  if (options?.focus !== false) e.term.focus()
}

/** Focus the session's terminal if it is on screen. */
export function focusTerminal(sessionId: string) {
  const e = registry.get(sessionId)
  if (e?.opened && e.el.isConnected) e.term.focus()
}

/**
 * Fit the xterm to its container. Only the session's owner (see `ownsSession`) resizes the
 * shared PTY, so a session shown in the dock and in a pop-out doesn't flip between sizes.
 */
export function fit(sessionId: string) {
  const e = registry.get(sessionId)
  if (!e?.opened) return
  try {
    e.fit.fit()
    if (!ownsSession(sessionId)) return
    void terminalResize(sessionId, e.term.cols, e.term.rows).catch(() => {})
  } catch {
    // container not laid out yet
  }
}

export function disposeAll() {
  for (const e of registry.values()) e.term.dispose()
  registry.clear()
}

/** Visible text and size of a session's terminal, for the dev-only smoke test. */
export function terminalText(sessionId: string) {
  const e = registry.get(sessionId)
  if (!e) return { text: '', cols: 0, rows: 0 }
  const buffer = e.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++)
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return { text: lines.join('\n'), cols: e.term.cols, rows: e.term.rows }
}
