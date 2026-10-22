import { openTerminalReference, terminalReferences } from './navigation'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type IBufferLine, type ILink, type IMarker, type ITheme } from '@xterm/xterm'
import { terminalResize, terminalWrite } from './ipc'
import { useStore } from '../store'

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  replaying: boolean
  hosts: HTMLElement[]
  generations: { generation: number; marker: IMarker }[]
  generation?: number
}

/** One long-lived xterm per session so scrollback survives tab switches and restarts. */
const registry = new Map<string, Entry>()

/** xterm takes resolved colors rather than CSS variable references. */
function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  const color = (variable: string) => styles.getPropertyValue(variable).trim()
  return {
    background: color('--bg'),
    foreground: color('--text'),
    cursor: color('--text'),
    cursorAccent: color('--bg'),
    selectionBackground: color('--terminal-selection'),
    black: color('--hover'),
    red: color('--bad'),
    green: color('--ok'),
    yellow: color('--terminal-yellow'),
    blue: color('--terminal-blue'),
    magenta: color('--terminal-magenta'),
    cyan: color('--running'),
    white: color('--terminal-white'),
    brightBlack: color('--terminal-bright-black'),
    brightRed: color('--terminal-bright-red'),
    brightGreen: color('--terminal-bright-green'),
    brightYellow: color('--terminal-bright-yellow'),
    brightBlue: color('--terminal-bright-blue'),
    brightMagenta: color('--terminal-bright-magenta'),
    brightCyan: color('--terminal-bright-cyan'),
    brightWhite: color('--terminal-bright-white'),
  }
}

let themeObserver: MutationObserver | undefined
let themeSignature = ''
function refreshTheme() {
  const theme = terminalTheme()
  const signature = JSON.stringify(theme)
  if (signature === themeSignature) return
  themeSignature = signature
  for (const { term } of registry.values()) term.options.theme = theme
}
function observeTheme() {
  if (themeObserver) return
  themeObserver = new MutationObserver(refreshTheme)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  })
}

/** Map UTF-16 string offsets onto xterm cell columns (wide and combining characters). */
function cellColumn(line: IBufferLine, offset: number): number {
  let chars = 0
  for (let column = 0; column < line.length; column++) {
    const cell = line.getCell(column)
    if (!cell || cell.getWidth() === 0) continue
    const length = (cell.getChars() || ' ').length
    if (chars + length > offset) return column
    chars += length
  }
  return line.length
}

/** Reassemble soft-wrapped output before parsing; ranges stay in terminal cell coordinates. */
function terminalFileLinks(
  term: Terminal,
  sid: string,
  line: number,
): (ILink & { generation?: number })[] {
  const buffer = term.buffer.active
  let first = line - 1
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  const segments: { line: IBufferLine; row: number; offset: number; text: string }[] = []
  let text = ''
  for (let row = first; row < buffer.length; row++) {
    const current = buffer.getLine(row)
    if (!current) break
    const continues = buffer.getLine(row + 1)?.isWrapped ?? false
    const value = current.translateToString(!continues)
    segments.push({ line: current, row: row + 1, offset: text.length, text: value })
    text += value
    if (!continues) break
  }
  const locate = (offset: number, end = false) => {
    const segment = [...segments].reverse().find((s) => s.offset <= offset)
    if (!segment) return { x: 1, y: line }
    const column = cellColumn(segment.line, offset - segment.offset)
    const width = end ? (segment.line.getCell(column)?.getWidth() ?? 1) : 1
    return { x: column + width, y: segment.row }
  }
  return terminalReferences(text)
    .map((match) => {
      const start = locate(match.index ?? 0)
      const generation =
        buffer.type === 'alternate'
          ? registry.get(sid)?.generation
          : registry
              .get(sid)
              // A disposed marker scrolled out of the top, so its run covers the oldest lines.
              ?.generations.filter((g) => g.marker.isDisposed || g.marker.line <= start.y - 1)
              .at(-1)?.generation
      return {
        text: match[0],
        generation,
        range: {
          start,
          end: locate((match.index ?? 0) + match[0].length - 1, true),
        },
        decorations: { pointerCursor: false, underline: true },
        activate(event: MouseEvent, reference: string) {
          if ((event.metaKey || event.ctrlKey) && !term.hasSelection())
            void openTerminalReference(sid, reference, generation)
        },
      }
    })
    .filter((link) => link.range.start.y <= line && link.range.end.y >= line)
}

function entry(sessionId: string): Entry {
  let e = registry.get(sessionId)
  if (!e) {
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: false,
      scrollback: 10000,
      theme: terminalTheme(),
    })
    // The cursor never blinks: honour an app's cursor shape (DECSCUSR) but not its blink, and
    // undo the blink mode (`?12h`) after xterm applies the rest of the sequence.
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const style = Number(params[0]) || 0
      term.options.cursorStyle = style <= 2 ? 'block' : style <= 4 ? 'underline' : 'bar'
      return true
    })
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(12)) queueMicrotask(() => (term.options.cursorBlink = false))
      return false
    })
    // xterm restores its saved cursor even when 1049l is sent in the normal buffer.
    // Check at parse time so queued output that switches buffers is handled in order.
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      return params.length === 1 && params[0] === 1049 && term.buffer.active.type === 'normal'
    })
    term.registerLinkProvider({
      provideLinks(line, callback) {
        callback(terminalFileLinks(term, sessionId, line))
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const el = document.createElement('div')
    el.className = 'xterm-host'
    const created: Entry = {
      term,
      fit,
      el,
      opened: false,
      replaying: false,
      hosts: [],
      generations: [],
    }
    // Both typing and automatic replies go through the service's single-viewer authority.
    // Hidden, detached terminals retain output without replying to live queries.
    term.onData((d) => {
      if (
        !useStore.getState().serviceConnected ||
        created.replaying ||
        document.visibilityState !== 'visible' ||
        !created.hosts.some(hostVisible)
      )
        return
      void terminalWrite(sessionId, d).catch(() => {})
    })
    e = created
    registry.set(sessionId, e)
    observeTheme()
  }
  return e
}

/** Scrollback retains earlier runs; markers keep links bound to the output's generation. */
export function markOutputGeneration(sid: string, generation: number, offset = 0) {
  const e = entry(sid)
  e.term.write('', () => {
    e.generation = generation
    // Markers are in output order, so the disposed ones lead; keep the newest, whose run
    // still owns the lines above the first live marker.
    e.generations = e.generations.filter(
      (g, i, all) => !g.marker.isDisposed || !all[i + 1]?.marker.isDisposed,
    )
    const marker = e.term.registerMarker(offset)
    if (marker) e.generations.push({ generation, marker })
  })
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
export function restoreOutput(
  sessionId: string,
  data: Uint8Array,
  generation: number,
): Promise<void> {
  const e = entry(sessionId)
  const { term } = e
  return new Promise((resolve) => {
    term.write('', () => {
      // Parsing historical terminal queries must not send replies to the live PTY.
      e.replaying = true
      term.reset()
      e.generation = generation
      e.generations = []
      const marker = term.registerMarker()
      if (marker) e.generations.push({ generation, marker })
      term.write(data, () => {
        e.replaying = false
        resolve()
      })
    })
  })
}

/**
 * Undo the modes a killed TUI left on (alternate screen, scroll region, mouse tracking, hidden
 * cursor, key modes, colors) so the next run draws cleanly, keeping earlier scrollback.
 */
export function restoreModes(sessionId: string) {
  const { term } = entry(sessionId)
  term.write('\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1006l\x1b[2 q\r')
}

export function writeNote(sessionId: string, text: string) {
  entry(sessionId).term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

/** Views unmount their hosts; CSS visibility and size cover collapsed panes and hidden tabs. */
export function hostVisible(host: HTMLElement): boolean {
  if (!host.isConnected) return false
  if (host.checkVisibility && !host.checkVisibility({ checkVisibilityCSS: true })) return false
  if (!host.getBoundingClientRect) return true
  const { width, height } = host.getBoundingClientRect()
  return width > 0 && height > 0
}
export const hasVisibleTerminal = (sid: string) =>
  document.visibilityState === 'visible' && (registry.get(sid)?.hosts.some(hostVisible) ?? false)
export const ownsTerminalHost = (sid: string, host: HTMLElement) =>
  registry.get(sid)?.el.parentElement === host && hostVisible(host)

/** Move the session's terminal into `container` and size it to fit. */
export function attach(sessionId: string, container: HTMLElement, options?: { focus?: boolean }) {
  if (!hostVisible(container)) return
  const e = entry(sessionId)
  e.hosts = e.hosts.filter((host) => host.isConnected)
  if (!e.hosts.includes(container)) e.hosts.push(container)
  if (e.hosts.filter(hostVisible).at(-1) !== container) return
  if (e.el.parentElement !== container) container.replaceChildren(e.el)
  refreshTheme()
  if (!e.opened) {
    e.term.open(e.el)
    // WebKit offers Writing Tools / inline predictions on editable fields; a PTY can't use them.
    e.term.textarea?.setAttribute('writingsuggestions', 'false')
    e.term.textarea?.setAttribute('autocomplete', 'off')
    e.opened = true
  }
  fit(sessionId)
  if (options?.focus !== false) e.term.focus()
}

/**
 * Focus the session's terminal after the current render: from the next animation frame (so a
 * view switch has moved it into its new pane), waiting a few frames for it to attach. Gives up
 * if the user puts focus somewhere else meanwhile.
 */
export function focusTerminal(sessionId: string) {
  const from = document.activeElement
  let frames = 30
  const attempt = () => {
    const active = document.activeElement
    if (active !== from && active !== document.body) return
    const e = registry.get(sessionId)
    if (e?.opened && e.el.isConnected) e.term.focus()
    else if (frames-- > 0) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/** Fit locally; the service accepts PTY sizes only from its authoritative viewer. */
export function fit(sessionId: string) {
  const e = registry.get(sessionId)
  if (!e?.opened || !e.hosts.some(hostVisible)) return
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
  const previous = e.hosts.filter(hostVisible).at(-1)
  if (previous && e.el.parentElement === host) {
    previous.replaceChildren(e.el)
    fit(sessionId)
  }
  return e.hosts.some(hostVisible)
}

export function disposeAll() {
  themeObserver?.disconnect()
  themeObserver = undefined
  themeSignature = ''
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

/** Dev smoke observations use the real xterm buffer and selection machinery. */
export function terminalNavigationState(sid: string, reference: string) {
  const e = registry.get(sid)
  const screen = e?.el.querySelector('.xterm-screen')
  if (!e || !screen) return undefined
  const rect = screen.getBoundingClientRect()
  const buffer = e.term.buffer.active
  for (let y = buffer.viewportY; y < buffer.viewportY + e.term.rows; y++) {
    const link = terminalFileLinks(e.term, sid, y + 1).find((l) => l.text === reference)
    if (!link) continue
    const column = link.range.start.y === y + 1 ? link.range.start.x - 1 : 0
    const width = rect.width / e.term.cols
    return {
      x: rect.left + (column + 0.5) * width,
      y: rect.top + ((y - buffer.viewportY + 0.5) * rect.height) / e.term.rows,
      width,
      selection: e.term.getSelection(),
      reference,
      generation: link.generation,
    }
  }
  return undefined
}
