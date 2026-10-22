import type { SessionState } from '../types'
import type { Mention } from './simpleUi'

/** Only tokens selected through autocomplete are removed. Literal @text stays byte-for-byte. */
export function transmittedText(draft: string, mentions: readonly Mention[]) {
  let text = draft
  for (const m of [...mentions].sort((a, b) => b.start - a.start))
    if (text.slice(m.start, m.end) === m.token) text = text.slice(0, m.start) + text.slice(m.end)
  return text
}
/** Preserve structured token identity across edits; overlapping edits turn it back into literal text. */
export function editedMentions(
  before: string,
  after: string,
  mentions: readonly Mention[],
): Mention[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = before.length,
    afterEnd = after.length
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
    end--
    afterEnd--
  }
  const delta = after.length - before.length
  return mentions.flatMap((m) =>
    m.end === start && delta > 0 && /\S/.test(after[start] ?? '')
      ? []
      : m.end <= start
        ? [m]
        : m.start >= end
          ? [{ ...m, start: m.start + delta, end: m.end + delta }]
          : [],
  )
}
/**
 * Mirrors the service's `prompt_ready`: only a hook-confirmed end of turn. Quiet output can't
 * tell a ready prompt from a permission dialog, so sessions without status hooks never qualify.
 */
export function promptReady(session: SessionState | undefined, submittedMs?: number) {
  if (!session?.running || session.disconnected || session.interrupted) return false
  const agent = session.status?.agent
  return (
    !!agent?.authoritative &&
    ['idle', 'review'].includes(agent.state) &&
    (submittedMs === undefined || agent.sinceMs > submittedMs)
  )
}
export interface SendContext {
  projectId: string
  task: string | null
  recipient: string
  generation: number
}
export interface SendPort {
  current: () => SendContext | undefined
  session: () => SessionState | undefined
  claim: () => Promise<void>
  /** Pastes and submits `text` in one acknowledged service request. */
  write: (text: string) => Promise<void>
  release: () => Promise<void>
  now?: () => number
  /** The submit time while a send is in flight or delivered; undefined once it certainly failed. */
  onSubmit?: (atMs: number | undefined) => void
}
const sending = new Set<string>()
/** One send per session, with scope and readiness checked around the claim. */
export async function deliverPrompt(
  context: SendContext,
  text: string,
  port: SendPort,
  submittedMs?: number,
) {
  if (sending.has(context.recipient))
    throw new Error('A message is already pending for this session')
  const current = () => {
    const c = port.current()
    if (
      !c ||
      c.projectId !== context.projectId ||
      c.task !== context.task ||
      c.recipient !== context.recipient ||
      c.generation !== context.generation
    )
      throw new Error('The worktree or recipient changed. Your draft was kept.')
    if (!promptReady(port.session(), submittedMs))
      throw new Error('The agent is not at a ready prompt. Your draft was kept.')
  }
  sending.add(context.recipient)
  let claimed = false
  try {
    current()
    await port.claim()
    claimed = true
    current()
    port.onSubmit?.(port.now?.() ?? Date.now())
    try {
      await port.write(text)
    } catch (e) {
      // A refused send leaves no stamp that would keep Send disabled for this generation.
      port.onSubmit?.(undefined)
      throw e
    }
  } finally {
    sending.delete(context.recipient)
    if (claimed) await port.release().catch(() => {})
  }
}

/** Startup is a bounded wait, cancelled immediately when its captured scope or process changes. */
export async function waitForPrompt(
  context: SendContext,
  port: Pick<SendPort, 'current' | 'session' | 'now'> & { wait?: (ms: number) => Promise<void> },
) {
  const now = port.now ?? Date.now
  const began = now()
  for (;;) {
    const current = port.current()
    const session = port.session()
    if (
      !current ||
      current.projectId !== context.projectId ||
      current.task !== context.task ||
      current.recipient !== context.recipient ||
      current.generation !== context.generation ||
      !session?.running
    )
      throw new Error('The worktree or session changed. Your draft was kept.')
    if (session.status?.agent?.state === 'needsInput')
      throw new Error('The agent needs input in its terminal.')
    if (promptReady(session)) return
    if (now() - began >= 30000)
      throw new Error(
        session.status?.agent?.authoritative
          ? 'No ready prompt after 30 seconds. Open the terminal to continue.'
          : 'No ready prompt after 30 seconds. Chat needs Tools → Agent status integration, or open the terminal to continue.',
      )
    await (port.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      100,
    )
  }
}
