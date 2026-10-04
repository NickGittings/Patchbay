import { executeExtensionCommand } from '../extensions/host'
import { extensionTerminalRun } from './ipc'
import { useStore } from '../store'
import { PLAN_SCOPE, sessionId, type TerminalEvent, type TerminalSnapshot } from '../types'
import { onTerminalEvent, planStart, terminalSnapshot, terminalStart, terminalStop } from './ipc'
import { planTerminals } from './plan'
import { requestGitRefresh } from './git'
import { disposeAll, replayOutput, restoreOutput, writeNote, writeOutput } from './terminals'

/**
 * How far this window's xterm has got through a session's current run. `complete`
 * means it holds the run from its first byte, so a snapshot only needs to fill the tail.
 */
interface Cursor {
  generation: number
  end: number
  complete: boolean
}

const lastSeq = new Map<string, Cursor>()
const pending = new Map<string, TerminalEvent[]>()
const hydration = new Map<string, Promise<TerminalSnapshot | null>>()
const starting = new Map<string, Promise<void>>()
let listening: Promise<void> | undefined
/** Events at or below this generation belong to a project that has since been closed. */
let floor = 0
/** Bumped by `resetSessions` so in-flight hydrations don't write into the new project. */
let epoch = 0

/**
 * Forget every session and dispose their xterms, e.g. after opening a project.
 * `generationFloor` comes from `terminalReset`; later events from killed sessions are dropped.
 */
export function resetSessions(generationFloor: number) {
  floor = Math.max(floor, generationFloor)
  epoch++
  lastSeq.clear()
  pending.clear()
  hydration.clear()
  starting.clear()
  disposeAll()
}

const decodeBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

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
  const sid = sessionId(componentId, terminalId)
  const existing = starting.get(sid)
  if (existing) return existing
  const request = (async () => {
    const requestedEpoch = epoch
    try {
      await listenForTerminals()
      if (requestedEpoch !== epoch) return
      const s = useStore.getState()
      const runtime = s.runtimeTerminals[sid]
      if (runtime?.commandId) await executeExtensionCommand(runtime.commandId, [], componentId)
      else if (runtime?.extensionId && runtime.key)
        await extensionTerminalRun(
          s.toProject(),
          runtime.extensionId,
          componentId,
          runtime.terminal.command,
          runtime.key,
        )
      else if (componentId === PLAN_SCOPE) {
        const terminal = planTerminals(s.devices).find((t) => t.id === terminalId)
        if (!terminal) throw new Error(`Unknown planner terminal ${terminalId}`)
        const ids = [...s.highlighted]
        await planStart(s.toProject(), ids, terminal)
        if (requestedEpoch === epoch) s.markPlanStarted(sid, ids)
      } else {
        await terminalStart(s.toProject(), componentId, terminalId)
      }
    } catch (e) {
      // Another window may have auto-started the same shell in the meantime.
      const snapshot = await terminalSnapshot(sid).catch(() => null)
      if (requestedEpoch === epoch && !snapshot?.running) useStore.getState().setMessage(String(e))
    }
  })().finally(() => {
    if (starting.get(sid) === request) starting.delete(sid)
  })
  starting.set(sid, request)
  return request
}

export const stopTerminal = (sessionId: string) =>
  void terminalStop(sessionId).catch((e) => useStore.getState().setMessage(String(e)))

/** Restart only after the old process exits, so it cannot race the new spawn. */
export async function restartTerminal(componentId: string, terminalId: string) {
  const sid = sessionId(componentId, terminalId)
  const requestedEpoch = epoch
  try {
    await terminalStop(sid)
    const deadline = Date.now() + 10000
    while ((await terminalSnapshot(sid))?.running) {
      if (requestedEpoch !== epoch) return
      if (Date.now() >= deadline) throw new Error('Terminal is still stopping. Try Restart again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (requestedEpoch === epoch) await startTerminal(componentId, terminalId)
  } catch (e) {
    if (requestedEpoch === epoch) useStore.getState().setMessage(String(e))
  }
}

/** Apply a backend terminal event to the store and the session's xterm. */
export function handleTerminalEvent(e: TerminalEvent) {
  if (e.generation <= floor) return
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
    // Only a `started` event guarantees this window sees the run from its first byte.
    cursor = { generation: e.generation, end: 0, complete: e.type === 'started' }
    lastSeq.set(e.sessionId, cursor)
  }
  switch (e.type) {
    case 'started':
      if (!newGeneration) break // Snapshot already includes this start.
      s.setSession(e.sessionId, { running: true, startedMs: e.startedMs })
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
      void requestGitRefresh()
      s.setSession(e.sessionId, {
        ...s.sessions[e.sessionId],
        running: false,
        exitCode: e.exitCode,
        exitedMs: e.exitedMs,
      })
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
  const started = epoch
  const request = (async () => {
    try {
      await listenForTerminals()
      const snapshot = await terminalSnapshot(sid)
      if (started !== epoch) return null
      if (snapshot) {
        await applySnapshot(sid, snapshot)
        useStore.getState().setSession(sid, {
          running: snapshot.running,
          exitCode: snapshot.exitCode ?? undefined,
          startedMs: snapshot.startedMs,
          exitedMs: snapshot.exitedMs ?? undefined,
        })
      }
      return snapshot
    } finally {
      if (started === epoch) {
        pending.delete(sid)
        for (const event of queue) handleTerminalEvent(event)
      }
    }
  })().catch((e) => {
    if (started === epoch) hydration.delete(sid)
    throw e
  })
  hydration.set(sid, request)
  return request
}

/**
 * Bring the xterm up to date with a snapshot. If it already holds this run from the start,
 * append only the missing tail so earlier runs and notes stay in the scrollback.
 */
async function applySnapshot(sid: string, snapshot: TerminalSnapshot) {
  let bytes = decodeBase64(snapshot.data)
  const start = snapshot.end - bytes.length
  const cursor = lastSeq.get(sid)
  if (cursor && cursor.generation > snapshot.generation) return
  if (cursor?.complete && cursor.generation === snapshot.generation && cursor.end >= start) {
    const from = cursor.end - start
    if (from < bytes.length) replayOutput(sid, bytes.subarray(from))
    cursor.end = Math.max(cursor.end, snapshot.end)
    return
  }
  // A truncated backlog can begin mid escape sequence or character; start at a line.
  if (start > 0) bytes = bytes.subarray(bytes.indexOf(0x0a) + 1)
  await restoreOutput(sid, bytes)
  lastSeq.set(sid, { generation: snapshot.generation, end: snapshot.end, complete: start === 0 })
}
