import { expect, test, vi } from 'vitest'
import {
  deliverPrompt,
  editedMentions,
  pastePrompt,
  promptReady,
  transmittedText,
  type SendContext,
  type SendPort,
} from './simpleComposer'
import type { SessionState } from '../types'
const ready = (): SessionState => ({
  generation: 1,
  running: true,
  status: {
    agent: { state: 'idle', authoritative: true, sinceMs: 10 },
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
test('exact bracketed paste preserves literal emails, unknown mentions, whitespace, and multiline text', async () => {
  const draft = '  @app mail@site.test @unknown\n  second line  '
  const text = transmittedText(draft, [{ id: 'app', token: '@app', start: 2, end: 6 }])
  expect(text).toBe('   mail@site.test @unknown\n  second line  ')
  const p = port()
  await deliverPrompt(context, text, p)
  expect(p.write).toHaveBeenCalledExactlyOnceWith(
    '\x1b[200~   mail@site.test @unknown\n  second line  \x1b[201~\r',
  )
  expect(pastePrompt('\n')).toBe('\x1b[200~\n\x1b[201~\r')
  expect(transmittedText('@app', [{ id: 'app', token: '@app', start: 0, end: 4 }])).toBe('')
})
test('only intact selected tokens are stripped; edits relocate or invalidate structured tokens', () => {
  const tokens = [{ id: 'a', token: '@app', start: 2, end: 6 }]
  expect(editedMentions('x @app', 'xx @app', tokens)).toEqual([{ ...tokens[0], start: 3, end: 7 }])
  expect(editedMentions('x @app', 'x @apple', tokens)).toEqual(tokens)
  expect(editedMentions('x @app', 'x @axp', tokens)).toEqual([])
  expect(transmittedText('x @other', tokens)).toBe('x @other')
})
test('readiness needs running prompt, authoritative hooks take precedence over quiet output', () => {
  expect(promptReady(ready(), 2000)).toBe(true)
  expect(promptReady({ ...ready(), running: false }, 2000)).toBe(false)
  expect(
    promptReady(
      {
        ...ready(),
        status: { ...ready().status!, agent: { ...ready().status!.agent!, state: 'needsInput' } },
      },
      2000,
    ),
  ).toBe(false)
  expect(
    promptReady(
      {
        ...ready(),
        status: { ...ready().status!, agent: { ...ready().status!.agent!, state: 'working' } },
      },
      2000,
    ),
  ).toBe(false)
  const fallback = { ...ready(), status: { ...ready().status!, agent: null } }
  expect(promptReady(fallback, 1008)).toBe(false)
  expect(promptReady(fallback, 1009)).toBe(true)
  expect(
    promptReady({ ...fallback, status: { ...fallback.status, lastOutputMs: null } }, 5000),
  ).toBe(false)
  expect(promptReady(ready(), 2000, 11)).toBe(false)
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
test('an uncertain failed write is attempted once and preserves the originating draft', async () => {
  const p = port()
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
})
