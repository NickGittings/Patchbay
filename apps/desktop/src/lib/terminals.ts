import { openTerminalReference, terminalReferences } from './navigation'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type IBufferLine, type ILink, type IMarker, type ITheme } from '@xterm/xterm'
import { terminalResize, terminalWrite } from './ipc'
import { useStore } from '../store'

interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  replaying: boolean
  hosts: Map<HTMLElement, boolean>
  /** Hosts registered or detached while hidden; showing one moves it last in `hosts`. */
  hiddenHosts: WeakSet<HTMLElement>
  generations: { generation: number; marker: IMarker }[]
  generation?: number
  /** The PTY size this window last sent, so unchanged fits don't signal the program again. */
  sent?: { cols: number; rows: number }
  /** A replayed backlog may be garbled; ask the program to repaint on the next claim. */
  redraw?: boolean
  fitTimer?: ReturnType<typeof setTimeout>
  redrawTimer?: ReturnType<typeof setTimeout>
  finishRestore?: () => void
  webgl?: WebglAddon
  webglLost?: boolean
}

/** A viewed session keeps its xterm across tab switches and restarts. */
const registry = new Map<string, Entry>()
export const terminalIds = () => registry.keys()
export const hasTerminal = (sid: string) => registry.has(sid)
export function hasTerminalHost(sid: string) {
  const e = registry.get(sid)
  if (!e) return false
  for (const host of e.hosts.keys()) if (host.isConnected) return true
  return false
}
/** A drag reflows the terminal and signals its program once it settles, not every frame. */
const FIT_DEBOUNCE_MS = 80
/** Programs read the size when SIGWINCH arrives; two quick resizes can coalesce into none. */
const REDRAW_GAP_MS = 60

/** xterm takes resolved colors rather than CSS variable references. */
export function terminalTheme(): ITheme {
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

/**
 * WebGL draws on-screen terminals (as VS Code does); the DOM renderer is the fallback. WebKit caps
 * live WebGL contexts. Only terminals in an on-screen host hold one, and a lost context leaves
 * that terminal on the DOM renderer.
 */
const WEBGL_LIMIT = 8
let webglCount = 0
let webglRetryScheduled = false
function onScreen(e: Entry) {
  const host = e.el.parentElement
  return !!host && e.hosts.get(host) === true && hostVisible(host)
}
function enableWebgl(e: Entry) {
  if (e.webgl || e.webglLost || !e.opened || webglCount >= WEBGL_LIMIT || !onScreen(e)) return
  if (typeof WebGL2RenderingContext === 'undefined') return
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      e.webglLost = true
      disableWebgl(e)
    })
    e.term.loadAddon(addon)
    e.webgl = addon
    webglCount++
  } catch {
    e.webglLost = true
  }
}
function disableWebgl(e: Entry) {
  const addon = e.webgl
  if (!addon) return
  e.webgl = undefined
  webglCount--
  // A visible terminal may have missed a slot before this host's intersection callback ran.
  if (webglCount === WEBGL_LIMIT - 1 && !webglRetryScheduled) {
    webglRetryScheduled = true
    queueMicrotask(() => {
      webglRetryScheduled = false
      for (const entry of registry.values()) enableWebgl(entry)
    })
  }
  try {
    addon.dispose()
  } catch {
    // already torn down with its context
  }
}

function updateWebgl(e: Entry) {
  if (!e.webgl) enableWebgl(e)
  else if (!onScreen(e)) disableWebgl(e)
}

/** Intersection affects renderer allocation; attached panes still own their PTY. */
export function setOnScreen(sid: string, host: HTMLElement, visible: boolean) {
  const e = registry.get(sid)
  if (!e?.hosts.has(host)) return
  e.hosts.set(host, visible)
  updateWebgl(e)
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
      hosts: new Map(),
      hiddenHosts: new WeakSet(),
      generations: [],
    }
    // Both typing and automatic replies go through the service's single-viewer authority.
    // Hidden, detached terminals retain output without replying to live queries.
    term.onData((d) => {
      if (
        !useStore.getState().serviceConnected ||
        created.replaying ||
        document.visibilityState !== 'visible' ||
        !visibleHost(created)
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
  const e = registry.get(sid)
  if (!e) return
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
  registry.get(sessionId)?.term.write(data instanceof Uint8Array ? data : new Uint8Array(data))
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
    // Disposing xterm can cancel queued write callbacks.
    e.finishRestore = resolve
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
        e.finishRestore = undefined
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
  const e = registry.get(sessionId)
  // Clearing from the cursor down removes what the dead TUI drew below it (its input box and
  // status lines), which the next run would otherwise draw over line by line.
  e?.term.write('\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1006l\x1b[2 q\x1b[J\r')
}

export function writeNote(sessionId: string, text: string) {
  registry.get(sessionId)?.term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

/** Views unmount their hosts; CSS visibility and size cover collapsed panes and hidden tabs. */
export function hostVisible(host: HTMLElement): boolean {
  if (!host.isConnected) return false
  if (host.checkVisibility && !host.checkVisibility({ checkVisibilityCSS: true })) return false
  if (!host.getBoundingClientRect) return true
  const { width, height } = host.getBoundingClientRect()
  return width > 0 && height > 0
}
const visibleHost = (e: Entry) => [...e.hosts.keys()].findLast(hostVisible)

export const hasVisibleTerminal = (sid: string) => {
  const e = registry.get(sid)
  return document.visibilityState === 'visible' && !!e && !!visibleHost(e)
}
export const ownsTerminalHost = (sid: string, host: HTMLElement) =>
  registry.get(sid)?.el.parentElement === host && hostVisible(host)

/** Move the session's terminal into `container` and size it to fit. */
export function attach(
  sessionId: string,
  container: HTMLElement,
  options?: { focus?: boolean; repaint?: boolean },
) {
  const visible = hostVisible(container)
  const e = visible ? entry(sessionId) : registry.get(sessionId)
  if (!e || !container.isConnected) return
  for (const host of e.hosts.keys()) if (!host.isConnected) e.hosts.delete(host)
  if (!e.hosts.has(container)) {
    e.hosts.set(container, false)
    if (!visible) e.hiddenHosts.add(container)
  } else if (visible && e.hiddenHosts.has(container)) {
    // The most recently shown pane takes the terminal, as one registered just now would.
    const onScreen = e.hosts.get(container)!
    e.hosts.delete(container)
    e.hosts.set(container, onScreen)
  }
  if (visible) e.hiddenHosts.delete(container)
  if (!visible || visibleHost(e) !== container) return
  const moved = e.el.parentElement !== container
  if (moved) container.replaceChildren(e.el)
  refreshTheme()
  if (!e.opened) {
    e.term.open(e.el)
    // WebKit offers Writing Tools / inline predictions on editable fields; a PTY can't use them.
    e.term.textarea?.setAttribute('writingsuggestions', 'false')
    e.term.textarea?.setAttribute('autocomplete', 'off')
    e.opened = true
  }
  updateWebgl(e)
  fit(sessionId)
  // A re-parented or re-shown terminal may hold rows drawn for its old size or host.
  if (moved || options?.repaint) repaint(e)
  if (options?.focus !== false) e.term.focus()
}

function repaint(e: Entry) {
  try {
    e.term.refresh(0, e.term.rows - 1)
  } catch {
    // not rendered yet
  }
}

/** Debounced `attach` for continuous resizes, so a drag reflows and signals the program once. */
export function scheduleFit(sessionId: string, container: HTMLElement, delayMs = FIT_DEBOUNCE_MS) {
  const e = registry.get(sessionId)
  if (!e) return
  clearTimeout(e.fitTimer)
  e.fitTimer = setTimeout(() => {
    e.fitTimer = undefined
    if (e.hosts.has(container)) attach(sessionId, container, { focus: false })
  }, delayMs)
}

/** Ask the running program to repaint once this window next claims the PTY (after a replay). */
export function requestRedraw(sessionId: string) {
  const e = registry.get(sessionId)
  if (e) e.redraw = true
}

/**
 * Which PTY sizes to send for a fit: none when unchanged, unless a claim forces it. A redraw
 * first sends one column fewer, since programs repaint only when the size really changes.
 */
export function resizesToSend(
  sent: { cols: number; rows: number } | undefined,
  cols: number,
  rows: number,
  options: { force?: boolean; redraw?: boolean } = {},
): { cols: number; rows: number }[] {
  if (options.force && options.redraw && cols > 1)
    return [
      { cols: cols - 1, rows },
      { cols, rows },
    ]
  if (!options.force && sent?.cols === cols && sent.rows === rows) return []
  return [{ cols, rows }]
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

/**
 * Fit locally; the service accepts PTY sizes only from its authoritative viewer, so a claim
 * (`force`) resends the size even when this window's fit didn't change it.
 */
export function fit(sessionId: string, options?: { force?: boolean }) {
  const e = registry.get(sessionId)
  if (!e?.opened || !visibleHost(e)) return
  try {
    e.fit.fit()
  } catch {
    return // container not laid out yet
  }
  const { cols, rows } = e.term
  const sizes = resizesToSend(e.sent, cols, rows, { force: options?.force, redraw: e.redraw })
  if (!sizes.length) return
  if (options?.force) e.redraw = false
  e.sent = { cols, rows }
  const send = ({ cols, rows }: { cols: number; rows: number }) =>
    void terminalResize(sessionId, cols, rows).catch(() => {})
  send(sizes[0])
  // A fit during the gap already sent a newer size; resending the latest is harmless.
  if (sizes[1]) {
    clearTimeout(e.redrawTimer)
    e.redrawTimer = setTimeout(() => send(e.sent ?? sizes[1]), REDRAW_GAP_MS)
  }
}

/** Return the shared terminal to its previous pane when a Sessions preview closes. */
export function detachHost(
  sessionId: string,
  host: HTMLElement,
  options?: { hidden?: boolean },
): boolean {
  const e = registry.get(sessionId)
  if (!e) return false
  if (!options?.hidden) e.hosts.delete(host)
  else e.hiddenHosts.add(host)
  for (const candidate of e.hosts.keys()) if (!candidate.isConnected) e.hosts.delete(candidate)
  const previous = visibleHost(e)
  if (previous && e.el.parentElement === host) {
    previous.replaceChildren(e.el)
    fit(sessionId)
    repaint(e)
  }
  if (!previous) {
    clearTimeout(e.fitTimer)
    if (e.el.parentElement && !e.el.parentElement.isConnected) e.el.remove()
  }
  updateWebgl(e)
  return !!previous
}

export function disposeTerminal(sid: string) {
  const e = registry.get(sid)
  if (!e) return
  clearTimeout(e.fitTimer)
  clearTimeout(e.redrawTimer)
  disableWebgl(e)
  e.term.dispose()
  e.el.remove()
  e.finishRestore?.()
  registry.delete(sid)
}

export function disposeAll() {
  themeObserver?.disconnect()
  themeObserver = undefined
  themeSignature = ''
  for (const sid of registry.keys()) disposeTerminal(sid)
}

/** Renderer counts for the dev-only inspector hook. */
export const terminalRendererCounts = () => ({ terminals: registry.size, webgl: webglCount })

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
