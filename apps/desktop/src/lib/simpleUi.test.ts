import { expect, test } from 'vitest'
import type { SessionRecord, SessionState } from '../types'
import { emptySimpleUi, inputDrawer, simpleKey, useSimpleUi } from './simpleUi'

const planner = { id: 'planner' } as SessionRecord
const session = (state: string, authoritative: boolean, generation = 1): SessionState =>
  ({
    running: true,
    generation,
    status: { agent: { state, authoritative, sinceMs: 100 } },
  }) as SessionState

test('an input drawer stays with its question while keystrokes produce unconfirmed work or idle', () => {
  const opened = inputDrawer(emptySimpleUi(), planner, {
    planner: session('needsInput', true),
  })
  expect(opened).toMatchObject({
    terminal: 'input',
    terminalSession: { id: 'planner', generation: 1 },
  })
  for (const state of ['working', 'idle'])
    expect(inputDrawer(opened, undefined, { planner: session(state, false) })).toBe(opened)
  expect(inputDrawer(opened, undefined, { planner: session('working', true) }).terminal).toBe(
    'closed',
  )
  expect(inputDrawer(opened, undefined, { planner: session('working', false, 2) }).terminal).toBe(
    'closed',
  )
  expect(
    inputDrawer(opened, undefined, { planner: { ...session('working', false), running: false } })
      .terminal,
  ).toBe('closed')
})

test('a manually opened drawer pins questions and explicit Hide stays closed for that request', () => {
  const asking = { planner: session('needsInput', true) }
  const opened = inputDrawer({ ...emptySimpleUi(), terminal: 'user' }, planner, asking)
  expect(opened.terminalSession?.id).toBe('planner')
  expect(inputDrawer(opened, undefined, { planner: session('working', false) })).toBe(opened)
  expect(inputDrawer(opened, undefined, { planner: session('working', true) })).toMatchObject({
    terminal: 'user',
    terminalSession: undefined,
  })
  const hidden = { ...opened, terminal: 'closed' as const, terminalSession: undefined }
  expect(inputDrawer(hidden, planner, asking).terminal).toBe('closed')
  expect(inputDrawer(hidden, planner, { planner: session('needsInput', true, 2) }).terminal).toBe(
    'input',
  )
})

test('drafts and drawer intent are independent per worktree', () => {
  useSimpleUi.setState({ worktrees: {} })
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  useSimpleUi.getState().patch(a, { draft: 'project', terminal: 'user' })
  useSimpleUi.getState().patch(b, { terminal: 'input' })
  expect(useSimpleUi.getState().worktrees[a]).toMatchObject({ draft: 'project', terminal: 'user' })
  useSimpleUi.getState().patch(b, { terminal: 'closed' })
  expect(useSimpleUi.getState().worktrees[a].terminal).toBe('user')
})
