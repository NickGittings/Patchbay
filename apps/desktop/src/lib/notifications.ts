import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  isReviewAgentScope,
  sessionMetadata,
  type AutoPauseTarget,
  type AutoRun,
  type NotificationLink,
  type SessionState,
} from '../types'
import { planTerminals } from './plan'
import { autoAttentionItems, recordTask, revealTerminal, sessionOwner } from './attention'
import { autoRuns } from './autoState'
import { finished } from './autoSettings'
import { terminalStatus } from './display'
import { shortTitle } from './tasks'

const KIND_HEALTH = { finished: 'review', needsInput: 'input', failed: 'fail' } as const

export type AgentEvent = { kind: 'finished' | 'needsInput' | 'failed'; atMs: number }
type Snapshot = ReturnType<typeof useStore.getState>
export type NotificationEvent = AgentEvent & {
  sid: string
  owner: string
  label: string
  title: string
  body: string
  toastBody: string
  project?: { id: string; name: string }
  /** Set for an Auto run's pause instead of a session event. */
  auto?: AutoPauseTarget
}
export type NotificationDelivery = {
  title: string
  body: string
  events: NotificationEvent[]
}

/** A new turn can finish in the same state when its working report falls between monitor ticks. */
export function agentEvent(prev: SessionState | undefined, next: SessionState): AgentEvent | null {
  if (!prev || next.disconnected || next.interrupted || next.status?.stopped) return null
  const before = terminalStatus('agent', prev)
  const after = terminalStatus('agent', next)
  if (!after.attention) return null
  const kind = (Object.keys(KIND_HEALTH) as AgentEvent['kind'][]).find(
    (kind) => KIND_HEALTH[kind] === after.health,
  )
  const atMs = after.unseenSince ?? next.status?.agent?.sinceMs ?? 0
  const beforeMs = before.unseenSince ?? prev.status?.agent?.sinceMs ?? 0
  if (before.health === after.health && atMs <= beforeMs) return null
  return kind ? { kind, atMs } : null
}

/** Retained identity wins over edited presets and the currently selected project. */
export function sessionIdentity(s: Snapshot, sid: string) {
  const record = s.sessionRecords.find((r) => r.id === sid)
  const runtime = s.runtimeTerminals[sid]
  const metadata = sessionMetadata.get(sid)
  const projectId = record?.metadata.projectId ?? runtime?.projectId ?? metadata?.projectId
  const componentId = record?.metadata.componentId ?? runtime?.componentId ?? metadata?.componentId
  const terminalId = record?.metadata.terminalId ?? runtime?.terminal.id ?? metadata?.terminalId
  const state = projectStateOf(projectId ?? '', s)
  const component = state?.nodes?.find((n) => n.id === componentId)
  const worktreeTask = record ? recordTask(record, state?.tasks ?? []) : undefined
  const task = record?.metadata.task ?? runtime?.taskId ?? metadata?.task ?? worktreeTask?.id
  const workspace =
    state?.activeTask === (task ?? null) ? state : state?.taskWorkspaces?.[task ?? '']
  const terminal =
    runtime?.terminal ??
    component?.data.terminals.find((t) => t.id === terminalId) ??
    (componentId === TASK_ROOT_SCOPE
      ? workspace?.rootTerminals?.find((t) => t.id === terminalId)
      : componentId === PLAN_SCOPE
        ? planTerminals(s.devices).find((t) => t.id === terminalId)
        : undefined)
  return {
    projectId,
    componentId,
    state,
    task,
    taskTitle:
      record?.metadata.taskTitle ??
      worktreeTask?.title ??
      state?.tasks?.find((t) => t.id === task)?.title,
    projectName:
      record?.metadata.projectName ?? state?.project?.name ?? s.projects[projectId ?? '']?.name,
    terminalName: record?.metadata.name ?? terminal?.name,
    lane: record?.metadata.lane ?? undefined,
    kind:
      record?.metadata.kind ??
      terminal?.kind ??
      (componentId && isReviewAgentScope(componentId) ? 'agent' : undefined),
  }
}

export type NotificationIdentity = ReturnType<typeof sessionIdentity>

/** Whether a link to the session can be followed: its project is open in a tab. */
export function revealable(
  identity: NotificationIdentity,
  s: Snapshot,
): identity is NotificationIdentity & { projectId: string; componentId: string } {
  const { projectId, componentId } = identity
  return !!projectId && !!componentId && !!projectStateOf(projectId, s)?.project
}

/** Every project open in a tab, the active one included. */
function openProjects(s: Snapshot) {
  const ids = new Set(Object.keys(s.projects))
  if (s.project) ids.add(s.project.id)
  return [...ids].flatMap((id) => {
    const state = projectStateOf(id, s)
    return state?.project ? [{ id, state }] : []
  })
}

/** Runs keep their agents while paused or waiting, until they finish, stop or fail. */
function trackingRuns(s: Snapshot, sid: string) {
  return openProjects(s).flatMap(({ state }) =>
    autoRuns(state)
      .map(({ run }) => run)
      .filter(
        (run) =>
          !finished(run.status) &&
          (run.sessionId === sid || !!run.laneSessions?.some((l) => l.sessionId === sid)),
      ),
  )
}

const autoSignature = (run: AutoRun) =>
  [run.runId, run.status, run.stage, run.waitingFor ?? '', run.pauseKind ?? ''].join('|')
const autoSid = (projectId: string, task: string | null) => `auto:${projectId}:${task ?? ''}`

/** The Auto runs of open projects that want the user, from `attention.ts`'s own list. */
export function autoPauses(s: Snapshot) {
  return openProjects(s).flatMap(({ id, state }) =>
    autoAttentionItems(state).map((item) => ({
      sid: autoSid(id, item.task),
      projectName: state.project!.name,
      item,
      target: { projectId: id, task: item.task, signature: autoSignature(item.run) },
    })),
  )
}

/** Whether the Auto pause an alert was for still lasts. */
export function autoPauseCurrent(s: Snapshot, target: AutoPauseTarget) {
  return autoPauses(s).some(
    (p) =>
      p.target.projectId === target.projectId &&
      p.target.task === target.task &&
      p.target.signature === target.signature,
  )
}

/**
 * Whether `event` is still what the session shows: not seen, resolved, restarted, stopped or
 * interrupted since. Checked when an event is queued, when its batch flushes, and for every
 * in-app link that carries its event.
 */
export function isCurrent(s: Snapshot, sid: string, event: AgentEvent) {
  const session = s.sessions[sid]
  if (
    !session ||
    session.interrupted ||
    session.status?.stopped ||
    (session.status?.seenMs ?? 0) >= event.atMs
  )
    return false
  const status = terminalStatus('agent', session)
  return (
    status.attention > 0 &&
    status.health === KIND_HEALTH[event.kind] &&
    (status.unseenSince ?? session.status?.agent?.sinceMs) === event.atMs
  )
}

export function describe(s: Snapshot, sid: string, identity = sessionIdentity(s, sid)) {
  const { componentId, state, task, taskTitle, projectName, terminalName, lane } = identity
  const owner = sessionOwner(componentId, state?.nodes ?? [])
  const worktree = taskTitle ? shortTitle(taskTitle) : task || 'Project folder'
  const agent = s.sessions[sid]?.status?.agent
  const detail = [agent?.message, agent?.prompt].filter(Boolean).join(' — ')
  // Several reviewer lanes, merge agents or planner tabs can share an owner within one batch.
  const terminal = terminalName ?? lane
  return {
    owner,
    label: [owner, terminal !== owner && terminal, worktree].filter(Boolean).join(' · '),
    toastBody: [[worktree, terminalName].filter(Boolean).join(' · '), detail && `“${detail}”`]
      .filter(Boolean)
      .join(' — '),
    body: [
      [worktree, projectName, terminalName].filter(Boolean).join(' · '),
      detail && `“${detail}”`,
    ]
      .filter(Boolean)
      .join(' — '),
  }
}

const TITLES = { finished: 'Agent finished', needsInput: 'Needs input', failed: 'Agent failed' }
let permissionRequest: Promise<boolean> | undefined
let permissionGranted = false

/**
 * At most one permission prompt per webview launch, shared with the settings test button. A grant
 * is remembered, so background batches don't query it again, until a send fails.
 */
export async function notificationPermission(): Promise<boolean> {
  if (permissionGranted) return true
  if (await isPermissionGranted()) return (permissionGranted = true)
  permissionRequest ??= requestPermission()
    .then((p) => p === 'granted')
    .catch(() => false)
  return (permissionGranted = await permissionRequest)
}

/** A failed send may mean the grant was revoked, so the next one asks again. */
export function forgetNotificationPermission() {
  permissionGranted = false
  // A granted prompt would otherwise answer every later ask; a refused one stays at one prompt.
  void permissionRequest?.then((granted) => {
    if (granted) permissionRequest = undefined
  })
}

function smokeLog() {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const smoke = window.__patchbaySmoke
    if (smoke?.stubNotifications) return smoke.notificationLog
  }
  return undefined
}

async function send(delivery: NotificationDelivery) {
  const log = smokeLog()
  if (log) log.push(delivery)
  // The plugin's sendNotification returns void and discards the IPC promise.
  else
    await invoke('plugin:notification|notify', {
      options: { title: delivery.title, body: delivery.body },
    })
}

/** Usage alerts share permission handling, delivery and the debug smoke sink. */
export async function sendUsageNotification(body: string, stillNeeded: () => boolean) {
  try {
    if ((!!smokeLog() || (await notificationPermission())) && stillNeeded())
      await send({ title: 'Subscription usage', body, events: [] })
  } catch {
    forgetNotificationPermission()
  }
}

export type TestNotificationResult =
  | { status: 'granted' }
  | { status: 'denied' }
  /** `granted`: permission was there, but the send itself failed. */
  | { status: 'failed'; error: string; granted: boolean }

export async function sendTestNotification(): Promise<TestNotificationResult> {
  let result: TestNotificationResult
  let granted = false
  try {
    granted = !!smokeLog() || (await notificationPermission())
    if (granted) {
      await send({
        title: 'Patchbay notifications',
        body: 'Agent notifications are ready.',
        events: [],
      })
      return { status: 'granted' }
    }
    result = { status: 'denied' }
  } catch (e) {
    // Permission queries and native delivery can both fail asynchronously.
    forgetNotificationPermission()
    result = { status: 'failed', error: String(e), granted }
  }
  useStore.getState().setNotificationToast({
    message: 'Native notifications are unavailable. Agent alerts will appear here.',
    sessions: [],
  })
  return result
}

/**
 * A notification opens its own project and session (or the Auto panel of its worktree) instead of
 * the active project's menu.
 */
export function revealNotification(sid: string, auto?: AutoPauseTarget) {
  const s = useStore.getState()
  if (auto) {
    if (!projectStateOf(auto.projectId, s)?.project) return false
    if (auto.projectId !== s.project?.id) s.activateProject(auto.projectId)
    revealTerminal({ auto: true, sid, componentId: '@auto', task: auto.task })
    return true
  }
  const identity = sessionIdentity(s, sid)
  if (!revealable(identity, s)) return false
  if (identity.projectId !== s.project?.id) s.activateProject(identity.projectId)
  revealTerminal({ sid, componentId: identity.componentId })
  return true
}

function summarize(events: NotificationEvent[]): NotificationDelivery {
  if (events.length === 1) return { ...events[0], events }
  const sameKind = events.every((e) => e.kind === events[0].kind)
  const title = sameKind
    ? `${events.length} agents ${{ finished: 'finished', needsInput: 'need input', failed: 'failed' }[events[0].kind]}`
    : `${events.length} agent updates`
  return { title, body: events.map((e) => `${e.owner}: ${e.body}`).join('\n'), events }
}

function mainWindowFocused() {
  // Runs only in the main window, so its own document answers without IPC.
  try {
    return typeof document !== 'undefined' && document.hasFocus()
  } catch {
    // Keep native delivery available if focus cannot be read.
    return false
  }
}

function watching(s: Snapshot, projectId: string, task: string | null) {
  return mainWindowFocused() && projectId === s.project?.id && task === s.activeTask
}

/**
 * Installed only by App (the main window), watching every project's retained sessions and Auto
 * runs. Events of sessions whose project isn't open in a tab wait (their links couldn't be
 * followed) and alert once it opens, if still current; an in-app link drops out once its event is
 * no longer current or its project closes.
 */
export function followNotifications() {
  const followerStartedMs = Date.now()
  // Per session and kind, the latest event actually delivered; replays at or below it stay silent.
  const delivered = new Map<string, Partial<Record<AgentEvent['kind'], number>>>()
  // Events of sessions not yet identified or whose project isn't open, rechecked as that changes.
  const deferred = new Map<string, AgentEvent>()
  const pending = new Map<string, NotificationEvent>()
  // A new turn started during a pause belongs to the user, even though the run retains its sid.
  const manualTurns = new Map<string, string>()
  const autoTracked = (s: Snapshot, sid: string) =>
    trackingRuns(s, sid).some(
      (run) => run.status !== 'paused' || manualTurns.get(sid) !== run.runId,
    )
  const rememberManualTurns = (s: Snapshot, prev?: Snapshot) => {
    for (const [sid, session] of Object.entries(s.sessions)) {
      const tracked = trackingRuns(s, sid)
      if (!tracked.some((run) => run.status === 'paused' && run.runId === manualTurns.get(sid)))
        manualTurns.delete(sid)
      const agent = session.status?.agent
      if (!agent || !['working', 'review'].includes(agent.state)) continue
      const before = prev?.sessions[sid]?.status?.agent
      for (const run of tracked) {
        if (run.status !== 'paused') continue
        // A first working report can arrive after Pause while Auto's agent starts up.
        // Require a changed turn identity, or a transition from a reported turn end/input wait
        // for agents without turn ids; a newer timestamp alone does not prove manual activity.
        const afterPause = agent.sinceMs > (run.log.at(-1)?.atMs ?? Infinity)
        const wasPaused =
          prev &&
          trackingRuns(prev, sid).some((p) => p.runId === run.runId && p.status === 'paused')
        const newTurn =
          wasPaused &&
          afterPause &&
          agent.sinceMs > (before?.sinceMs ?? 0) &&
          (before?.turnId && agent.turnId
            ? before.turnId !== agent.turnId || before.conversationId !== agent.conversationId
            : before?.state === 'review' || before?.state === 'needsInput')
        if (newTurn) manualTurns.set(sid, run.runId)
      }
    }
  }
  rememberManualTurns(useStore.getState())
  // The last observed state of each Auto run, so each pause alerts once.
  const autoStates = new Map<string, string>()
  const autoProjects = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let metadataVersion = sessionMetadata.version
  const enabled = (s: Snapshot, e: NotificationEvent) =>
    s.notifications.enabled && s.notifications[e.kind]
  const eligible = (s: Snapshot, e: NotificationEvent) => {
    if (!enabled(s, e)) return false
    if (e.auto)
      return (
        autoPauseCurrent(s, e.auto) &&
        (e.kind === 'failed' || !watching(s, e.auto.projectId, e.auto.task))
      )
    return (
      e.atMs > (delivered.get(e.sid)?.[e.kind] ?? 0) &&
      isCurrent(s, e.sid, e) &&
      !(e.kind === 'finished' && autoTracked(s, e.sid)) &&
      revealable(sessionIdentity(s, e.sid), s)
    )
  }
  const flush = async () => {
    timer = undefined
    const batch = [...pending.values()].filter((e) => eligible(useStore.getState(), e))
    pending.clear()
    if (!batch.length || disposed) return
    let native = false
    if (!mainWindowFocused()) {
      try {
        native = !!smokeLog() || (await notificationPermission())
      } catch {
        /* Toast below. */
      }
    }
    if (disposed) return
    const events = batch.filter((e) => eligible(useStore.getState(), e))
    if (!events.length) return
    for (const e of events)
      if (!e.auto) delivered.set(e.sid, { ...delivered.get(e.sid), [e.kind]: e.atMs })
    const delivery = summarize(events)
    // Keep an in-app copy even after a successful native send: desktop permission APIs
    // cannot detect OS suppression (for example macOS notification settings or Focus).
    useStore.getState().setNotificationToast({
      message: events.map((e) => `${e.title} — ${e.toastBody}`).join('\n'),
      sessions: events.map((e): NotificationLink => ({
        sid: e.sid,
        label: e.label,
        message: `${e.title} — ${e.toastBody}`,
        kind: e.kind,
        atMs: e.atMs,
        project: e.project,
        auto: e.auto,
      })),
    })
    if (native) {
      try {
        await send(delivery)
      } catch {
        // The in-app copy remains available when native IPC rejects; a revoked grant is asked
        // for again next time.
        forgetNotificationPermission()
      }
    }
  }
  const queue = (entry: NotificationEvent) => {
    pending.set(entry.sid, entry)
    timer ??= setTimeout(() => void flush(), 750)
  }

  const consider = (s: Snapshot, sid: string, event: AgentEvent) => {
    deferred.delete(sid)
    if (
      event.atMs <= followerStartedMs ||
      event.atMs <= (delivered.get(sid)?.[event.kind] ?? 0) ||
      !isCurrent(s, sid, event)
    )
      return
    const identity = sessionIdentity(s, sid)
    // Branch jobs can emit live events before their first session-record reconciliation, and a
    // closed project's sessions keep running.
    if (identity.kind && identity.kind !== 'agent') return
    if (!identity.kind || !revealable(identity, s)) {
      deferred.set(sid, event)
      return
    }
    if (event.kind === 'finished' && autoTracked(s, sid)) return
    // Actual terminal visibility is acknowledged through seenMs. An active worktree alone
    // does not mean its terminal is on screen (Review, hidden tabs and collapsed panes).
    const description = describe(s, sid, identity)
    const entry: NotificationEvent = {
      ...event,
      sid,
      ...description,
      title: `${TITLES[event.kind]} — ${description.owner}`,
      project: identity.projectName
        ? { id: identity.projectId, name: identity.projectName }
        : undefined,
    }
    if (enabled(s, entry)) queue(entry)
  }

  /** Queues Auto runs that newly want the user; a project's first sighting only records them. */
  const considerAuto = (s: Snapshot) => {
    const open = openProjects(s)
    for (const id of autoProjects) if (!open.some((p) => p.id === id)) autoProjects.delete(id)
    const pauses = new Map(autoPauses(s).map((p) => [p.sid, p]))
    for (const { id, state } of open) {
      // Restore applies saved Auto runs after their project appears, so everything seen while
      // restoring is a baseline, including worktrees the task list doesn't hold yet.
      const known = autoProjects.has(id) && !s.restoring
      autoProjects.add(id)
      const listed = new Set([null, ...(state.tasks ?? []).map((t) => t.id)])
      for (const { task, run } of autoRuns(state)) {
        // Pauses come from the listed worktrees only; an unlisted one's state is first recorded
        // once it is listed, so a pause it reached meanwhile still alerts.
        if (!s.restoring && !listed.has(task)) continue
        const sid = autoSid(id, task)
        const signature = autoSignature(run)
        if (autoStates.get(sid) === signature) continue
        autoStates.set(sid, signature)
        const pause = pauses.get(sid)
        // An input wait alerts through the session that asks.
        if (!known || !pause || run.waitingFor === 'agentInput') continue
        const { item, target, projectName } = pause
        const worktree = item.taskTitle ? shortTitle(item.taskTitle) : (task ?? 'Project folder')
        const reason =
          run.status !== 'failed' && run.stage === 'mergeGate' ? undefined : item.status.detail
        const entry: NotificationEvent = {
          kind: run.status === 'failed' ? 'failed' : 'needsInput',
          atMs: item.sinceMs,
          sid,
          owner: item.owner,
          label: `${item.owner} · ${worktree}`,
          title:
            run.status === 'failed'
              ? 'Auto mode failed'
              : run.stage === 'mergeGate'
                ? 'Auto mode asks to merge'
                : 'Auto mode is waiting on you',
          body: [[worktree, projectName].join(' · '), reason && `“${reason}”`]
            .filter(Boolean)
            .join(' — '),
          toastBody: [worktree, reason && `“${reason}”`].filter(Boolean).join(' — '),
          project: { id, name: projectName },
          auto: target,
        }
        if (enabled(s, entry)) queue(entry)
      }
    }
  }
  considerAuto(useStore.getState())

  const prune = (s: Snapshot) => {
    const stale = (s.notificationToast?.sessions ?? []).filter(({ sid, kind, atMs, auto }) =>
      auto
        ? !autoPauseCurrent(s, auto)
        : kind &&
          atMs !== undefined &&
          (!isCurrent(s, sid, { kind, atMs }) || !revealable(sessionIdentity(s, sid), s)),
    )
    for (const { sid } of stale) useStore.getState().dismissNotificationSession(sid)
  }

  const unsubscribe = useStore.subscribe((s, prev) => {
    if (
      s.sessions !== prev.sessions ||
      s.auto !== prev.auto ||
      s.projects !== prev.projects ||
      s.taskWorkspaces !== prev.taskWorkspaces
    )
      rememberManualTurns(s, prev)
    const handled = new Set<string>()
    if (s.sessions !== prev.sessions) {
      for (const sid of new Set([...delivered.keys(), ...deferred.keys()])) {
        if (!s.sessions[sid]) {
          delivered.delete(sid)
          manualTurns.delete(sid)
          deferred.delete(sid)
          pending.delete(sid)
        }
      }
      for (const [sid, session] of Object.entries(s.sessions)) {
        if (session === prev.sessions[sid]) continue
        const event = agentEvent(prev.sessions[sid], session) ?? deferred.get(sid)
        if (!event) continue
        handled.add(sid)
        consider(s, sid, event)
      }
    }
    // Identity and reachability arrive with records, runtime terminals, the shared metadata map
    // or project maps and tabs.
    const identitiesChanged =
      s.sessions !== prev.sessions ||
      s.sessionRecords !== prev.sessionRecords ||
      s.runtimeTerminals !== prev.runtimeTerminals ||
      s.projects !== prev.projects ||
      s.nodes !== prev.nodes ||
      sessionMetadata.version !== metadataVersion
    metadataVersion = sessionMetadata.version
    if (deferred.size && identitiesChanged)
      for (const [sid, event] of [...deferred]) if (!handled.has(sid)) consider(s, sid, event)
    const autoChanged =
      s.auto !== prev.auto ||
      s.taskWorkspaces !== prev.taskWorkspaces ||
      s.tasks !== prev.tasks ||
      s.projects !== prev.projects ||
      s.project !== prev.project ||
      s.restoring !== prev.restoring
    if (autoChanged) considerAuto(s)
    if (
      s.notificationToast?.sessions.length &&
      (s.sessions !== prev.sessions ||
        s.projects !== prev.projects ||
        s.sessionRecords !== prev.sessionRecords ||
        s.notificationToast !== prev.notificationToast ||
        // Auto links follow their runs.
        s.auto !== prev.auto ||
        s.taskWorkspaces !== prev.taskWorkspaces)
    )
      prune(s)
  })
  return () => {
    disposed = true
    unsubscribe()
    clearTimeout(timer)
    pending.clear()
    deferred.clear()
  }
}
