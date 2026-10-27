import { expect, test } from 'vitest'
import type { SessionRecord, SessionState } from '../types'
import { emptySimpleUi, inputDrawer, simpleKey, useSimpleUi, type SimpleUi } from './simpleUi'

const planner = { id: 'planner' } as SessionRecord
const builder = { id: 'builder' } as SessionRecord
const records = [planner, builder]
const drawer = (
  ui: SimpleUi,
  asking: SessionRecord | undefined,
  sessions: Record<string, SessionState>,
) => inputDrawer(ui, asking, sessions, records)
const session = (state: string, authoritative: boolean, generation = 1): SessionState =>
  ({
    running: true,
    generation,
    status: { agent: { state, authoritative, sinceMs: 100 } },
  }) as SessionState

test('an input drawer stays with its question while keystrokes produce unconfirmed work or idle', () => {
  const opened = drawer(emptySimpleUi(), planner, { planner: session('needsInput', true) })
  expect(opened).toMatchObject({
    terminal: 'input',
    terminalSession: { id: 'planner', generation: 1 },
  })
  for (const state of ['working', 'idle'])
    expect(drawer(opened, undefined, { planner: session(state, false) })).toBe(opened)
  expect(drawer(opened, undefined, { planner: session('working', true) }).terminal).toBe('closed')
  expect(drawer(opened, undefined, { planner: session('working', false, 2) }).terminal).toBe(
    'closed',
  )
  expect(
    drawer(opened, undefined, { planner: { ...session('working', false), running: false } })
      .terminal,
  ).toBe('closed')
})

test('a manually opened drawer pins questions and explicit Hide stays closed for that request', () => {
  const asking = { planner: session('needsInput', true) }
  const opened = drawer({ ...emptySimpleUi(), terminal: 'user' }, planner, asking)
  expect(opened.terminalSession?.id).toBe('planner')
  expect(drawer(opened, undefined, { planner: session('working', false) })).toBe(opened)
  expect(drawer(opened, undefined, { planner: session('working', true) })).toMatchObject({
    terminal: 'user',
    terminalSession: undefined,
  })
  const hidden = { ...opened, terminal: 'closed' as const, terminalSession: undefined }
  expect(drawer(hidden, planner, asking).terminal).toBe('closed')
  expect(drawer(hidden, planner, { planner: session('needsInput', true, 2) }).terminal).toBe(
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

test('an input wait takes the drawer from a View pin', () => {
  const pinned = {
    ...emptySimpleUi(),
    terminal: 'user' as const,
    terminalSession: { id: 'planner', generation: 1, pinned: true },
  }
  const sessions = { planner: session('idle', true), builder: session('needsInput', true) }
  expect(drawer(pinned, undefined, sessions)).toBe(pinned)
  const asked = drawer(pinned, builder, sessions)
  expect(asked).toMatchObject({
    terminal: 'user',
    terminalSession: { id: 'builder', generation: 1 },
    inputRequest: 'builder:1:100',
  })
  expect(asked.terminalSession?.pinned).toBeUndefined()
})

test('a pin whose session was forgotten closes the drawer and yields to input waits', () => {
  const pinned = {
    ...emptySimpleUi(),
    terminal: 'user' as const,
    terminalSession: { id: 'gone', generation: 1, pinned: true },
  }
  expect(drawer(pinned, undefined, {})).toMatchObject({
    terminal: 'closed',
    terminalSession: undefined,
  })
  expect(drawer(pinned, builder, { builder: session('needsInput', true) })).toMatchObject({
    terminal: 'input',
    terminalSession: { id: 'builder' },
  })
})
