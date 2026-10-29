import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { SessionState } from '../types'

vi.mock('../store', async () => {
  const { create } = await import('zustand')
  return {
    useStore: create(() => ({
      sessions: {},
      serviceConnected: true,
      workspaceSettings: {},
      setMessage: vi.fn(),
    })),
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
import { cancelQueued, enqueuePrompt, flushQueued, followQueuedPrompts } from './simpleQueue'
import { appendDraft, simpleKey, useSimpleUi } from './simpleUi'
import { sendToSession, transmittedText } from './simpleComposer'
import { logSimple } from './simpleActions'

const key = simpleKey('p', 't')
let sid: string
let serial = 0
let stop: (() => void) | undefined
const session = (state = 'working', generation = 1): SessionState =>
  ({
    running: true,
    generation,
    status: {
      agent: {
        state,
        provider: 'codex',
        turnId: 'turn',
        authoritative: true,
        sinceMs: Date.now() + 1000,
      },
    },
  }) as SessionState
const update = (state: SessionState) => useStore.setState({ sessions: { [sid]: state } })
const queue = () =>
  useSimpleUi.getState().patch(key, {
    queued: {
      sessionId: sid,
      generation: 1,
      text: 'follow  up',
      draft: 'follow @app up',
      mentions: [{ id: 'app', token: '@app', start: 7, end: 11 }],
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
    expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow  up', false),
  )
  await vi.waitFor(() =>
    expect(logSimple).toHaveBeenCalledWith(
      'p',
      't',
      expect.objectContaining({ kind: 'prompt', text: 'follow  up', mentions: ['app'] }),
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
      draft: 'new draft\n\nfollow @app up',
      queued: undefined,
    })
    expect(useStore.getState().setMessage).toHaveBeenCalledWith(
      reason === 'generation'
        ? 'The agent restarted; your queued message was kept as a draft'
        : 'The agent exited; your queued message was kept as a draft',
    )
    expect(terminalPrompt).not.toHaveBeenCalled()
  },
)

test('a failed or uncertain write returns the draft and is never retried', async () => {
  vi.mocked(terminalPrompt).mockRejectedValue(new Error('uncertain write'))
  stop = followQueuedPrompts()
  queue()
  update(session('idle'))
  await vi.waitFor(() =>
    expect(useStore.getState().setMessage).toHaveBeenCalledWith('Error: uncertain write'),
  )
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('follow @app up')
  expect(useSimpleUi.getState().worktrees[key].mentions).toEqual([
    { id: 'app', token: '@app', start: 7, end: 11 },
  ])
  update(session('review'))
  expect(terminalPrompt).toHaveBeenCalledTimes(1)
})

test('cancel appends to an existing draft; force refuses dialogs and sends mid-turn otherwise', async () => {
  queue()
  useSimpleUi.getState().patch(key, { draft: 'draft' })
  cancelQueued(key)
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('draft\n\nfollow @app up')
  expect(useSimpleUi.getState().worktrees[key].mentions).toEqual([
    { id: 'app', token: '@app', start: 14, end: 18 },
  ])
  queue()
  update(session('needsInput'))
  await flushQueued(key, true)
  expect(terminalPrompt).not.toHaveBeenCalled()
  // A Codex approval in its grace reads as working, and an Esc leaves the turn unconfirmed.
  for (const agent of [{ approvalPending: true }, { authoritative: false }]) {
    const pending = session('working')
    Object.assign(pending.status!.agent!, agent)
    update(pending)
    await flushQueued(key, true)
    expect(terminalPrompt).not.toHaveBeenCalled()
  }
  update(session('working'))
  await flushQueued(key, true)
  expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow  up', true)
})

test('restoring a combined queue retains scope tokens in both drafts and can send them again', () => {
  queue()
  const queued = useSimpleUi.getState().worktrees[key].queued!
  const combined = appendDraft(queued, {
    draft: '@lib again',
    mentions: [{ id: 'lib', token: '@lib', start: 0, end: 4 }],
  })
  useSimpleUi.getState().patch(key, {
    draft: '@root draft',
    mentions: [{ id: 'root', token: '@root', start: 0, end: 5 }],
    queued: { ...queued, ...combined },
  })
  cancelQueued(key)
  const restored = useSimpleUi.getState().worktrees[key]
  expect(restored.draft).toBe('@root draft\n\nfollow @app up\n\n@lib again')
  expect(restored.mentions.map((m) => m.id)).toEqual(['root', 'app', 'lib'])
  for (const m of restored.mentions) expect(restored.draft.slice(m.start, m.end)).toBe(m.token)
  expect(transmittedText(restored.draft, restored.mentions)).toBe(' draft\n\nfollow  up\n\n again')
})

test('a refused queued delivery reports the draft retention message once', async () => {
  vi.mocked(terminalPrompt).mockRejectedValue(
    new Error('The agent is not at a ready prompt. Your draft was kept.'),
  )
  queue()
  update(session('idle'))
  await flushQueued(key)
  expect(useStore.getState().setMessage).toHaveBeenCalledExactlyOnceWith(
    'Error: The agent is not at a ready prompt. Your draft was kept.',
  )
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

test('a momentarily missing session keeps its queue and sends after reconciliation', async () => {
  queue()
  useStore.setState({ sessions: {} })
  await flushQueued(key)
  expect(useSimpleUi.getState().worktrees[key].queued).toBeDefined()
  expect(useStore.getState().setMessage).not.toHaveBeenCalled()
  update(session('idle'))
  await flushQueued(key)
  expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow  up', false)
})

test('Send anyway appends the new draft after the message already queued', async () => {
  queue()
  enqueuePrompt(key, {
    sessionId: sid,
    generation: 1,
    text: 'step 2',
    draft: 'step 2',
    mentions: [],
    stage: 'build',
    atMs: 2,
  })
  await flushQueued(key, true)
  expect(terminalPrompt).toHaveBeenCalledExactlyOnceWith(sid, 1, 'follow  up\n\nstep 2', true)
})

test('a flush during composer delivery leaves its draft alone and follows delivery completion', async () => {
  update(session('idle'))
  let finish!: () => void
  vi.mocked(terminalPrompt).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  useSimpleUi.getState().patch(key, { draft: 'sent draft' })
  const delivery = sendToSession({
    projectId: 'p',
    task: 't',
    sid,
    generation: 1,
    text: 'sent draft',
    mentions: [],
    stage: 'build',
  })
  await vi.waitFor(() => expect(terminalPrompt).toHaveBeenCalledOnce())
  stop = followQueuedPrompts()
  queue()
  update(session('review'))
  await flushQueued(key)
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('sent draft')
  expect(useSimpleUi.getState().worktrees[key].queued).toBeDefined()
  finish()
  await delivery
  if (useSimpleUi.getState().worktrees[key].draft === 'sent draft')
    useSimpleUi.getState().patch(key, { draft: '', mentions: [] })
  await vi.waitFor(() => expect(terminalPrompt).toHaveBeenCalledTimes(2))
  expect(useSimpleUi.getState().worktrees[key].draft).toBe('')
})

test('the interrupted turn Stop does not release a queue after a forced send', async () => {
  const now = Date.now()
  await sendToSession({
    projectId: 'p',
    task: 't',
    sid,
    generation: 1,
    text: 'forced',
    mentions: [],
    stage: 'build',
    force: true,
  })
  stop = followQueuedPrompts()
  queue()
  update(session('review'))
  await flushQueued(key)
  expect(terminalPrompt).toHaveBeenCalledTimes(1)
  const next = session('working')
  next.status!.agent!.turnId = 'next'
  next.status!.agent!.sinceMs = now + 2000
  update(next)
  expect(terminalPrompt).toHaveBeenCalledTimes(1)
  update({
    ...next,
    status: {
      ...next.status!,
      agent: { ...next.status!.agent!, state: 'review', sinceMs: now + 3000 },
    },
  })
  await vi.waitFor(() => expect(terminalPrompt).toHaveBeenCalledTimes(2))
})
