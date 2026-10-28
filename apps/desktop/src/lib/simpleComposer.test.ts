import { expect, test, vi } from 'vitest'
import {
  composerStatus,
  deliverPrompt,
  editedMentions,
  promptReady,
  transmittedText,
  waitForPrompt,
  type SendContext,
  type SendPort,
} from './simpleComposer'
import type { SessionState } from '../types'
const ready = (): SessionState => ({
  generation: 1,
  running: true,
  status: {
    agent: { state: 'idle', authoritative: true, provider: 'claude', sinceMs: 10 },
    lastOutputMs: 9,
    active: false,
  } as SessionState['status'],
})
const context: SendContext = { projectId: 'p', task: 't', recipient: 's', generation: 1 }
const port = (): SendPort => ({
  current: () => context,
  session: ready,
  claim: vi.fn(async () => {}),
  write: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  now: () => 2000,
})
test('the exact text goes to the service in one write, preserving literal emails, unknown mentions, whitespace, and multiline text', async () => {
  const draft = '  @app mail@site.test @unknown\n  second line  '
  const text = transmittedText(draft, [{ id: 'app', token: '@app', start: 2, end: 6 }])
  expect(text).toBe('   mail@site.test @unknown\n  second line  ')
  const p = port()
  await deliverPrompt(context, text, p)
  expect(p.write).toHaveBeenCalledExactlyOnceWith('   mail@site.test @unknown\n  second line  ')
  expect(transmittedText('@app', [{ id: 'app', token: '@app', start: 0, end: 4 }])).toBe('')
})
test('only intact selected tokens are stripped; edits relocate or invalidate structured tokens', () => {
  const tokens = [{ id: 'a', token: '@app', start: 2, end: 6 }]
  expect(editedMentions('x @app', 'xx @app', tokens)).toEqual([{ ...tokens[0], start: 3, end: 7 }])
  expect(editedMentions('x @app', 'x @apple', tokens)).toEqual([])
  expect(editedMentions('x @app', 'x @axp', tokens)).toEqual([])
  expect(transmittedText('x @other', tokens)).toBe('x @other')
})
test('readiness needs a running prompt with a hook-confirmed end of turn', () => {
  expect(promptReady(ready())).toBe(true)
  expect(promptReady({ ...ready(), running: false })).toBe(false)
  const state = (agent: Partial<NonNullable<NonNullable<SessionState['status']>['agent']>>) => ({
    ...ready(),
    status: { ...ready().status!, agent: { ...ready().status!.agent!, ...agent } },
  })
  expect(promptReady(state({ state: 'review' }))).toBe(true)
  expect(promptReady(state({ state: 'needsInput' }))).toBe(false)
  expect(promptReady(state({ state: 'working' }))).toBe(false)
  // Quiet output can't tell a prompt from a permission dialog.
  expect(promptReady(state({ authoritative: false }))).toBe(false)
  expect(promptReady({ ...ready(), status: { ...ready().status!, agent: null } })).toBe(false)
  expect(promptReady(ready(), 11)).toBe(false)
})
test.each(['projectId', 'task', 'recipient', 'generation'] as const)(
  'a changed %s after authority claim cancels before writing',
  async (field) => {
    const p = port()
    p.claim = vi.fn(async () => {
      p.current = () => ({ ...context, [field]: field === 'generation' ? 2 : 'other' })
    })
    await expect(deliverPrompt(context, 'draft', p)).rejects.toThrow('changed')
    expect(p.write).not.toHaveBeenCalled()
    expect(p.release).toHaveBeenCalledOnce()
  },
)
test('process exit during claim cancels and concurrent session writes are serialized', async () => {
  const p = port()
  let release!: () => void
  p.claim = vi.fn(
    () =>
      new Promise<void>((r) => {
        release = r
      }),
  )
  const first = deliverPrompt(context, 'draft', p)
  await expect(deliverPrompt(context, 'again', p)).rejects.toThrow('pending')
  p.session = () => ({ ...ready(), running: false })
  release()
  await expect(first).rejects.toThrow('ready prompt')
  expect(p.write).not.toHaveBeenCalled()
})
test('an uncertain failed write is attempted once, preserves the draft and clears its stamp', async () => {
  const p = port()
  const stamps: (number | undefined)[] = []
  p.onSubmit = (atMs) => stamps.push(atMs)
  let draft = '  draft\n'
  p.write = vi.fn(async () => {
    throw new Error('uncertain')
  })
  await expect(
    deliverPrompt(context, draft, p).then(() => {
      draft = ''
    }),
  ).rejects.toThrow('uncertain')
  expect(draft).toBe('  draft\n')
  expect(p.write).toHaveBeenCalledOnce()
  expect(p.release).toHaveBeenCalledOnce()
  expect(stamps).toEqual([2000, undefined])
})

test('startup waits for a hook-confirmed prompt, times out at 30 seconds, and cancels generations', async () => {
  let now = 0
  let session = { generation: 1, running: true } as SessionState
  const waiting = {
    current: () => context,
    session: () => session,
    now: () => now,
    wait: async (ms: number) => {
      now += ms
    },
  }
  await expect(waitForPrompt(context, waiting)).rejects.toThrow('No ready prompt after 30 seconds')
  expect(now).toBe(30000)
  now = 0
  waiting.wait = async (ms) => {
    now += ms
    if (now === 100) session = { ...session, status: ready().status }
  }
  await waitForPrompt(context, waiting)
  expect(now).toBe(100)
  now = 0
  session = { generation: 1, running: true }
  waiting.current = () => ({ ...context, generation: now >= 100 ? 2 : 1 })
  await expect(waitForPrompt(context, waiting)).rejects.toThrow('changed')
  expect(now).toBe(100)
})

test('a fast reply before write confirmation counts as a completed turn', async () => {
  const p = port()
  let session = ready()
  let submittedMs: number | undefined
  p.session = () => session
  p.onSubmit = (atMs) => {
    submittedMs = atMs
  }
  p.write = vi.fn(async () => {
    expect(submittedMs).toBe(2000)
    session = {
      ...session,
      status: { ...session.status!, agent: { ...session.status!.agent!, sinceMs: 2001 } },
    }
  })
  await deliverPrompt(context, 'quick question', p)
  expect(promptReady(session, submittedMs)).toBe(true)
})

test('Esc during startup times out without claiming hooks are missing', async () => {
  let now = 0
  const session = ready()
  session.status!.agent!.authoritative = false
  await expect(
    waitForPrompt(context, {
      current: () => context,
      session: () => session,
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
    }),
  ).rejects.toThrow(/^No ready prompt after 30 seconds\. Open the terminal to continue\.$/)
  expect(now).toBe(30000)
})

test('a startup timeout of an agent that reports no prompt says chat cannot message it', async () => {
  let now = 0
  await expect(
    waitForPrompt(context, {
      current: () => context,
      session: () => ({ generation: 1, running: true }) as SessionState,
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
      provider: null,
    }),
  ).rejects.toThrow('Chat can message only Claude and Codex agents')
})

test('a hook-confirmed ready prompt is sendable whatever the installed-hooks check says', () => {
  const base = { pending: false, connected: true, provider: 'claude' as const }
  const session = ready()
  for (const installed of [true, false, 'failed', undefined] as const) {
    const status = composerStatus({ ...base, installed, session, ready: true })
    expect(status).toEqual({ label: 'Ready', sendable: true, action: 'send' })
  }
  // A reporting session, ready or not, never asks for hooks.
  const working = ready()
  working.status!.agent!.state = 'working'
  expect(composerStatus({ ...base, installed: false, session: working, ready: false })).toEqual({
    label: 'Agent is working',
    sendable: true,
    action: 'queue',
    notice: undefined,
  })
})
test('installed hooks refuse only starting or resuming, and the label says why Send is off', () => {
  const base = { pending: false, connected: true, provider: 'codex' as const, ready: false }
  const stopped: SessionState = { ...ready(), running: false }
  expect(composerStatus({ ...base, installed: false, session: stopped })).toEqual({
    label: 'Chat needs agent status integration',
    sendable: false,
    action: 'none',
    notice: 'missing',
  })
  expect(composerStatus({ ...base, installed: false, session: undefined }).sendable).toBe(false)
  // A failed or pending check never starts an agent that may have no hooks.
  expect(composerStatus({ ...base, installed: 'failed', session: undefined })).toEqual({
    label: 'Chat needs agent status integration',
    sendable: false,
    action: 'none',
    notice: 'failed',
  })
  expect(composerStatus({ ...base, installed: true, session: stopped })).toEqual({
    label: 'Send to start or resume',
    sendable: true,
    action: 'send',
  })
  for (const provider of ['codex', undefined] as const)
    expect(composerStatus({ ...base, provider, installed: undefined, session: stopped })).toEqual({
      label: 'Checking agent status integration…',
      sendable: false,
      action: 'none',
    })
  // Running without a confirmed prompt queues when hooks are installed or reporting.
  const quiet: SessionState = { generation: 1, running: true }
  expect(composerStatus({ ...base, installed: false, session: quiet })).toMatchObject({
    label: 'Chat needs agent status integration',
    sendable: false,
    action: 'none',
    notice: 'missing',
  })
  expect(composerStatus({ ...base, installed: true, session: quiet })).toMatchObject({
    label: 'Waiting for the agent',
    sendable: true,
    action: 'queue',
  })
  const escaped = ready()
  escaped.status!.agent!.authoritative = false
  expect(composerStatus({ ...base, installed: true, session: escaped })).toMatchObject({
    label: 'Not confirmed ready: continue in its terminal',
    sendable: true,
    action: 'queue',
  })
  expect(composerStatus({ ...base, installed: false, session: escaped })).toMatchObject({
    label: 'Not confirmed ready: continue in its terminal',
    sendable: true,
    action: 'queue',
    notice: undefined,
  })
  expect(
    composerStatus({ ...base, provider: null, installed: undefined, session: stopped }),
  ).toEqual({
    label: 'Chat can’t message this agent',
    sendable: false,
    action: 'none',
    notice: 'unsupported',
  })
  expect(
    composerStatus({ ...base, connected: false, installed: true, session: ready(), ready: true }),
  ).toEqual({ label: 'Session service disconnected', sendable: false, action: 'none' })
  expect(
    composerStatus({ ...base, pending: true, installed: true, session: ready(), ready: true }),
  ).toEqual({ label: 'Waiting for ready prompt…', sendable: false, action: 'none' })
})

test.each(['working', 'needsInput', 'idle'] as const)(
  'busy and unconfirmed %s queues, unsupported and disconnected never queue',
  (state) => {
    const session = ready()
    session.status!.agent!.state = state
    session.status!.agent!.authoritative = false
    const base = {
      pending: false,
      connected: true,
      installed: true as const,
      provider: 'codex' as const,
      session,
      ready: false,
    }
    expect(composerStatus(base).action).toBe('queue')
    expect(composerStatus({ ...base, provider: null }).action).toBe('none')
    expect(composerStatus({ ...base, connected: false }).action).toBe('none')
    expect(composerStatus({ ...base, session: { ...session, disconnected: true } }).action).toBe(
      'none',
    )
  },
)

test('force skips readiness but still rejects changed generations and failed claims', async () => {
  const p = port()
  p.session = () => ({ ...ready(), status: undefined })
  await deliverPrompt(context, 'forced', p, undefined, { force: true })
  expect(p.write).toHaveBeenCalledExactlyOnceWith('forced')
  p.current = () => ({ ...context, generation: 2 })
  await expect(deliverPrompt(context, 'wrong run', p, undefined, { force: true })).rejects.toThrow(
    'changed',
  )
  p.current = () => context
  p.claim = async () => {
    throw new Error('authority')
  }
  await expect(deliverPrompt(context, 'no claim', p, undefined, { force: true })).rejects.toThrow(
    'authority',
  )
  expect(p.write).toHaveBeenCalledTimes(1)
})
