import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { terminalResize, terminalWrite } from './ipc'
import { useStore } from '../store'

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  replaying: boolean
  hosts: HTMLElement[]
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
    const created = { term, fit, el, opened: false, replaying: false, hosts: [] as HTMLElement[] }
    // Both typing and automatic replies go through the service's single-viewer authority.
    // Hidden, detached terminals retain output without replying to live queries.
    term.onData((d) => {
      if (
        !useStore.getState().serviceConnected ||
        created.replaying ||
        document.visibilityState !== 'visible' ||
        !created.hosts.some((host) => host.isConnected)
      )
        return
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
  if (!e.hosts.includes(container)) e.hosts.push(container)
  if (e.hosts.at(-1) !== container) return
  if (e.el.parentElement !== container) container.replaceChildren(e.el)
  if (!e.opened) {
    e.term.open(e.el)
    e.opened = true
  }
  fit(sessionId)
  if (options?.focus !== false) e.term.focus()
}

/** Fit locally; the service accepts PTY sizes only from its authoritative viewer. */
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

/** Return the shared terminal to its previous pane when a Sessions preview closes. */
export function detachHost(sessionId: string, host: HTMLElement): boolean {
  const e = registry.get(sessionId)
  if (!e) return false
  e.hosts = e.hosts.filter((h) => h !== host && h.isConnected)
  const previous = e.hosts.at(-1)
  if (previous && e.el.parentElement === host) {
    previous.replaceChildren(e.el)
    fit(sessionId)
  }
  return e.hosts.length > 0
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
