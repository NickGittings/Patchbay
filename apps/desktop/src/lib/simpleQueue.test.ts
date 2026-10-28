import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SessionState } from '../types'

vi.mock('../store', async () => {
  const { create } = await import('zustand')
  return {
    useStore: create(() => ({ sessions: {}, serviceConnected: true, workspaceSettings: {} })),
  }
})
vi.mock('./ipc', () => ({
  terminalAttach: vi.fn(async () => {}),
  terminalDetach: vi.fn(async () => {}),
  terminalPrompt: vi.fn(async () => {}),
}))
vi.mock('./terminals', () => ({ hasVisibleTerminal: () => false }))
vi.mock('./simpleActions', () => ({ logSimple: vi.fn() }))
vi.mock('./simpleReplies', () => ({ persistReplies: vi.fn() }))

import { useStore } from '../store'
import { terminalPrompt } from './ipc'
import { cancelQueued, flushQueued, followQueuedPrompts } from './simpleQueue'
import { simpleKey, useSimpleUi } from './simpleUi'
import { logSimple } from './simpleActions'

const key = simpleKey('p', 't')
let sid: string
let serial = 0
let stop: (() => void) | undefined
const session = (state = 'working', generation = 1): SessionState =>
  ({
    running: true,
    generation,
    status: { agent: { state, authoritative: true, sinceMs: Date.now() + 1000 } },
  }) as SessionState
const update = (state: SessionState) => useStore.setState({ sessions: { [sid]: state } })
const queue = () =>
  useSimpleUi.getState().patch(key, {
    queued: {
      sessionId: sid,
      generation: 1,
      text: 'follow up',
      mentions: ['app'],
      stage: 'build',
      atMs: 1,
    },
  })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(terminalPrompt).mockResolvedValue(undefined)
  sid = `queue-${++serial}`
  useSimpleUi.setState({ worktrees: {} })
  useStore.setState({ sessions: {}, serviceConnected: true })
  update(session())
})
afterEach(() => {
  stop?.()
  stop = undefined
})

test('waits during work and permission dialogs, then flushes once on ready even in another worktree', async () => {
  stop = followQueuedPrompts()
  queue()
  expect(terminalPrompt).not.toHaveBeenCalled()
  update(session('needsInput'))
  expect(terminalPrompt).not.toHaveBeenCalled()
  useStore.setState({ activeTask: 'other' })
  update(session('idle'))
  await vi.waitFor(() =>
    expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow up', false),
  )
  await vi.waitFor(() =>
    expect(logSimple).toHaveBeenCalledWith(
      'p',
      't',
      expect.objectContaining({ kind: 'prompt', text: 'follow up', mentions: ['app'] }),
    ),
  )
  update(session('review'))
  expect(terminalPrompt).toHaveBeenCalledTimes(1)
  expect(useSimpleUi.getState().worktrees[key].queued).toBeUndefined()
})

test.each(['generation', 'stopped'] as const)(
  '%s returns queued text to the draft with an error',
  (reason) => {
    stop = followQueuedPrompts()
    useSimpleUi.getState().patch(key, { draft: 'new draft' })
    queue()
    update(reason === 'generation' ? session('idle', 2) : { ...session(), running: false })
    expect(useSimpleUi.getState().worktrees[key]).toMatchObject({
      draft: 'new draft\n\nfollow up',
      queued: undefined,
      error: 'The agent restarted; your queued message was kept as a draft',
    })
    expect(terminalPrompt).not.toHaveBeenCalled()
  },
)

test('a failed or uncertain write returns the draft and is never retried', async () => {
  vi.mocked(terminalPrompt).mockRejectedValue(new Error('uncertain write'))
  stop = followQueuedPrompts()
  queue()
  update(session('idle'))
  await vi.waitFor(() =>
    expect(useSimpleUi.getState().worktrees[key].error).toContain('uncertain write'),
  )
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('follow up')
  update(session('review'))
  expect(terminalPrompt).toHaveBeenCalledTimes(1)
})

test('cancel appends to an existing draft; force refuses dialogs and sends mid-turn otherwise', async () => {
  queue()
  useSimpleUi.getState().patch(key, { draft: 'draft' })
  cancelQueued(key)
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('draft\n\nfollow up')
  queue()
  update(session('needsInput'))
  await flushQueued(key, true)
  expect(terminalPrompt).not.toHaveBeenCalled()
  update(session('working'))
  await flushQueued(key, true)
  expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow up', true)
})

test('a disconnected service waits and flushes when it reconnects', async () => {
  useStore.setState({ serviceConnected: false })
  update(session('idle'))
  stop = followQueuedPrompts()
  queue()
  expect(terminalPrompt).not.toHaveBeenCalled()
  useStore.setState({ serviceConnected: true })
  await vi.waitFor(() => expect(terminalPrompt).toHaveBeenCalledTimes(1))
})
