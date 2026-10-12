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
vi.mock('./navigation', () => ({ openTerminalReference: vi.fn(), terminalReferences: () => [] }))
vi.mock('./ipc', () => ({
  terminalResize: vi.fn(async () => {}),
  terminalWrite: vi.fn(async () => {}),
}))
vi.mock('../store', () => ({ useStore: { getState: () => ({ serviceConnected: true }) } }))
const ipc = await import('./ipc')
const { attach, disposeAll, restoreModes, writeNote, writeOutput, terminalText } =
  await import('./terminals')
const output = (text: string) => writeOutput('session', new TextEncoder().encode(text))
const drain = () => new Promise<void>((resolve) => observed.terminals[0].write('', resolve))

beforeEach(() => {
  observed.terminals.length = 0
  vi.clearAllMocks()
  vi.stubGlobal('document', {
    documentElement: {},
    visibilityState: 'visible',
    createElement: () => ({ className: '' }),
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
  output('first\r\nsecond\r\nthird\r\n')
  restoreModes('session')
  writeNote('session', 'exited')
  restoreModes('session')
  output('next run\r\n')
  await drain()
  expect(terminalText('session').text.trimEnd()).toBe('first\nsecond\nthird\n\nexited\nnext run')
})

test('reset leaves a queued alternate screen and preserves the normal-buffer cursor', async () => {
  output('first\r\nsecond\r\n\x1b[?1049hTUI')
  restoreModes('session')
  writeNote('session', 'exited')
  output('next run')
  await drain()
  expect(observed.terminals[0].buffer.active.type).toBe('normal')
  expect(terminalText('session').text.trimEnd()).toBe('first\nsecond\n\nexited\nnext run')
})

test('reset clears TUI modes and cursor shape without suppressing input', async () => {
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
