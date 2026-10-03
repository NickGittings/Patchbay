import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { terminalResize, terminalWrite } from './ipc'

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
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
    term.onData((d) => void terminalWrite(sessionId, d).catch(() => {}))
    const el = document.createElement('div')
    el.className = 'xterm-host'
    e = { term, fit, el, opened: false }
    registry.set(sessionId, e)
  }
  return e
}

export function writeOutput(sessionId: string, data: number[]) {
  entry(sessionId).term.write(new Uint8Array(data))
}

/** Drain previously queued writes before replacing them with retained backend output. */
export function restoreOutput(sessionId: string, data: number[]): Promise<void> {
  const { term } = entry(sessionId)
  return new Promise((resolve) => {
    term.write('', () => {
      term.reset()
      term.write(new Uint8Array(data), resolve)
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

export function fit(sessionId: string) {
  const e = registry.get(sessionId)
  if (!e?.opened) return
  try {
    e.fit.fit()
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
