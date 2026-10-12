import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { releaseMapEdit, sessionForget, sessionsList, terminalCloseGuard } from './ipc'
import { executeExtensionCommand } from '../extensions/host'
import { extensionTerminalRun } from './ipc'
import { emptyTaskWorkspace, projectOf, projectStateOf, useStore } from '../store'
import { showsSession } from './windows'
import {
  PLAN_SCOPE,
  showsInDock,
  isReservedScope,
  TASK_ROOT_SCOPE,
  type Project,
  type RuntimeTerminal,
  type SessionRecord,
  type SessionState,
  sessionMetadata,
  sessionId,
  type TerminalEvent,
  type TerminalSnapshot,
} from '../types'
import {
  onTerminalEvent,
  taskRootStart,
  planStart,
  terminalSnapshot,
  terminalStart,
  terminalStop,
  serviceRetire,
} from './ipc'
import { peersFor, planTerminals } from './plan'
import { savePlanDraft } from './planDrafts'
import { requestGitRefresh } from './git'
import {
  disposeAll,
  markOutputGeneration,
  replayOutput,
  restoreModes,
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
const restarting = new Map<string, Promise<void>>()
const closing = new Set<string>()
const terminalKey = (projectId: string, componentId: string, terminalId: string) =>
  JSON.stringify([projectId, componentId, terminalId])
const isClosing = (launch: Launch) =>
  closing.has(terminalKey(launch.projectId, launch.componentId, launch.terminalId))
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
  restarting.clear()
  closing.clear()
  disposeAll()
}

const decodeBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

interface ServiceRetirement {
  state: 'idle' | 'stopping' | 'reconnecting'
  error?: string | null
}
function applyRetirement(retirement: ServiceRetirement) {
  const current = useStore.getState()
  // A status request made before the click can arrive after it. Only a failure
  // or completed reconciliation can enable another stop while disconnected.
  if (
    retirement.state === 'idle' &&
    !retirement.error &&
    current.serviceRetirement !== 'idle' &&
    !current.serviceConnected
  )
    return
  useStore.setState({
    serviceRetirement: retirement.state,
    serviceRetirementError: retirement.error ?? undefined,
  })
}

/** Shared in this window; the backend also deduplicates calls across webviews. */
export async function retireOlderService(): Promise<void> {
  if (useStore.getState().serviceRetirement !== 'idle') return
  applyRetirement({ state: 'stopping' })
  try {
    await serviceRetire()
    // An event or reconciliation may already have observed the new service.
    if (!useStore.getState().serviceConnected) applyRetirement({ state: 'reconnecting' })
  } catch (e) {
    applyRetirement({ state: 'idle', error: String(e) })
  }
}

/** Each webview keeps one listener for its lifetime, including React StrictMode remounts. */
export function listenForTerminals() {
  listening ??= Promise.all([
    onTerminalEvent(handleTerminalEvent),
    listen<ServiceRetirement>('patchbay://service-retirement', (e) => applyRetirement(e.payload)),
    listen<{ connected: boolean; instanceId?: string; error?: string }>(
      'patchbay://service',
      (e) => {
        if (!e.payload.connected)
          useStore.setState({ serviceConnected: false, serviceError: e.payload.error })
        else void reconcileSessions().catch(() => {})
      },
    ),
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
  rootTerminal?: import('../types').TerminalSpec
  runtime?: RuntimeTerminal
  implementPlan?: boolean
  restart?: boolean
}

/**
 * `task` defaults to the project's active task; `null` is the project's own worktree. Planners
 * always run in the project's own worktree.
 */
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
  const state = projectStateOf(id, s)
  // The planner belongs to the project, whatever the worktree, and plans what is highlighted now.
  const planner = componentId === PLAN_SCOPE
  const scope = planner ? null : task === undefined ? (state?.activeTask ?? null) : task
  const workspace =
    planner || state?.activeTask === scope
      ? state
      : (state?.taskWorkspaces[scope ?? ''] ??
        emptyTaskWorkspace(state?.tasks.find((t) => t.id === scope)?.components))
  const sid = sessionId(componentId, terminalId, scope, id)
  return {
    sid,
    componentId,
    terminalId,
    projectId: id,
    task: scope,
    project,
    // Saved task layouts can name components removed from the map since; the backend rejects those.
    highlighted: (workspace?.highlighted ?? []).filter((c) =>
      project.components.some((n) => n.id === c),
    ),
    rootTerminal:
      componentId === TASK_ROOT_SCOPE
        ? workspace?.rootTerminals.find((t) => t.id === terminalId)
        : undefined,
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
  implementPlan = false,
): Promise<void> {
  let launch: Launch
  try {
    launch = captureLaunch(componentId, terminalId, task, projectId)
    launch.implementPlan = implementPlan
  } catch (e) {
    useStore.getState().setMessage(String(e))
    if (implementPlan) return Promise.reject(e)
    return Promise.resolve()
  }
  return launchTerminal(launch)
}

function launchTerminal(launch: Launch): Promise<void> {
  const { sid, componentId, terminalId, project, runtime } = launch
  if (isClosing(launch)) return Promise.resolve()
  const task = launch.task ?? undefined
  const existing = starting.get(sid)
  if (existing) return existing
  // A retry reuses its request ID so a lost reply can't launch twice; Restart follows a stop,
  // so an earlier request is spent and would be answered as a duplicate without relaunching.
  const requestId = (!launch.restart && launchRequests.get(sid)) || crypto.randomUUID()
  launchRequests.set(sid, requestId)
  const request = (async () => {
    const requestedEpoch = epoch
    try {
      await listenForTerminals()
      if (requestedEpoch !== epoch || isClosing(launch)) return
      if (
        !isReservedScope(componentId) &&
        !runtime &&
        !projectOf(launch.projectId)?.components.some(
          (c) => c.id === componentId && c.terminals.some((t) => t.id === terminalId),
        )
      )
        return
      if (!useStore.getState().serviceConnected)
        throw new Error('Disconnected; reconnect before starting work')
      const terminal =
        launch.rootTerminal ??
        runtime?.terminal ??
        project.components
          .find((c) => c.id === componentId)
          ?.terminals.find((t) => t.id === terminalId)
      if (componentId !== PLAN_SCOPE && terminal?.kind === 'agent')
        await savePlanDraft(launch.projectId, launch.task)
      const resume = !!launch.restart && terminal?.kind === 'agent' && !runtime
      if (componentId === TASK_ROOT_SCOPE) {
        if (!launch.rootTerminal) throw new Error(`Unknown root terminal ${terminalId}`)
        await taskRootStart(
          project,
          launch.highlighted,
          launch.rootTerminal,
          task,
          requestId,
          launch.implementPlan,
          resume,
        )
      } else if (runtime?.commandId)
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
        await planStart(project, ids, terminal, requestId, !!launch.restart)
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
          resume,
        )
      }
      launchRequests.delete(sid)
    } catch (e) {
      // Another window may have auto-started the same shell in the meantime.
      const snapshot = await terminalSnapshot(sid).catch(() => null)
      if (snapshot?.running) launchRequests.delete(sid)
      if (requestedEpoch === epoch && !snapshot?.running) {
        useStore.getState().setMessage(String(e))
        if (launch.implementPlan) throw e
      }
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

/**
 * Take a terminal out of the active task. A root or retained terminal is also stopped and its
 * service record forgotten, or the next reconcile would bring it back as a retained tile; a saved
 * component terminal just stops and stays on the map.
 */
export async function removeTaskTerminal(componentId: string, terminalId: string, sid: string) {
  const s = useStore.getState()
  const saved = s.nodes.some(
    (n) => n.id === componentId && n.data.terminals.some((t) => t.id === terminalId),
  )
  s.removeTaskTerminal(componentId, terminalId)
  useStore.setState((state) => {
    if (!state.runtimeTerminals[sid]) return {}
    const runtimeTerminals = { ...state.runtimeTerminals }
    delete runtimeTerminals[sid]
    return { runtimeTerminals }
  })
  try {
    if (useStore.getState().sessions[sid]?.running) await terminalStop(sid)
    if (saved) return
    const deadline = Date.now() + 10000
    while ((await terminalSnapshot(sid))?.running) {
      if (Date.now() >= deadline) throw new Error('Terminal is still stopping; remove it again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (sessionMetadata.has(sid)) await sessionForget(sid)
  } catch (e) {
    useStore.getState().setMessage(String(e))
  }
}

/** Stop every worktree copy, including launches still waiting for a started event. */
export async function closeTerminal(componentId: string, terminalId: string) {
  const projectId = useStore.getState().project?.id
  if (!projectId) return false
  const key = terminalKey(projectId, componentId, terminalId)
  if (closing.has(key)) return false
  closing.add(key)
  const requestedEpoch = epoch
  let lease: string | undefined
  const matches = (sid: string) => {
    const identity = sessionMetadata.get(sid)
    return (
      identity?.projectId === projectId &&
      identity.componentId === componentId &&
      identity.terminalId === terminalId
    )
  }
  try {
    await Promise.all(
      [...starting, ...restarting].filter(([sid]) => matches(sid)).map(([, request]) => request),
    )
    if (requestedEpoch !== epoch) return false
    lease = await terminalCloseGuard(projectId, componentId, terminalId)
    if (requestedEpoch !== epoch) return false
    const records = await sessionsList()
    const sids = new Set([...sessionMetadata.keys()].filter(matches))
    for (const record of records) {
      const m = record.metadata
      if (m.projectId === projectId && m.componentId === componentId && m.terminalId === terminalId)
        sids.add(record.id)
    }
    await Promise.all([...sids].map((sid) => terminalStop(sid)))
    const deadline = Date.now() + 10000
    while (
      (await Promise.all([...sids].map((sid) => terminalSnapshot(sid)))).some(
        (snapshot) => snapshot?.running,
      )
    ) {
      if (requestedEpoch !== epoch) return false
      if (Date.now() >= deadline) throw new Error('Terminal is still stopping. Try Close again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (requestedEpoch !== epoch) return false
    useStore.getState().removeTerminal(componentId, terminalId, projectId)
    return true
  } catch (e) {
    if (requestedEpoch === epoch) useStore.getState().setMessage(String(e))
    return false
  } finally {
    if (lease)
      await releaseMapEdit(projectId, lease).catch((e) => useStore.getState().setMessage(String(e)))
    if (requestedEpoch === epoch) closing.delete(key)
  }
}

/** Keep restarts tracked across their stop/wait/start gap so removal can join them. */
export function restartTerminal(
  componentId: string,
  terminalId: string,
  task?: string | null,
): Promise<void> {
  const requestedEpoch = epoch
  let launch: Launch
  try {
    launch = captureLaunch(componentId, terminalId, task)
  } catch (e) {
    useStore.getState().setMessage(String(e))
    return Promise.resolve()
  }
  if (isClosing(launch)) return Promise.resolve()
  const existing = restarting.get(launch.sid)
  if (existing) return existing
  const request = (async () => {
    try {
      await starting.get(launch.sid)
      if (requestedEpoch !== epoch || isClosing(launch)) return
      await terminalStop(launch.sid)
      const deadline = Date.now() + 10000
      while ((await terminalSnapshot(launch.sid))?.running) {
        if (requestedEpoch !== epoch || isClosing(launch)) return
        if (Date.now() >= deadline)
          throw new Error('Terminal is still stopping. Try Restart again.')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      launch.restart = true
      if (requestedEpoch === epoch && !isClosing(launch)) await launchTerminal(launch)
    } catch (e) {
      if (requestedEpoch === epoch) useStore.getState().setMessage(String(e))
    }
  })().finally(() => {
    if (restarting.get(launch.sid) === request) restarting.delete(launch.sid)
  })
  restarting.set(launch.sid, request)
  return request
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
      restoreModes(e.sessionId)
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
      restoreModes(e.sessionId)
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
      if (snapshot && (await applySnapshot(sid, snapshot))) {
        // A run that ended (or was killed) mid-TUI must not leave this window's xterm in its modes.
        if (!snapshot.running) restoreModes(sid)
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
async function applySnapshot(sid: string, snapshot: TerminalSnapshot): Promise<boolean> {
  let bytes = decodeBase64(snapshot.data)
  const start = snapshot.end - bytes.length
  const cursor = lastSeq.get(sid)
  if (cursor && cursor.generation > snapshot.generation) return false
  if (cursor?.complete && cursor.generation === snapshot.generation && cursor.end >= start) {
    const from = cursor.end - start
    if (from < bytes.length) replayOutput(sid, bytes.subarray(from))
    cursor.end = Math.max(cursor.end, snapshot.end)
    return true
  }
  // A truncated backlog can begin mid escape sequence or character; start at a line.
  if (start > 0) bytes = bytes.subarray(bytes.indexOf(0x0a) + 1)
  await restoreOutput(sid, bytes, snapshot.generation)
  lastSeq.set(sid, { generation: snapshot.generation, end: snapshot.end, complete: start === 0 })
  return true
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
/** Wait out any pre-launch list, then read records fetched after the launch completed. */
export async function reconcileFreshSessions(): Promise<void> {
  if (reconciling) await reconciling
  await reconcileSessions()
}

export function reconcileSessions(force = true): Promise<void> {
  reconciling ??= (async () => {
    try {
      const status = await invoke<{
        connected: boolean
        instanceId: string
        retirement?: ServiceRetirement
      }>('service_status')
      if (status.retirement) applyRetirement(status.retirement)
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
        const state = projects[r.metadata.projectId]?.state
        const root =
          r.metadata.componentId === TASK_ROOT_SCOPE &&
          (state?.activeTask === (r.metadata.task ?? null)
            ? state.rootTerminals
            : state?.taskWorkspaces[r.metadata.task ?? '']?.rootTerminals
          )?.some((t) => t.id === r.metadata.terminalId)
        const mapped = onMap(r) || root
        if (
          (mapped || !showsInDock(r.metadata.componentId)) &&
          useStore.getState().runtimeTerminals[r.id]
        )
          useStore.setState((s) => {
            const runtimeTerminals = { ...s.runtimeTerminals }
            delete runtimeTerminals[r.id]
            return { runtimeTerminals }
          })
        if (
          showsInDock(r.metadata.componentId) &&
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
      useStore.setState({
        serviceConnected: true,
        serviceError: undefined,
        serviceRetirement: 'idle',
        serviceRetirementError: undefined,
      })
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
