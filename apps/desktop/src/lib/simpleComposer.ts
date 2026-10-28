import type { SessionState } from '../types'
import { useStore } from '../store'
import { terminalAttach, terminalDetach, terminalPrompt } from './ipc'
import { logSimple } from './simpleActions'
import { persistReplies } from './simpleReplies'
import type { SimpleStage } from './simple'
import type { Mention } from './simpleUi'
import { sessionReportedHooks, type HooksCheck } from './agentHooks'

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
/** Why chat may ask for status hooks beside the composer: missing, unreadable, or never possible. */
export type HooksNotice = 'missing' | 'failed' | 'unsupported'
/**
 * The composer's primary action and status for a nonempty draft. Busy agents with hooks queue
 * until their next ready prompt. A hook-confirmed ready prompt is sendable whatever the
 * installed-hooks check says, since a session's login shell may point the provider at another
 * configuration; that check refuses only starting or resuming an agent, which could never report
 * a ready prompt without hooks.
 */
export function composerStatus({
  pending,
  connected,
  provider,
  installed,
  session,
  ready,
}: {
  pending: boolean
  connected: boolean
  /** The agent's provider; `null` for neither Claude nor Codex, `undefined` while unknown. */
  provider: 'claude' | 'codex' | null | undefined
  installed: HooksCheck | undefined
  session: SessionState | undefined
  /** `promptReady` for the session. */
  ready: boolean
}): { label: string; sendable: boolean; action: 'send' | 'queue' | 'none'; notice?: HooksNotice } {
  if (pending) return { label: 'Waiting for ready prompt…', sendable: false, action: 'none' }
  if (!connected || session?.disconnected || session?.interrupted)
    return { label: 'Session service disconnected', sendable: false, action: 'none' }
  const running = !!session?.running
  if (running && ready) return { label: 'Ready', sendable: true, action: 'send' }
  if (provider === null)
    return {
      label: 'Chat can’t message this agent',
      sendable: false,
      action: 'none',
      notice: 'unsupported',
    }
  const agent = session?.status?.agent
  const reporting = sessionReportedHooks(session) || (running && !!agent?.authoritative)
  const notice = reporting
    ? undefined
    : installed === false
      ? 'missing'
      : installed === 'failed'
        ? 'failed'
        : undefined
  const needsHooks = 'Chat needs agent status integration'
  if (!running) {
    if (provider === undefined || installed === undefined)
      return { label: 'Checking agent status integration…', sendable: false, action: 'none' }
    if (installed !== true) return { label: needsHooks, sendable: false, action: 'none', notice }
    return { label: 'Send to start or resume', sendable: true, action: 'send' }
  }
  return {
    label:
      agent?.state === 'needsInput'
        ? 'Answer in terminal'
        : agent?.authoritative
          ? 'Agent is working'
          : !reporting && installed === false
            ? needsHooks
            : agent
              ? // Esc or an answered prompt: no hook confirms the prompt until typing.
                'Not confirmed ready: continue in its terminal'
              : 'Waiting for the agent',
    sendable: !!(reporting || installed === true),
    action: reporting || installed === true ? 'queue' : 'none',
    notice,
  }
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
  { force = false }: { force?: boolean } = {},
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
    if (
      force &&
      (!port.session()?.running || port.session()?.disconnected || port.session()?.interrupted)
    )
      throw new Error('The session is unavailable. Your draft was kept.')
    if (!force && !promptReady(port.session(), submittedMs))
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
    if (claimed) await port.release().catch(() => {})
    sending.delete(context.recipient)
  }
}

/** Startup is a bounded wait, cancelled immediately when its captured scope or process changes. */
export async function waitForPrompt(
  context: SendContext,
  port: Pick<SendPort, 'current' | 'session' | 'now'> & {
    wait?: (ms: number) => Promise<void>
    /** The agent's provider; `null` for neither Claude nor Codex, which never report a prompt. */
    provider?: 'claude' | 'codex' | null
  },
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
    // The composer adds hook advice from installed state: `authoritative` can't tell an Esc apart.
    if (now() - began >= 30000)
      throw new Error(
        port.provider === null
          ? 'No ready prompt after 30 seconds. Chat can message only Claude and Codex agents; open the terminal to continue.'
          : 'No ready prompt after 30 seconds. Open the terminal to continue.',
      )
    await (port.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      100,
    )
  }
}

const submitted = new Map<string, { generation: number; atMs: number }>()
export function lastSubmission(sid: string, generation: number | undefined) {
  const stamp = submitted.get(sid)
  return stamp?.generation === generation ? stamp?.atMs : undefined
}

/** Shared delivery for the composer and background queues, including chats no longer selected. */
export async function sendToSession({
  projectId,
  task,
  sid,
  generation,
  text,
  mentions,
  stage,
  force = false,
  current,
}: {
  projectId: string
  task: string | null
  sid: string
  generation: number
  text: string
  mentions: string[]
  stage: SimpleStage
  force?: boolean
  current?: () => SendContext | undefined
}) {
  const captured = { projectId, task, recipient: sid, generation }
  await deliverPrompt(
    captured,
    text,
    {
      current:
        current ??
        (() => ({ ...captured, generation: useStore.getState().sessions[sid]?.generation ?? -1 })),
      session: () => useStore.getState().sessions[sid],
      claim: () => terminalAttach(sid, true),
      write: (message) => terminalPrompt(sid, generation, message, force),
      onSubmit: (atMs) => {
        if (atMs === undefined) submitted.delete(sid)
        else submitted.set(sid, { generation, atMs })
      },
      release: async () => {
        const { hasVisibleTerminal } = await import('./terminals')
        if (!hasVisibleTerminal(sid)) await terminalDetach(sid)
      },
    },
    lastSubmission(sid, generation),
    { force },
  )
  logSimple(projectId, task, {
    kind: 'prompt',
    stage,
    sessionId: sid,
    generation,
    atMs: lastSubmission(sid, generation),
    text,
    mentions,
  })
  persistReplies(sid, generation, useStore.getState().sessions[sid]?.replies ?? [])
}
