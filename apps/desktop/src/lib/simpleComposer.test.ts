import { expect, test, vi } from 'vitest'
import {
  composerStatus,
  resumeRecipient,
  deliverPrompt,
  editedMentions,
  forceable,
  FORCED_SETTLE_MS,
  forcedSettleAt,
  promptReady,
  transmittedText,
  componentMentions,
  sentFromDraft,
  storyToken,
  waitForPrompt,
  type SendContext,
  type SendPort,
} from './simpleComposer'
import type { SessionState, Story } from '../types'
import { sessionResume } from './ipc'
vi.mock('./ipc', () => ({
  sessionResume: vi.fn(),
  terminalAttach: vi.fn(),
  terminalDetach: vi.fn(),
  terminalPrompt: vi.fn(),
}))
const ready = (): SessionState => ({
  generation: 1,
  running: true,
  status: {
    agent: { state: 'idle', authoritative: true, provider: 'codex', turnId: 'turn', sinceMs: 10 },
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

test('Codex bootstrap blocks ready, forced and working startup paths until its Stop', async () => {
  const session = { ...ready(), chatStartup: 'pending' as 'pending' | 'ready' }
  expect(promptReady(session)).toBe(false)
  expect(
    forceable({
      ...session,
      status: { ...session.status!, agent: { ...session.status!.agent!, state: 'working' } },
    }),
  ).toBe(false)
  const p = { ...port(), session: () => session }
  await expect(deliverPrompt(context, 'User draft', p)).rejects.toThrow('not at a ready prompt')
  expect(p.write).not.toHaveBeenCalled()
  let waits = 0
  await waitForPrompt(context, {
    ...p,
    allowWorking: true,
    wait: async () => {
      waits++
      if (waits === 1) session.status!.agent!.state = 'working'
      else {
        session.status!.agent!.state = 'review'
        session.chatStartup = 'ready'
      }
    },
  })
  expect(waits).toBe(2)
  await deliverPrompt(context, 'User draft', p)
  expect(p.write).toHaveBeenCalledExactlyOnceWith('User draft')
})

test('bootstrap timeout preserves the draft and reports that nothing was sent', async () => {
  let now = 0
  const p = { ...port(), session: () => ({ ...ready(), chatStartup: 'pending' as const }) }
  await expect(
    waitForPrompt(context, {
      ...p,
      allowWorking: true,
      now: () => now,
      wait: async () => {
        now += 10000
      },
    }),
  ).rejects.toThrow('Couldn’t confirm Lead readiness. Your message hasn’t been sent.')
  expect(p.write).not.toHaveBeenCalled()
  expect(
    composerStatus({
      pending: true,
      connected: true,
      provider: 'codex',
      installed: true,
      session: p.session(),
      ready: false,
    }).label,
  ).toBe('Starting Lead · Codex…')
})

test('bootstrap process exit offers reconnect and service loss reports disconnection', () => {
  const options = {
    pending: false,
    connected: true,
    provider: 'codex' as const,
    installed: true,
    ready: false,
    session: { ...ready(), running: false, chatStartup: 'pending' as const },
  }
  expect(composerStatus(options)).toMatchObject({
    sendable: true,
    label: 'Send to start or resume',
  })
  expect(composerStatus({ ...options, connected: false })).toMatchObject({
    sendable: false,
    label: 'Session service disconnected',
  })
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
test('story tokens name their item and its details follow the message once', () => {
  const item = (id: string, kind: Story['kind'], parent: string | null, title: string): Story => ({
    id,
    kind,
    parent,
    title,
    description: kind === 'story' ? 'Read CSV files.\nSkip blank rows.' : '',
    acceptance: kind === 'story' ? ['Imports a sample file'] : [],
    components: [],
    task: null,
    status: 'backlog',
    createdMs: 1,
    order: 0,
  })
  const board = [
    item('e1', 'epic', null, 'Data'),
    item('f1', 'feature', 'e1', 'Import'),
    item('s1', 'story', 'f1', 'CSV import!'),
  ]
  const token = storyToken(board[2])
  expect(token).toBe('@csv-import')
  expect(storyToken({ id: 's9', title: '!!!' })).toBe('@s9')
  expect(storyToken({ id: 's8', title: 'a' + '𝒜'.repeat(45) })).toBe('@a' + '𝒜'.repeat(39))
  const draft = `Plan ${token} after @app, then ${token} again`
  const at = (text: string, from = 0) => draft.indexOf(text, from)
  const mentions = [
    { id: 's1', token, start: at(token), end: at(token) + token.length, kind: 'story' as const },
    { id: 'app', token: '@app', start: at('@app'), end: at('@app') + 4 },
    {
      id: 's1',
      token,
      start: at(token, at(token) + 1),
      end: at(token, at(token) + 1) + token.length,
      kind: 'story' as const,
    },
  ]
  expect(transmittedText(draft, mentions, board)).toBe(
    [
      'Plan [Story s1: CSV import!] after , then [Story s1: CSV import!] again',
      '',
      'Referenced from the story board:',
      '- Story s1: CSV import! (backlog; in Data → Import)',
      '  Read CSV files.',
      '  Skip blank rows.',
      '  - [ ] Imports a sample file',
    ].join('\n'),
  )
  // Components scope the work; stories never become component ids.
  expect(componentMentions(mentions)).toEqual(['app'])
  // A deleted item keeps its id in the text but adds no details; an edited token stays literal.
  expect(transmittedText(draft, mentions.slice(0, 1), [])).toBe(
    `Plan [Story s1] after @app, then ${token} again`,
  )
  expect(transmittedText(`Plan @csv`, mentions.slice(0, 1), board)).toBe('Plan @csv')
  // A story planned right after sending still confirms the draft that sent it.
  const sent = transmittedText(draft, mentions, board)
  const planned = board.map((s) => (s.id === 's1' ? { ...s, status: 'planned' as const } : s))
  expect(sentFromDraft(sent, draft, mentions, planned)).toBe(true)
  expect(sentFromDraft(sent, `${draft}!`, mentions, planned)).toBe(false)
  expect(sentFromDraft('x', 'x', [])).toBe(true)
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
test.each([true, false])(
  'a failed write is attempted once, preserves the draft and keeps its stamp only when uncertain=%s',
  async (uncertain) => {
    const p = port()
    const stamps: (number | undefined)[] = []
    p.onSubmit = (atMs) => stamps.push(atMs)
    let draft = '  draft\n'
    p.write = vi.fn(async () => {
      throw Object.assign(new Error('Send failed'), { uncertain })
    })
    await expect(
      deliverPrompt(context, draft, p).then(() => {
        draft = ''
      }),
    ).rejects.toThrow('Send failed')
    expect(draft).toBe('  draft\n')
    expect(p.write).toHaveBeenCalledOnce()
    expect(p.release).toHaveBeenCalledOnce()
    expect(stamps).toEqual(uncertain ? [2000] : [2000, undefined])
  },
)

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
  ).rejects.toThrow(/^No ready prompt after 30 seconds\. Retry, or restart the agent\.$/)
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
  // Running without a hook-confirmed turn never queues: nothing would report its end.
  const quiet: SessionState = { generation: 1, running: true }
  expect(composerStatus({ ...base, installed: false, session: quiet })).toMatchObject({
    label: 'Chat needs agent status integration',
    sendable: false,
    action: 'none',
    notice: 'missing',
  })
  expect(composerStatus({ ...base, installed: true, session: quiet })).toMatchObject({
    label: 'Waiting for the agent',
    sendable: false,
    action: 'none',
  })
  const escaped = ready()
  escaped.status!.agent!.authoritative = false
  expect(composerStatus({ ...base, installed: true, session: escaped })).toMatchObject({
    label: 'Not confirmed ready: Interrupt to send',
    sendable: false,
    action: 'none',
  })
  expect(composerStatus({ ...base, installed: false, session: escaped })).toMatchObject({
    label: 'Not confirmed ready: Interrupt to send',
    sendable: false,
    action: 'none',
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

test('a session interrupted by a restarted service can resume once the service reconnects', () => {
  const base = {
    pending: false,
    provider: 'codex' as const,
    installed: true as const,
    ready: false,
  }
  const stopped = { ...ready(), running: false, disconnected: true, interrupted: true }
  expect(composerStatus({ ...base, connected: false, session: stopped }).sendable).toBe(false)
  expect(composerStatus({ ...base, connected: true, session: stopped })).toEqual({
    label: 'Send to start or resume',
    sendable: true,
    action: 'send',
  })
  expect(
    composerStatus({ ...base, connected: true, session: { ...stopped, running: true } }).sendable,
  ).toBe(false)
})

test.each(['working', 'needsInput', 'idle'] as const)(
  'unconfirmed %s never queues: no hook would report the end of its turn',
  (state) => {
    const session = ready()
    session.status!.agent!.state = state
    session.status!.agent!.authoritative = false
    expect(
      composerStatus({
        pending: false,
        connected: true,
        installed: true,
        provider: 'codex',
        session,
        ready: false,
      }),
    ).toMatchObject({ sendable: false, action: 'none' })
  },
)

test.each(['working', 'needsInput'] as const)(
  'confirmed %s queues, unsupported and disconnected never queue',
  (state) => {
    const session = ready()
    session.status!.agent!.state = state
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

const withAgent = (
  agent: Partial<NonNullable<NonNullable<SessionState['status']>['agent']>>,
): SessionState => ({
  ...ready(),
  status: { ...ready().status!, agent: { ...ready().status!.agent!, ...agent } },
})
test('only a Codex hook-confirmed working turn without a pending approval is forceable', () => {
  expect(forceable(withAgent({ state: 'working' }))).toBe(true)
  expect(forceable(withAgent({ state: 'working', provider: 'claude' }))).toBe(false)
  expect(forceable(withAgent({ state: 'working', provider: null }))).toBe(false)
  expect(forceable(withAgent({ state: 'working', turnId: null }))).toBe(false)
  // A Codex permission request in its grace, or any input wait, may be a dialog Enter approves.
  expect(forceable(withAgent({ state: 'working', approvalPending: true }))).toBe(false)
  expect(forceable(withAgent({ state: 'needsInput' }))).toBe(false)
  // Esc or a legacy status file leaves the state unconfirmed; no hooks means no status at all.
  expect(forceable(withAgent({ state: 'working', authoritative: false }))).toBe(false)
  expect(forceable({ ...ready(), status: undefined })).toBe(false)
  expect(forceable({ ...withAgent({ state: 'working' }), running: false })).toBe(false)
  expect(forceable({ ...withAgent({ state: 'working' }), disconnected: true })).toBe(false)
  expect(forceable(ready())).toBe(false)
})
test('force refuses agents that may show a dialog, before claiming', async () => {
  for (const session of [
    { ...ready(), status: undefined },
    withAgent({ state: 'needsInput' }),
    withAgent({ state: 'working', approvalPending: true }),
    withAgent({ state: 'working', authoritative: false }),
  ]) {
    const p = port()
    p.session = () => session
    await expect(deliverPrompt(context, 'x', p, undefined, { force: true })).rejects.toThrow(
      'not confirmed working',
    )
    expect(p.claim).not.toHaveBeenCalled()
    expect(p.write).not.toHaveBeenCalled()
  }
})
test('force skips readiness but still rejects changed generations and failed claims', async () => {
  const p = port()
  p.session = () => withAgent({ state: 'working' })
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

test('a forced submission waits for its new turn, even if the interrupted turn stops later', () => {
  const submitted = { atMs: 100, previousTurnId: 'old' }
  const stopped = withAgent({ state: 'review', sinceMs: 200, turnId: 'old' })
  expect(promptReady(stopped, submitted, 200 + FORCED_SETTLE_MS - 1)).toBe(false)
  // Codex steered the message into that turn: no new turn follows its Stop.
  expect(forcedSettleAt(stopped, submitted)).toBe(200 + FORCED_SETTLE_MS)
  expect(promptReady(stopped, submitted, 200 + FORCED_SETTLE_MS)).toBe(true)
  // A Stop from before the forced message says nothing about it.
  const earlier = withAgent({ state: 'review', sinceMs: 50, turnId: 'old' })
  expect(promptReady(earlier, submitted, 50 + FORCED_SETTLE_MS)).toBe(false)
  expect(forcedSettleAt(earlier, submitted)).toBeUndefined()
  expect(promptReady(withAgent({ state: 'working', sinceMs: 300, turnId: 'new' }), submitted)).toBe(
    false,
  )
  expect(promptReady(withAgent({ state: 'review', sinceMs: 400, turnId: 'new' }), submitted)).toBe(
    true,
  )
  expect(promptReady(withAgent({ state: 'review', sinceMs: 400, turnId: null }), submitted)).toBe(
    false,
  )
})

test('a stopped reviewer resumes before a follow-up is delivered; failed resume keeps the draft', async () => {
  const p = port()
  let session = { ...ready(), running: false }
  p.session = () => session
  let draft = 'Why is this finding high priority?'
  const events: string[] = []
  vi.mocked(sessionResume).mockImplementationOnce(async () => {
    expect(p.write).not.toHaveBeenCalled()
    events.push('resume')
    session = ready()
    return 's'
  })
  const send = async () => {
    await resumeRecipient('s', 'request', async () => {
      events.push('claim')
    })
    await waitForPrompt(context, p)
    await deliverPrompt(context, draft, p)
    draft = ''
  }
  await send()
  expect(events).toEqual(['resume', 'claim'])
  expect(p.write).toHaveBeenCalledExactlyOnceWith('Why is this finding high priority?')
  expect(draft).toBe('')
  draft = 'Can you explain another finding?'
  vi.mocked(sessionResume).mockRejectedValueOnce(
    new Error('Provider history is missing; restore it'),
  )
  await expect(send()).rejects.toThrow('history is missing')
  expect(draft).toBe('Can you explain another finding?')
  expect(events).toEqual(['resume', 'claim'])
  expect(p.write).toHaveBeenCalledOnce()
})

test('startup can queue behind the lead coordination turn without waiting for its completion', async () => {
  const working = ready()
  working.status!.agent!.state = 'working'
  await waitForPrompt(context, {
    current: () => context,
    session: () => working,
    allowWorking: true,
  })
  expect(promptReady(working)).toBe(false)
})

test('Interrupt needs a hook-reporting process away from a ready prompt', async () => {
  const { interruptible } = await import('./simpleComposer')
  const working = {
    running: true,
    generation: 1,
    status: { agent: { state: 'working', authoritative: true, sinceMs: 1 } },
  } as unknown as SessionState
  expect(interruptible(working, false)).toBe(true)
  expect(interruptible(working, true)).toBe(false)
  expect(interruptible({ ...working, running: false }, false)).toBe(false)
  expect(interruptible({ ...working, chatStartup: 'pending' }, false)).toBe(false)
  expect(interruptible({ ...working, disconnected: true }, false)).toBe(false)
  // Without hooks in this run, the service could not confirm the interrupt.
  expect(interruptible({ running: true, generation: 1 } as SessionState, false)).toBe(false)
  expect(interruptible(undefined, false)).toBe(false)
})

test('the agent’s own prompt hook settles an unconfirmed delivery', async () => {
  const { deliveryConfirmed } = await import('./simpleComposer')
  const message = {
    generation: 2,
    text: 'Fix the parser\nand its tests',
    atMs: 100,
    previousTurnId: 'before' as string | null,
  }
  const session = (agent: object, generation = 2) =>
    ({
      running: true,
      generation,
      status: {
        agent: {
          authoritative: true,
          sinceMs: 150,
          turnId: 'after',
          prompt: 'Fix the parser',
          ...agent,
        },
      },
    }) as unknown as SessionState
  expect(deliveryConfirmed(message, session({}))).toBe(true)
  // Notes sent after the message run on in the reported prompt.
  const carried = `${message.text}\n\n[Patchbay note, no reply needed]\nA merge started.`
  expect(deliveryConfirmed(message, session({ prompt: carried }))).toBe(true)
  // An earlier turn, another process, another prompt or an unconfirmed report settle nothing.
  expect(deliveryConfirmed(message, session({ sinceMs: 50 }))).toBe(false)
  expect(deliveryConfirmed(message, session({}, 3))).toBe(false)
  expect(deliveryConfirmed(message, session({ prompt: 'Something else' }))).toBe(false)
  expect(deliveryConfirmed(message, session({ prompt: null }))).toBe(false)
  expect(deliveryConfirmed(message, session({ authoritative: false }))).toBe(false)
  expect(deliveryConfirmed(message, undefined)).toBe(false)
  // The turn the message was written in may hold an earlier prompt reading the same, and its
  // state changes (an interrupt, a notification) move `sinceMs` on without a new prompt.
  expect(deliveryConfirmed(message, session({ turnId: 'before', sinceMs: 900 }))).toBe(false)
  expect(deliveryConfirmed(message, session({ turnId: null }))).toBe(false)
  expect(deliveryConfirmed({ ...message, previousTurnId: null }, session({}))).toBe(true)
  // A message stored before turns were recorded waits for the user.
  expect(deliveryConfirmed({ ...message, previousTurnId: undefined }, session({}))).toBe(false)
})

test('pasted images become path lines of their own at the caret', async () => {
  const { withImages } = await import('./simpleComposer')
  expect(withImages('', 0, ['/a.png'])).toEqual({ draft: 'Image: /a.png', caret: 13 })
  expect(withImages('Look at this', 12, ['/a.png', '/b.jpg'])).toEqual({
    draft: 'Look at this\nImage: /a.png\nImage: /b.jpg',
    caret: 40,
  })
  const middle = withImages('before after', 6, ['/a.png'])
  expect(middle.draft).toBe('before\nImage: /a.png\n after')
  expect(middle.draft.slice(0, middle.caret)).toBe('before\nImage: /a.png')
  expect(withImages('line\n', 99, ['/a.png']).draft).toBe('line\nImage: /a.png')
  expect(withImages('keep', 2, [])).toEqual({ draft: 'keep', caret: 2 })
})

test('only image files are attached', async () => {
  const { imageFiles } = await import('./simpleComposer')
  const file = (type: string) => ({ type }) as File
  expect(imageFiles([file('image/png'), file('text/plain'), file('image/jpeg')])).toEqual([
    file('image/png'),
    file('image/jpeg'),
  ])
  expect(imageFiles(null)).toEqual([])
})
