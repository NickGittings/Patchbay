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
export const pastePrompt = (text: string) => `\x1b[200~${text}\x1b[201~\r`
export function promptReady(
  session: SessionState | undefined,
  now = Date.now(),
  submittedMs?: number,
) {
  if (!session?.running || session.disconnected || session.interrupted) return false
  const status = session.status,
    agent = status?.agent
  if (agent?.state === 'needsInput') return false
  if (agent?.authoritative)
    return (
      ['idle', 'review'].includes(agent.state) &&
      (submittedMs === undefined || agent.sinceMs > submittedMs)
    )
  const output = status?.lastOutputMs
  return (
    output != null &&
    (submittedMs === undefined || output > submittedMs) &&
    now - output >= 1000 &&
    !status?.active &&
    agent?.state !== 'working'
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
  write: (bytes: string) => Promise<void>
  release: () => Promise<void>
  now?: () => number
}
const sending = new Set<string>()
/** One write attempt per session, with scope and readiness checks on both sides of the claim. */
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
    if (!promptReady(port.session(), port.now?.() ?? Date.now(), submittedMs))
      throw new Error('The agent is not at a ready prompt. Your draft was kept.')
  }
  sending.add(context.recipient)
  let claimed = false
  try {
    current()
    await port.claim()
    claimed = true
    current()
    await port.write(pastePrompt(text))
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
    if (promptReady(session, now())) return
    if (now() - began >= 30000)
      throw new Error('No ready prompt after 30 seconds. Open the terminal to continue.')
    await (port.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      100,
    )
  }
}
