import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { sessionsList } from './ipc'
import { executeExtensionCommand } from '../extensions/host'
import { extensionTerminalRun } from './ipc'
import { projectOf, useStore } from '../store'
import { showsSession } from './windows'
import {
  PLAN_SCOPE,
  type Project,
  type RuntimeTerminal,
  type SessionRecord,
  type SessionState,
  sessionMetadata,
  sessionId,
  type TerminalEvent,
  type TerminalSnapshot,
} from '../types'
import { onTerminalEvent, planStart, terminalSnapshot, terminalStart, terminalStop } from './ipc'
import { peersFor, planTerminals } from './plan'
import { requestGitRefresh } from './git'
import {
  disposeAll,
  markOutputGeneration,
  replayOutput,
  restoreOutput,
  writeNote,
  writeOutput,
} from './terminals'

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

/** The process generation whose output this window currently displays. */
export const sessionGeneration = (sid: string) => lastSeq.get(sid)?.generation
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
  floor = generationFloor
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
  listening ??= Promise.all([
    onTerminalEvent(handleTerminalEvent),
    listen<{ connected: boolean; instanceId?: string }>('patchbay://service', (e) => {
      if (!e.payload.connected) useStore.setState({ serviceConnected: false })
      else void reconcileSessions().catch(() => {})
    }),
  ])
    .then(() => {
      setInterval(() => void reconcileSessions(false).catch(() => {}), 2000)
    })
    .catch((e) => {
      listening = undefined
      throw e
    })
  return listening
}

/** Everything a launch needs, read when it is requested, so a tab switch can't redirect it. */
interface Launch {
  sid: string
  componentId: string
  terminalId: string
  projectId: string
  task: string | null
  project: Project
  highlighted: string[]
  runtime?: RuntimeTerminal
}

/** `task` defaults to the project's active task; `null` is the project's own worktree. */
function captureLaunch(
  componentId: string,
  terminalId: string,
  task?: string | null,
  projectId?: string,
): Launch {
  const s = useStore.getState()
  const id = projectId ?? s.project?.id ?? s.activeProjectId
  const project = id ? projectOf(id) : null
  if (!id || !project) throw new Error('Open a project first')
  const state = s.project?.id === id ? s : s.projects[id]?.state
  const scope = task === undefined ? (state?.activeTask ?? null) : task
  const sid = sessionId(componentId, terminalId, scope, id)
  return {
    sid,
    componentId,
    terminalId,
    projectId: id,
    task: scope,
    project,
    highlighted: [...(state?.highlighted ?? [])],
    runtime: s.runtimeTerminals[sid],
  }
}

/**
 * Start a terminal of `projectId` (default: the active project) in `task`'s worktree (default:
 * that project's active task; `null` for its own worktree).
 */
export function startTerminal(
  componentId: string,
  terminalId: string,
  task?: string | null,
  projectId?: string,
): Promise<void> {
  let launch: Launch
  try {
    launch = captureLaunch(componentId, terminalId, task, projectId)
  } catch (e) {
    useStore.getState().setMessage(String(e))
    return Promise.resolve()
  }
  return launchTerminal(launch)
}

function launchTerminal(launch: Launch): Promise<void> {
  const { sid, componentId, terminalId, project, runtime } = launch
  const task = launch.task ?? undefined
  const existing = starting.get(sid)
  if (existing) return existing
  const requestId = launchRequests.get(sid) ?? crypto.randomUUID()
  launchRequests.set(sid, requestId)
  const request = (async () => {
    const requestedEpoch = epoch
    try {
      await listenForTerminals()
      if (requestedEpoch !== epoch) return
      if (!useStore.getState().serviceConnected)
        throw new Error('Disconnected; reconnect before starting work')
      if (runtime?.commandId)
        await executeExtensionCommand(runtime.commandId, [], componentId, project, launch.task)
      else if (runtime?.extensionId && runtime.key)
        await extensionTerminalRun(
          project,
          runtime.extensionId,
          componentId,
          runtime.terminal.command,
          runtime.key,
          task,
        )
      else if (componentId === PLAN_SCOPE) {
        const terminal = planTerminals(useStore.getState().devices).find((t) => t.id === terminalId)
        if (!terminal) throw new Error(`Unknown planner terminal ${terminalId}`)
        const ids = launch.highlighted
        await planStart(project, ids, terminal, task, requestId)
        if (requestedEpoch === epoch) markPlanStarted(launch.projectId, sid, ids)
      } else {
        await terminalStart(
          project,
          componentId,
          terminalId,
          undefined,
          task,
          requestId,
          peersFor(componentId, launch.highlighted),
        )
      }
      launchRequests.delete(sid)
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

/** Record what a planner started with, in its own project even if another tab is active now. */
function markPlanStarted(projectId: string, sid: string, ids: string[]) {
  const current = useStore.getState()
  if (current.project?.id === projectId) {
    current.markPlanStarted(sid, ids)
    return
  }
  const entry = current.projects[projectId]
  if (!entry?.state) return
  useStore.setState({
    projects: {
      ...current.projects,
      [projectId]: {
        ...entry,
        state: {
          ...entry.state,
          planStartedWith: {
            ...entry.state.planStartedWith,
            [sid]: [...ids].sort().join(','),
          },
        },
      },
    },
  })
}

export const stopTerminal = (sessionId: string) =>
  void terminalStop(sessionId).catch((e) => useStore.getState().setMessage(String(e)))

/** Stop a tiled terminal before removing its saved command from its originating project. */
export async function closeTerminal(componentId: string, terminalId: string, task?: string | null) {
  try {
    const launch = captureLaunch(componentId, terminalId, task)
    if (useStore.getState().sessions[launch.sid]?.running) await terminalStop(launch.sid)
    const s = useStore.getState()
    const origin = s.captureProjects()[launch.projectId]?.state
    if (!origin) return false
    s.patchProject(launch.projectId, {
      nodes: origin.nodes.map((n) =>
        n.id === componentId
          ? {
              ...n,
              data: { ...n.data, terminals: n.data.terminals.filter((t) => t.id !== terminalId) },
            }
          : n,
      ),
      dirty: true,
      activeSession: origin.activeSession === launch.sid ? null : origin.activeSession,
    })
    if (s.project?.id === launch.projectId && s.revealed?.sid === launch.sid) s.setRevealed(null)
    return true
  } catch (e) {
    useStore.getState().setMessage(String(e))
    return false
  }
}

/**
 * Restart only after the old process exits, so it cannot race the new spawn. The new run
 * belongs to the project and task the restart was asked in, even if the user has switched since.
 */
export async function restartTerminal(
  componentId: string,
  terminalId: string,
  task?: string | null,
) {
  const requestedEpoch = epoch
  try {
    const launch = captureLaunch(componentId, terminalId, task)
    await terminalStop(launch.sid)
    const deadline = Date.now() + 10000
    while ((await terminalSnapshot(launch.sid))?.running) {
      if (requestedEpoch !== epoch) return
      if (Date.now() >= deadline) throw new Error('Terminal is still stopping. Try Restart again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (requestedEpoch === epoch) await launchTerminal(launch)
  } catch (e) {
    if (requestedEpoch === epoch) useStore.getState().setMessage(String(e))
  }
}

/** Apply a backend terminal event to the store and the session's xterm. */
export function handleTerminalEvent(e: TerminalEvent) {
  if (e.instanceId && e.instanceId !== useStore.getState().serviceInstance) {
    void reconcileSessions().catch(() => {})
    return
  }
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
    markOutputGeneration(e.sessionId, e.generation, e.type === 'started' ? 1 : 0)
  }
  switch (e.type) {
    case 'started':
      if (!newGeneration) break // Snapshot already includes this start.
      s.setSession(e.sessionId, {
        running: true,
        startedMs: e.startedMs,
        notice: e.notice ?? undefined,
      })
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
      void requestGitRefresh(sessionMetadata.get(e.sessionId)?.projectId)
      s.setSession(e.sessionId, {
        ...s.sessions[e.sessionId],
        running: false,
        exitCode: e.exitCode,
        exitedMs: e.exitedMs,
      })
      writeNote(e.sessionId, `── exited ${e.exitCode} ──`)
      // A failure, or the run being watched, stays in Navigation's dock so its output can be read.
      if (
        e.sessionId === s.activeSession ||
        (e.exitCode !== 0 && !s.sessions[e.sessionId]?.status?.stopped)
      )
        s.keepInDock(e.sessionId)
      break
    case 'status': {
      const prev = s.sessions[e.sessionId]
      // Exited runs still get status (stopped, seen); it never revives one.
      s.setSession(e.sessionId, {
        ...prev,
        running: newGeneration || (prev?.running ?? true),
        status: e.status,
      })
      break
    }
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
          status: snapshot.status,
          notice: snapshot.notice ?? undefined,
          interrupted: useStore.getState().sessionRecords.find((r) => r.id === sid)?.interrupted,
          truncated: snapshot.truncated,
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

/** Refresh a completed hydration after a graph action reused or started a run. */
export async function refreshSession(sid: string): Promise<TerminalSnapshot | null> {
  const started = epoch
  const previous = hydration.get(sid)
  if (previous) await previous.catch(() => null)
  if (started !== epoch) return null
  // Concurrent refreshes join the newer hydration rather than replacing its event queue.
  if (hydration.get(sid) === previous) hydration.delete(sid)
  return hydrateSession(sid)
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
  await restoreOutput(sid, bytes, snapshot.generation)
  lastSeq.set(sid, { generation: snapshot.generation, end: snapshot.end, complete: start === 0 })
}

/** Whether this window's xterm lacks output the service has, e.g. after a gap in events. */
function behind(sid: string, snapshot: TerminalSnapshot | null) {
  const cursor = lastSeq.get(sid)
  if (!cursor || !snapshot) return false
  return cursor.generation !== snapshot.generation || cursor.end < snapshot.end
}

function sameSession(a: SessionState | undefined, b: SessionState) {
  return (
    !!a &&
    a.running === b.running &&
    a.exitCode === b.exitCode &&
    a.startedMs === b.startedMs &&
    a.exitedMs === b.exitedMs &&
    a.notice === b.notice &&
    a.interrupted === b.interrupted &&
    a.truncated === b.truncated &&
    a.disconnected === undefined &&
    JSON.stringify(a.status) === JSON.stringify(b.status)
  )
}

const launchRequests = new Map<string, string>()
let reconciling: Promise<void> | undefined
export function reconcileSessions(force = true): Promise<void> {
  reconciling ??= (async () => {
    try {
      const status = await invoke<{ connected: boolean; instanceId: string }>('service_status')
      if (!status.connected) {
        useStore.setState({ serviceConnected: false })
        return
      }
      const records = await sessionsList()
      const current = useStore.getState()
      const changed = status.instanceId !== current.serviceInstance
      const reconnecting = !current.serviceConnected || changed
      if (changed) resetSessions(0)
      useStore.setState({
        serviceConnected: reconnecting ? false : current.serviceConnected,
        serviceInstance: status.instanceId,
        sessionRecords: records,
      })
      // Apply every record before awaiting anything, so events that arrive while
      // sessions hydrate aren't overwritten by this (by then older) list.
      const projects = useStore.getState().captureProjects()
      const onMap = (r: SessionRecord) =>
        projects[r.metadata.projectId]?.state?.nodes.some(
          (n) =>
            n.id === r.metadata.componentId &&
            n.data.terminals.some((t) => t.id === r.metadata.terminalId),
        ) ?? false
      for (const r of records) {
        sessionMetadata.set(r.id, { ...r.metadata, task: r.metadata.task ?? null })
        const snapshot = r.snapshot
        if (snapshot) {
          const next: SessionState = {
            running: snapshot.running,
            exitCode: snapshot.exitCode ?? undefined,
            startedMs: snapshot.startedMs,
            exitedMs: snapshot.exitedMs ?? undefined,
            status: snapshot.status,
            notice: snapshot.notice ?? undefined,
            interrupted: r.interrupted,
            truncated: snapshot.truncated,
          }
          const prev = useStore.getState().sessions[r.id]
          // An exit already seen for this run is newer than a list saying it runs.
          const staleRun =
            prev && !prev.running && next.running && prev.startedMs === next.startedMs
          if (!staleRun && !sameSession(prev, next)) current.setSession(r.id, next)
        }
        const mapped = onMap(r)
        if (mapped && useStore.getState().runtimeTerminals[r.id])
          useStore.setState((s) => {
            const runtimeTerminals = { ...s.runtimeTerminals }
            delete runtimeTerminals[r.id]
            return { runtimeTerminals }
          })
        if (
          r.metadata.componentId !== PLAN_SCOPE &&
          !mapped &&
          !useStore.getState().runtimeTerminals[r.id]
        )
          current.addRuntimeTerminal(r.id, {
            projectId: r.metadata.projectId,
            taskId: r.metadata.task ?? null,
            commandId: r.metadata.commandId ?? undefined,
            extensionId: r.metadata.extensionId ?? undefined,
            key: r.metadata.key ?? undefined,
            componentId: r.metadata.componentId,
            terminal: {
              id: r.metadata.terminalId,
              name: r.metadata.name,
              kind: r.metadata.kind,
              command: r.spec.command,
            },
          })
      }
      for (const r of records) {
        // Only sessions this window shows, and after lost events only those that fell behind.
        if (showsSession(r.metadata) && (reconnecting || (force && behind(r.id, r.snapshot)))) {
          hydration.delete(r.id)
          await hydrateSession(r.id)
        }
      }
      useStore.setState({ serviceConnected: true })
      if (reconnecting) window.dispatchEvent(new Event('patchbay:reconnected'))
    } catch (e) {
      useStore.setState({ serviceConnected: false })
      throw e
    }
  })().finally(() => {
    reconciling = undefined
  })
  return reconciling
}
