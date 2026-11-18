import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { ChatTeam } from '../lib/chatTeams'
import type { ProviderJob } from '../lib/orchestration'
import { simpleKey } from '../lib/simpleUi'
import ChatCoordination, { ChatCoordinationAlerts } from './ChatCoordination'

const state = vi.hoisted(() => ({ jobs: [] as ProviderJob[], dismissed: [] as string[] }))
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
] as const)(
  'worker %s with error %s flags the closed assignments button: %s',
  (jobState, error, retryable) => {
    state.jobs = [
      {
        id: 'assignment',
        terminal: { name: 'Codex' },
        state: jobState,
        error,
      } as ProviderJob,
      {
        id: 'done',
        terminal: { name: 'Finished worker' },
        state: 'integrated',
        summary: 'Completed task',
      } as ProviderJob,
    ]
    const props = {
      openTerminal: vi.fn(),
      team: { id: 'team', projectId: 'p', state: 'running', messages: [] } as unknown as ChatTeam,
    }
    const html = renderToStaticMarkup(createElement(ChatCoordination, props))
    expect(html).toContain('Assignments (2)')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Finished worker')
    // The button stays compact; its accessible name carries the breakdown.
    expect(html.includes('· 1 flagged')).toBe(retryable)
    expect(html.includes('1 failed')).toBe(retryable)
    // A failure is raised in the chat itself, with its recovery actions, while the popover is shut.
    const alerts = renderToStaticMarkup(createElement(ChatCoordinationAlerts, props))
    if (retryable) {
      expect(alerts).toContain(`<p role="alert">Codex · failed · ${error}`)
      expect(alerts).toContain('Retry work')
      expect(alerts).toContain('Agent settings')
    } else {
      expect(alerts).toBe('')
    }
  },
)

test('the button flags team errors and treats the restart notice as informational', () => {
  state.jobs = []
  const render = (error: string, component: typeof ChatCoordinationAlerts = ChatCoordination) =>
    renderToStaticMarkup(
      createElement(component, {
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
  expect(render('Paused after restart')).not.toContain('flagged')
  expect(render('Paused after restart', ChatCoordinationAlerts)).toBe('')
  expect(render('launch failed')).toContain('1 coordination issue')
  expect(render('launch failed', ChatCoordinationAlerts)).toContain(
    '<p role="alert">launch failed</p>',
  )
})

vi.mock('../lib/simpleUi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/simpleUi')>()),
  useSimpleUi: (select: (s: unknown) => unknown) =>
    select({ worktrees: { [simpleKey('p', null)]: { dismissedAssignments: state.dismissed } } }),
}))

test('a dismissed failure clears the badge while a fresh attempt still flags it', () => {
  const failed = {
    id: 'reader',
    requestId: 'attempt-1',
    state: 'failed',
    error: 'Worker exited',
    terminal: { name: 'Codex' },
  } as ProviderJob
  const team = {
    id: 'team',
    projectId: 'p',
    task: null,
    state: 'running',
    messages: [],
  } as unknown as ChatTeam
  state.dismissed = [JSON.stringify(['attempt-1', 'failed', 'Worker exited'])]
  const render = () =>
    renderToStaticMarkup(createElement(ChatCoordination, { team, openTerminal: vi.fn() }))
  state.jobs = [failed]
  const html = render()
  expect(html).toContain('Assignments (0)')
  expect(html).not.toContain('1 failed')
  expect(
    renderToStaticMarkup(createElement(ChatCoordinationAlerts, { team, openTerminal: vi.fn() })),
  ).toBe('')
  state.jobs = [{ ...failed, requestId: 'attempt-2' }]
  expect(render()).toContain('1 failed')
})
