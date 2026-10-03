import { useStore } from '../store'
import type { TerminalEvent, TerminalSnapshot } from '../types'
import { onTerminalEvent, terminalSnapshot, terminalStart, terminalStop } from './ipc'
import { restoreOutput, writeNote, writeOutput } from './terminals'

const lastSeq = new Map<string, { generation: number; end: number }>()
const pending = new Map<string, TerminalEvent[]>()
const hydration = new Map<string, Promise<TerminalSnapshot | null>>()
const starting = new Map<string, Promise<void>>()
let listening: Promise<void> | undefined

/** Each webview keeps one listener for its lifetime, including React StrictMode remounts. */
export function listenForTerminals() {
  listening ??= onTerminalEvent(handleTerminalEvent)
    .then(() => {})
    .catch((e) => {
      listening = undefined
      throw e
    })
  return listening
}

export function startTerminal(componentId: string, terminalId: string): Promise<void> {
  const sid = `${componentId}/${terminalId}`
  const existing = starting.get(sid)
  if (existing) return existing
  const request = (async () => {
    const s = useStore.getState()
    try {
      await listenForTerminals()
      await terminalStart(s.toProject(), componentId, terminalId)
    } catch (e) {
      // Another window may have auto-started the same shell in the meantime.
      const snapshot = await terminalSnapshot(sid).catch(() => null)
      if (!snapshot?.running) s.setMessage(String(e))
    }
  })().finally(() => starting.delete(sid))
  starting.set(sid, request)
  return request
}

export const stopTerminal = (sessionId: string) =>
  void terminalStop(sessionId).catch((e) => useStore.getState().setMessage(String(e)))

/** Apply a backend terminal event to the store and the session's xterm. */
export function handleTerminalEvent(e: TerminalEvent) {
  const queue = pending.get(e.sessionId)
  if (queue) {
    queue.push(e)
    return
  }
  const s = useStore.getState()
  let cursor = lastSeq.get(e.sessionId)
  if (cursor && e.generation < cursor.generation) return
  const newGeneration = !cursor || e.generation > cursor.generation
  if (newGeneration) {
    cursor = { generation: e.generation, end: 0 }
    lastSeq.set(e.sessionId, cursor)
  }
  switch (e.type) {
    case 'started':
      if (!newGeneration) break // Snapshot already includes this start.
      s.setSession(e.sessionId, { running: true })
      writeNote(e.sessionId, `── started ${new Date().toLocaleTimeString()} ──`)
      break
    case 'output': {
      const covered = Math.max(0, cursor!.end - e.seq)
      if (covered >= e.data.length) break
      writeOutput(e.sessionId, e.data.slice(covered))
      cursor!.end = e.seq + e.data.length
      break
    }
    case 'exited':
      if (!s.sessions[e.sessionId]?.running && s.sessions[e.sessionId]?.exitCode === e.exitCode)
        break
      s.setSession(e.sessionId, { running: false, exitCode: e.exitCode })
      writeNote(e.sessionId, `── exited ${e.exitCode} ──`)
      break
  }
}

/** Listen first, buffer live events during the snapshot, then replay only uncovered bytes. */
export function hydrateSession(sid: string): Promise<TerminalSnapshot | null> {
  const existing = hydration.get(sid)
  if (existing) return existing
  const queue: TerminalEvent[] = []
  pending.set(sid, queue)
  const request = (async () => {
    try {
      await listenForTerminals()
      const snapshot = await terminalSnapshot(sid)
      if (snapshot) {
        await restoreOutput(sid, snapshot.data)
        lastSeq.set(sid, { generation: snapshot.generation, end: snapshot.end })
        useStore.getState().setSession(sid, {
          running: snapshot.running,
          exitCode: snapshot.exitCode ?? undefined,
        })
      }
      return snapshot
    } finally {
      pending.delete(sid)
      for (const event of queue) handleTerminalEvent(event)
    }
  })().catch((e) => {
    hydration.delete(sid)
    throw e
  })
  hydration.set(sid, request)
  return request
}
