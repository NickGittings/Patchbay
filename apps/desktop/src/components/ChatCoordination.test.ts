import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { ChatTeam } from '../lib/chatTeams'
import type { ProviderJob } from '../lib/orchestration'
import ChatCoordination from './ChatCoordination'

const state = vi.hoisted(() => ({ jobs: [] as ProviderJob[] }))
vi.mock('../store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ sessions: {}, sessionRecords: [] }),
}))
vi.mock('../lib/chatTeams', () => ({
  RESTART_NOTICE: 'Paused after restart',
  controlTeam: vi.fn(),
  useChatTeams: (select: (s: unknown) => unknown) =>
    select({ runs: { p: [{ chatTeam: 'team', jobs: state.jobs }] } }),
}))
vi.mock('../lib/rail', () => ({ selectPanel: vi.fn(), useRail: { setState: vi.fn() } }))

test.each([
  ['failed', 'Worker exited', true],
  ['launching', 'Launch unconfirmed; retry required', true],
  ['launching', null, false],
  ['running', null, false],
] as const)('worker %s with error %s offers recovery: %s', (jobState, error, retryable) => {
  state.jobs = [
    {
      id: 'assignment',
      terminal: { name: 'Codex' },
      state: jobState,
      error,
    } as ProviderJob,
  ]
  const html = renderToStaticMarkup(
    createElement(ChatCoordination, {
      openTerminal: vi.fn(),
      team: { id: 'team', projectId: 'p', state: 'running', messages: [] } as unknown as ChatTeam,
    }),
  )
  if (retryable) {
    expect(html).toContain('Retry work')
    expect(html).toContain(error)
  } else expect(html).not.toContain('Retry work')
})

test('a restored team shows the restart notice once, as status rather than an alert', () => {
  state.jobs = []
  const render = (error: string) =>
    renderToStaticMarkup(
      createElement(ChatCoordination, {
        openTerminal: vi.fn(),
        team: {
          id: 'team',
          projectId: 'p',
          state: 'paused',
          error,
          messages: [],
        } as unknown as ChatTeam,
      }),
    )
  const restored = render('Paused after restart')
  expect(restored.match(/Paused/g)).toHaveLength(1)
  expect(restored).not.toContain('role="alert"')
  expect(render('launch failed')).toContain('<p role="alert">launch failed</p>')
})
