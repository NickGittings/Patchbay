import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const observed = vi.hoisted(() => ({ terminals: [] as Terminal[] }))
vi.mock('@xterm/xterm', async (original) => {
  const actual = await original<typeof import('@xterm/xterm')>()
  return {
    ...actual,
    Terminal: class extends actual.Terminal {
      constructor(options: import('@xterm/xterm').ITerminalOptions) {
        super(options)
        observed.terminals.push(this)
      }
    },
  }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {}
  },
}))
vi.mock('./navigation', () => ({ openTerminalReference: vi.fn(), terminalReferences: () => [] }))
vi.mock('./ipc', () => ({
  terminalResize: vi.fn(async () => {}),
  terminalWrite: vi.fn(async () => {}),
}))
vi.mock('../store', () => ({ useStore: { getState: () => ({ serviceConnected: true }) } }))
const ipc = await import('./ipc')
const {
  attach,
  detachHost,
  disposeAll,
  disposeTerminal,
  hasTerminal,
  markOutputGeneration,
  ownsTerminalHost,
  replayOutput,
  requestRedraw,
  restoreModes,
  restoreOutput,
  setOnScreen,
  terminalRendererCounts,
  terminalText,
  writeNote,
  writeOutput,
} = await import('./terminals')
const seed = () => replayOutput('session', new Uint8Array())
const output = (text: string) => writeOutput('session', new TextEncoder().encode(text))
const drain = () => new Promise<void>((resolve) => observed.terminals[0].write('', resolve))

beforeEach(() => {
  observed.terminals.length = 0
  vi.clearAllMocks()
  vi.stubGlobal('document', {
    documentElement: {},
    visibilityState: 'visible',
    createElement: () => ({
      className: '',
      parentElement: null,
      remove() {
        this.parentElement = null
      },
    }),
  })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#000000' }))
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  disposeAll()
  vi.unstubAllGlobals()
})

test('reset preserves normal-buffer output and appends exit and next-run output in order', async () => {
  seed()
  output('first\r\nsecond\r\nthird\r\n')
  restoreModes('session')
  writeNote('session', 'exited')
  restoreModes('session')
  output('next run\r\n')
  await drain()
  expect(terminalText('session').text.trimEnd()).toBe('first\nsecond\nthird\n\nexited\nnext run')
})

test('reset leaves a queued alternate screen and preserves the normal-buffer cursor', async () => {
  seed()
  output('first\r\nsecond\r\n\x1b[?1049hTUI')
  restoreModes('session')
  writeNote('session', 'exited')
  output('next run')
  await drain()
  expect(observed.terminals[0].buffer.active.type).toBe('normal')
  expect(terminalText('session').text.trimEnd()).toBe('first\nsecond\n\nexited\nnext run')
})

test('reset clears TUI modes and cursor shape without suppressing input', async () => {
  seed()
  output('\x1b[6 q\x1b[?25l\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h')
  await drain()
  const term = observed.terminals[0]
  expect(term.options.cursorStyle).toBe('bar')
  vi.spyOn(term, 'open').mockImplementation(() => {})
  attach('session', { isConnected: true, replaceChildren: vi.fn() } as unknown as HTMLElement, {
    focus: false,
  })
  restoreModes('session')
  term.input('typed during reset', true)
  expect(ipc.terminalWrite).toHaveBeenCalledWith('session', 'typed during reset')
  await drain()
  expect(term.options.cursorStyle).toBe('block')
  expect(term.modes.applicationCursorKeysMode).toBe(false)
  expect(term.modes.bracketedPasteMode).toBe(false)
  expect(term.modes.mouseTrackingMode).toBe('none')
})

test('terminal hosts require visible geometry and cannot reclaim through hidden ancestors', async () => {
  const { hostVisible } = await import('./terminals')
  const rect = { width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 }
  const parent = { hidden: false, parentElement: null, getBoundingClientRect: () => rect }
  const host = {
    isConnected: true,
    checkVisibility: () => !parent.hidden,
    getBoundingClientRect: () => rect,
  }
  expect(hostVisible(host as unknown as HTMLElement)).toBe(true)
  parent.hidden = true
  expect(hostVisible(host as unknown as HTMLElement)).toBe(false)
  parent.hidden = false
  host.isConnected = false
  expect(hostVisible(host as unknown as HTMLElement)).toBe(false)
  host.isConnected = true
  host.getBoundingClientRect = () => ({ ...rect, height: 0 })
  expect(hostVisible(host as unknown as HTMLElement)).toBe(false)
})

test('hidden inline hosts cannot reclaim the registry and visible hosts retain the same scrollback', async () => {
  seed()
  output('retained scrollback\r\n')
  await drain()
  const term = observed.terminals[0]
  vi.spyOn(term, 'open').mockImplementation(() => {})
  const rect = { width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 }
  const container = () => {
    const host = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => rect,
      replaceChildren: vi.fn((el: { parentElement: unknown }) => {
        el.parentElement = host
      }),
    }
    return host
  }
  const dock = container(),
    inline = container()
  attach('session', dock as unknown as HTMLElement, { focus: false })
  attach('session', inline as unknown as HTMLElement, { focus: false })
  expect(ownsTerminalHost('session', inline as unknown as HTMLElement)).toBe(true)
  inline.getBoundingClientRect = () => ({ ...rect, height: 0 })
  attach('session', dock as unknown as HTMLElement, { focus: false })
  attach('session', inline as unknown as HTMLElement, { focus: false })
  expect(ownsTerminalHost('session', dock as unknown as HTMLElement)).toBe(true)
  expect(term.open).toHaveBeenCalledOnce()
  expect(terminalText('session').text).toContain('retained scrollback')
})

test('a pane registered while hidden takes the terminal when it is shown later', async () => {
  seed()
  await drain()
  const term = observed.terminals[0]
  vi.spyOn(term, 'open').mockImplementation(() => {})
  const rect = { width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 }
  const container = (visible: boolean) => {
    const host = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => (visible ? rect : { ...rect, height: 0 }),
      replaceChildren: vi.fn((el: { parentElement: unknown }) => {
        el.parentElement = host
      }),
    }
    return host
  }
  const dock = container(false)
  const drawer = container(true)
  attach('session', dock as unknown as HTMLElement, { focus: false })
  attach('session', drawer as unknown as HTMLElement, { focus: false })
  expect(ownsTerminalHost('session', drawer as unknown as HTMLElement)).toBe(true)
  dock.getBoundingClientRect = () => rect
  attach('session', dock as unknown as HTMLElement, { focus: false })
  expect(ownsTerminalHost('session', dock as unknown as HTMLElement)).toBe(true)
})

test('fits send a PTY size only when it changes, unless a claim forces it', async () => {
  const { resizesToSend } = await import('./terminals')
  expect(resizesToSend(undefined, 80, 24)).toEqual([{ cols: 80, rows: 24 }])
  expect(resizesToSend({ cols: 80, rows: 24 }, 80, 24)).toEqual([])
  expect(resizesToSend({ cols: 80, rows: 24 }, 81, 24)).toEqual([{ cols: 81, rows: 24 }])
  expect(resizesToSend({ cols: 80, rows: 24 }, 80, 24, { force: true })).toEqual([
    { cols: 80, rows: 24 },
  ])
  // A pending redraw waits for a claim, since only the authoritative viewer resizes the PTY.
  expect(resizesToSend({ cols: 80, rows: 24 }, 80, 24, { redraw: true })).toEqual([])
})

test('a forced fit after a replay nudges the width so the program repaints', async () => {
  vi.useFakeTimers()
  try {
    const { fit } = await import('./terminals')
    seed()
    output('replayed')
    const term = observed.terminals[0]
    vi.spyOn(term, 'open').mockImplementation(() => {})
    const rect = { width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 }
    const host = { isConnected: true, getBoundingClientRect: () => rect, replaceChildren: vi.fn() }
    attach('session', host as unknown as HTMLElement, { focus: false })
    const { cols, rows } = term
    vi.mocked(ipc.terminalResize).mockClear()
    fit('session')
    expect(ipc.terminalResize).not.toHaveBeenCalled()
    requestRedraw('session')
    fit('session', { force: true })
    expect(ipc.terminalResize).toHaveBeenLastCalledWith('session', cols - 1, rows)
    vi.advanceTimersByTime(100)
    expect(ipc.terminalResize).toHaveBeenLastCalledWith('session', cols, rows)
    vi.mocked(ipc.terminalResize).mockClear()
    fit('session', { force: true })
    expect(ipc.terminalResize).toHaveBeenCalledOnce()
    expect(ipc.terminalResize).toHaveBeenCalledWith('session', cols, rows)
  } finally {
    vi.useRealTimers()
  }
})

test('live terminal updates do not allocate an unviewed xterm', () => {
  output('background output')
  writeNote('session', 'started')
  restoreModes('session')
  markOutputGeneration('session', 3)
  requestRedraw('session')
  expect(hasTerminal('session')).toBe(false)
  expect(observed.terminals).toHaveLength(0)
})

function pane() {
  const host = {
    isConnected: true,
    visible: true,
    child: undefined as { parentElement: unknown } | undefined,
    checkVisibility: () => host.visible,
    replaceChildren: (el: { parentElement: unknown }) => {
      host.child = el
      el.parentElement = host
    },
  }
  return { host, element: host as unknown as HTMLElement }
}

test('offscreen hosts release WebGL while retaining PTY ownership', () => {
  vi.stubGlobal('WebGL2RenderingContext', class {})
  seed()
  vi.spyOn(observed.terminals[0], 'open').mockImplementation(() => {})
  const { element } = pane()
  attach('session', element, { focus: false })
  expect(terminalRendererCounts()).toEqual({ terminals: 1, webgl: 0 })
  setOnScreen('session', element, true)
  expect(terminalRendererCounts()).toEqual({ terminals: 1, webgl: 1 })
  setOnScreen('session', element, false)
  expect(terminalRendererCounts()).toEqual({ terminals: 1, webgl: 0 })
  expect(ownsTerminalHost('session', element)).toBe(true)
  setOnScreen('session', element, true)
  expect(terminalRendererCounts()).toEqual({ terminals: 1, webgl: 1 })
  disposeTerminal('session')
  expect(terminalRendererCounts()).toEqual({ terminals: 0, webgl: 0 })
})

test('detaching a hidden pane keeps its DOM until the pane disconnects', () => {
  seed()
  vi.spyOn(observed.terminals[0], 'open').mockImplementation(() => {})
  const { host, element } = pane()
  attach('session', element, { focus: false })
  host.visible = false
  detachHost('session', element, { hidden: true })
  expect(host.child?.parentElement).toBe(host)
  host.isConnected = false
  detachHost('session', element)
  expect(host.child?.parentElement).toBeNull()
  expect(hasTerminal('session')).toBe(true)
})

test('disposal settles a pending restore whose xterm write callback is cancelled', async () => {
  seed()
  vi.spyOn(observed.terminals[0], 'write').mockImplementation(() => {})
  const restoring = restoreOutput('session', new Uint8Array(), 3)
  disposeTerminal('session')
  await restoring
  expect(hasTerminal('session')).toBe(false)
})
