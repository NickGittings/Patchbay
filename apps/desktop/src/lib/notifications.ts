import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { projectStateOf, useStore } from '../store'
import {
  DEFAULT_NOTIFICATIONS,
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  isReviewAgentScope,
  sessionMetadata,
  type NotificationLink,
  type NotificationSettings,
  type SessionState,
} from '../types'
import { planTerminals } from './plan'
import { recordTask, revealTerminal, sessionOwner } from './attention'
import { terminalStatus } from './display'

const KIND_HEALTH = { finished: 'review', needsInput: 'input', failed: 'fail' } as const

export type AgentEvent = { kind: 'finished' | 'needsInput' | 'failed'; atMs: number }
type Snapshot = ReturnType<typeof useStore.getState>
export type NotificationEvent = AgentEvent & {
  sid: string
  owner: string
  label: string
  title: string
  body: string
  project?: { id: string; name: string }
}
export type NotificationDelivery = {
  title: string
  body: string
  events: NotificationEvent[]
}

export function restoredNotifications(value: unknown): NotificationSettings {
  const settings = { ...DEFAULT_NOTIFICATIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return settings
  for (const key of Object.keys(settings) as (keyof NotificationSettings)[]) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field === 'boolean') settings[key] = field
  }
  return settings
}

export const sameNotifications = (a: NotificationSettings, b: NotificationSettings) =>
  (Object.keys(DEFAULT_NOTIFICATIONS) as (keyof NotificationSettings)[]).every(
    (key) => a[key] === b[key],
  )

/**
 * Restored settings, keeping each field the user changed while the workspace was restoring
 * (`current` differs from the `initial` value the store started with).
 */
export function mergeRestoredNotifications(
  saved: unknown,
  current: NotificationSettings,
  initial: NotificationSettings,
): NotificationSettings {
  if (current === initial) return restoredNotifications(saved)
  const settings = restoredNotifications(saved)
  for (const key of Object.keys(settings) as (keyof NotificationSettings)[])
    if (current[key] !== initial[key]) settings[key] = current[key]
  return settings
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

export type SessionIdentity = ReturnType<typeof sessionIdentity>

export const sessionKind = (s: Snapshot, sid: string) => sessionIdentity(s, sid).kind

/** Whether a link to the session can be followed: its project is open in a tab. */
export function revealable({ projectId, componentId }: SessionIdentity, s: Snapshot) {
  return !!projectId && !!componentId && !!projectStateOf(projectId, s)?.project
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
  const worktree = taskTitle || (task ? task : 'Project folder')
  const agent = s.sessions[sid]?.status?.agent
  const detail = [agent?.message, agent?.prompt].filter(Boolean).join(' — ')
  // Several reviewer lanes, merge agents or planner tabs can share an owner within one batch.
  const terminal = terminalName ?? lane
  return {
    owner,
    label: [owner, terminal !== owner && terminal, worktree].filter(Boolean).join(' · '),
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

/** At most one permission prompt per webview launch, shared with the settings test button. */
export async function notificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true
  permissionRequest ??= requestPermission()
    .then((p) => p === 'granted')
    .catch(() => false)
  return permissionRequest
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

export async function sendTestNotification() {
  try {
    if (!!smokeLog() || (await notificationPermission())) {
      await send({
        title: 'Patchbay notifications',
        body: 'Agent notifications are ready.',
        events: [],
      })
      return true
    }
  } catch {
    // Permission queries and native delivery can both fail asynchronously.
  }
  useStore.getState().setNotificationToast({
    message: 'Native notifications are unavailable. Agent alerts will appear here.',
    sessions: [],
  })
  return false
}

/** A notification opens its own project and session instead of the active project's menu. */
export function revealNotification(sid: string) {
  const s = useStore.getState()
  const identity = sessionIdentity(s, sid)
  const { projectId, componentId } = identity
  if (!revealable(identity, s) || !projectId || !componentId) return false
  if (projectId !== s.project?.id) s.activateProject(projectId)
  revealTerminal({ sid, componentId })
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

/**
 * Installed only by App (the main window), watching every project's retained sessions. Sessions
 * of projects that aren't open in a tab don't alert, since their links couldn't be followed; an
 * in-app link drops out once its event is no longer current or its project closes.
 */
export function followNotifications() {
  const followerStartedMs = Date.now()
  const delivered = new Map<string, Partial<Record<AgentEvent['kind'], number>>>()
  const unidentified = new Map<string, AgentEvent>()
  const pending = new Map<string, NotificationEvent>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let metadataSize = sessionMetadata.size
  const enabled = (s: Snapshot, e: NotificationEvent) =>
    s.notifications.enabled && s.notifications[e.kind]
  const eligible = (s: Snapshot, e: NotificationEvent) =>
    enabled(s, e) && delivered.get(e.sid)?.[e.kind] === e.atMs && isCurrent(s, e.sid, e)
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
    const delivery = summarize(events)
    // Keep an in-app copy even after a successful native send: desktop permission APIs
    // cannot detect OS suppression (for example macOS notification settings or Focus).
    useStore.getState().setNotificationToast({
      message: `${delivery.title} — ${delivery.body}`,
      sessions: events.map((e): NotificationLink => ({
        sid: e.sid,
        label: e.label,
        message: `${e.title} — ${e.body}`,
        kind: e.kind,
        atMs: e.atMs,
        project: e.project,
      })),
    })
    if (native) {
      try {
        await send(delivery)
      } catch {
        // The in-app copy remains available when native IPC rejects.
      }
    }
  }

  const consider = (s: Snapshot, sid: string, event: AgentEvent) => {
    unidentified.delete(sid)
    if (event.atMs <= followerStartedMs || !isCurrent(s, sid, event)) return
    const identity = sessionIdentity(s, sid)
    if (!identity.kind) {
      // Branch jobs can emit live events before their first session-record reconciliation.
      unidentified.set(sid, event)
      return
    }
    if (identity.kind !== 'agent' || event.atMs <= (delivered.get(sid)?.[event.kind] ?? 0)) return
    delivered.set(sid, { ...delivered.get(sid), [event.kind]: event.atMs })
    if (!revealable(identity, s)) return
    const description = describe(s, sid, identity)
    const entry: NotificationEvent = {
      ...event,
      sid,
      ...description,
      title: `${TITLES[event.kind]} — ${description.owner}`,
      project: identity.projectName
        ? { id: identity.projectId!, name: identity.projectName }
        : undefined,
    }
    if (!enabled(s, entry)) return
    pending.set(sid, entry)
    timer ??= setTimeout(() => void flush(), 750)
  }

  const prune = (s: Snapshot) => {
    const stale = (s.notificationToast?.sessions ?? []).filter(
      ({ sid, kind, atMs }) =>
        kind &&
        atMs !== undefined &&
        (!isCurrent(s, sid, { kind, atMs }) || !revealable(sessionIdentity(s, sid), s)),
    )
    for (const { sid } of stale) useStore.getState().dismissNotificationSession(sid)
  }

  const unsubscribe = useStore.subscribe((s, prev) => {
    const handled = new Set<string>()
    if (s.sessions !== prev.sessions) {
      for (const sid of new Set([...delivered.keys(), ...unidentified.keys()])) {
        if (!s.sessions[sid]) {
          delivered.delete(sid)
          unidentified.delete(sid)
          pending.delete(sid)
        }
      }
      for (const [sid, session] of Object.entries(s.sessions)) {
        if (session === prev.sessions[sid]) continue
        const event = agentEvent(prev.sessions[sid], session) ?? unidentified.get(sid)
        if (!event) continue
        handled.add(sid)
        consider(s, sid, event)
      }
    }
    // Identity arrives with records, runtime terminals, the shared metadata map or project maps.
    const identitiesChanged =
      s.sessions !== prev.sessions ||
      s.sessionRecords !== prev.sessionRecords ||
      s.runtimeTerminals !== prev.runtimeTerminals ||
      s.projects !== prev.projects ||
      s.nodes !== prev.nodes ||
      sessionMetadata.size !== metadataSize
    metadataSize = sessionMetadata.size
    if (unidentified.size && identitiesChanged)
      for (const [sid, event] of [...unidentified]) if (!handled.has(sid)) consider(s, sid, event)
    if (
      s.notificationToast?.sessions.length &&
      (identitiesChanged ||
        s.notificationToast !== prev.notificationToast ||
        s.project !== prev.project)
    )
      prune(s)
  })
  return () => {
    disposed = true
    unsubscribe()
    clearTimeout(timer)
    pending.clear()
    unidentified.clear()
  }
}
