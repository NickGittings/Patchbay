import { useStore } from '../store'
import type { TerminalEvent } from '../types'
import { terminalStart, terminalStop } from './ipc'
import { writeNote, writeOutput } from './terminals'

export async function startTerminal(componentId: string, terminalId: string) {
  const s = useStore.getState()
  try {
    await terminalStart(s.toProject(), componentId, terminalId)
  } catch (e) {
    s.setMessage(String(e))
  }
}

export const stopTerminal = (sessionId: string) => void terminalStop(sessionId)

/** Apply a backend terminal event to the store and the session's xterm. */
export function handleTerminalEvent(e: TerminalEvent) {
  const s = useStore.getState()
  switch (e.type) {
    case 'started':
      s.setSession(e.sessionId, { running: true })
      writeNote(e.sessionId, `── started ${new Date().toLocaleTimeString()} ──`)
      break
    case 'output':
      writeOutput(e.sessionId, e.data)
      break
    case 'exited':
      s.setSession(e.sessionId, { running: false, exitCode: e.exitCode })
      writeNote(e.sessionId, `── exited ${e.exitCode} ──`)
      break
  }
}
