import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import TerminalControl from './TerminalControl'
import type { SessionState } from '../types'

const state = vi.hoisted(() => ({ connected: true }))
vi.mock('../store', () => {
  const getState = () => ({ serviceConnected: state.connected, project: undefined })
  return {
    useStore: Object.assign(
      (select: (s: ReturnType<typeof getState>) => unknown) => select(getState()),
      { getState },
    ),
  }
})
vi.mock('../lib/sessions', () => ({
  autoControlsAgent: () => false,
  newConversation: vi.fn(),
  startTerminal: vi.fn(),
  stopTerminal: vi.fn(),
}))

beforeEach(() => {
  state.connected = true
})
const render = (componentId = 'web', session?: SessionState, kind: 'agent' | 'task' = 'agent') =>
  renderToStaticMarkup(
    createElement(TerminalControl, {
      kind,
      componentId,
      terminalId: 'agent',
      sid: 'session',
      task: null,
      session,
    }),
  )

test('only interactive agent scopes offer New conversation', () => {
  for (const scope of ['web', '@plan', '@task']) expect(render(scope)).toContain('New conversation')
  for (const scope of ['@review', '@merge', '@map', '@scan', '@coordinator', '@worker'])
    expect(render(scope)).not.toContain('New conversation')
  expect(render('web', undefined, 'task')).not.toContain('New conversation')
})

test('context renders unavailable explicitly and preserves fractional percentages in telemetry', () => {
  expect(render()).toContain('Context unavailable')
  const session: SessionState = {
    running: true,
    generation: 42,
    status: {
      lastOutputMs: null,
      active: false,
      agent: null,
      url: null,
      ready: false,
      healthy: null,
      stopped: false,
      seenMs: null,
      context: {
        usedTokens: 25000,
        windowTokens: 200000,
        usedPercent: 12.5,
        observedMs: 1000,
        compaction: 'compacting',
        lastCompactionMs: null,
      },
    },
  }
  expect(render('web', session)).toContain('Context 13%')
  expect(render('web', session)).toContain('Compacting…')
  expect(render('web', session)).toContain('25,000')
  state.connected = false
  expect(render('web', session)).toContain('(historical)')
  expect(render('web', session)).not.toContain('Compacting…')
  session.status!.context!.compaction = 'idle'
  session.status!.context!.lastCompactionMs = 900
  expect(render('web', session)).toContain('Last compacted')
})
