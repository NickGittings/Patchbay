import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import * as ipc from '../lib/ipc'
import { projectFrom, useStore } from '../store'
import type { Component, ContextSection, Extension, ExtensionBadge, Project } from '../types'
import { serveContextRequests, setContextCollector } from './context'

const TIMEOUT = 10000
/** Commands may legitimately wait on slow tools (docker, builds). */
const COMMAND_TIMEOUT = 60000
/** API calls such as `terminals.run` poll for up to 8s after spawning. */
const API_TIMEOUT = 30000
/** Consecutive request timeouts before an unresponsive host is stopped. */
const MAX_TIMEOUTS = 3
/** Distinct `terminals.run` sessions one extension may keep. */
const MAX_RUN_TERMINALS = 8
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface Runtime {
  projectId: string
  taskId: string | null
  renderedViews: Map<string, string>
  project: Project | null
  extension: Extension
  frame: HTMLIFrameElement
  ready: Promise<void>
  isReady: boolean
  resolveReady: () => void
  rejectReady: (error: Error) => void
  pending: Map<number, Pending>
  commands: Set<string>
  providers: Set<string>
  views: Set<string>
  inflight: number
  timeouts: number
  calls: number
  period: number
  disposed: boolean
}
const runtimeKey = (projectId: string, taskId: string | null, id: string) =>
  JSON.stringify([projectId, taskId, id])
const isCurrent = (runtime: Runtime) => {
  const s = useStore.getState()
  return s.activeProjectId === runtime.projectId && s.activeTask === runtime.taskId
}
const runtimes = new Map<string, Runtime>()
const quarantined = new Set<string>()
const viewFrames = new Map<string, HTMLIFrameElement>()
let next = 0
let epoch = 0
let stopping: Promise<void> = Promise.resolve()
let badgeTimer: ReturnType<typeof setTimeout> | undefined
let badgeEpoch = 0
let notifyTimer: ReturnType<typeof setTimeout> | undefined
let lastProjectKey = ''
let lastSelection = ''
let installed = false
const error = (e: unknown) => useStore.getState().setMessage(String(e))
class Timeout extends Error {}
const active = () =>
  useStore.getState().extensions.extensions.filter((e) => e.enabled && !e.errors.length)
const ownerOfCommand = (id: string) =>
  active().find((e) => e.manifest.contributes.commands.some((c) => c.id === id))
const send = (runtime: Runtime, message: Record<string, unknown>) =>
  runtime.frame.contentWindow?.postMessage({ patchbay: 1, ...message }, '*')
function permission(runtime: Runtime, name: string) {
  if (!runtime.extension.manifest.permissions.includes(name))
    throw new Error(`Permission ${name} is required`)
}
/** One slow call isn't a fault; a host that keeps not answering is. */
function strike(runtime: Runtime) {
  if (++runtime.timeouts >= MAX_TIMEOUTS) {
    error(`${runtime.extension.id} stopped responding`)
    shutdown(runtime)
  }
}
/** Call into the host; `strikes: false` leaves counting a timeout to the caller. */
function request(
  runtime: Runtime,
  target: string,
  key: string,
  args: unknown[],
  timeout = TIMEOUT,
  strikes = true,
): Promise<unknown> {
  if (runtime.disposed) return Promise.reject(new Error('Extension stopped'))
  return new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      runtime.pending.delete(id)
      reject(new Timeout(`${runtime.extension.id}: ${target} timed out`))
      if (strikes) strike(runtime)
    }, timeout)
    runtime.pending.set(id, { resolve, reject, timer })
    send(runtime, { method: 'call', id, target, key, args })
  })
}
function shutdown(runtime: Runtime, failed = true) {
  if (runtime.disposed) return
  runtime.disposed = true
  if (failed) quarantined.add(runtime.extension.id)
  runtime.rejectReady(new Error('Extension stopped'))
  runtime.frame.remove()
  const key = runtimeKey(runtime.projectId, runtime.taskId, runtime.extension.id)
  // A retired runtime may already have been replaced under its key.
  if (runtimes.get(key) === runtime) runtimes.delete(key)
  for (const pending of runtime.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Extension stopped'))
  }
  runtime.pending.clear()
  for (const view of runtime.views) {
    setRuntimeView(runtime, view, '')
    if (isCurrent(runtime)) viewFrames.delete(view)
  }
  scheduleBadges()
}
/** Give deactivate a bounded chance to finish before removing the runtime's frame. */
async function deactivate(runtime: Runtime) {
  const id = ++next
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500)
    runtime.pending.set(id, {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: () => resolve(),
      timer,
    })
    send(runtime, { method: 'deactivate', id })
  })
  shutdown(runtime, false)
}
async function deactivateAll() {
  epoch++
  clearTimeout(badgeTimer)
  useStore.getState().setExtensionBadges({})
  await Promise.all([...runtimes.values()].map(deactivate))
  quarantined.clear()
}
/** Stop runtimes for a task their project has switched away from, or a project now closed. */
function retireStale() {
  if (!runtimes.size) return
  const projects = useStore.getState().captureProjects()
  for (const runtime of runtimes.values()) {
    const entry = projects[runtime.projectId]
    // Startup activations belong to no project.
    if (!runtime.projectId || runtime.disposed) continue
    if (entry && (!entry.state || entry.state.activeTask === runtime.taskId)) continue
    // Mark it gone now, so a reactivation for the same key starts a fresh frame.
    runtimes.delete(runtimeKey(runtime.projectId, runtime.taskId, runtime.extension.id))
    void deactivate(runtime)
  }
}
function notify(runtime: Runtime, events = { project: true, selection: true }) {
  if (!runtime.extension.manifest.permissions.includes('project:read')) return
  const s = useStore.getState()
  if (!isCurrent(runtime)) return
  const project = s.project ? s.toProject() : null
  runtime.project = project
  if (events.project) send(runtime, { method: 'event', event: 'project', value: project })
  if (events.selection)
    send(runtime, {
      method: 'event',
      event: 'selection',
      value: project?.components.find((c) => c.id === s.selectedId) ?? null,
    })
}
/** The project as extensions see it, minus canvas positions, which change on every drag step. */
function projectKey(project: Project | null) {
  return JSON.stringify(
    project && { ...project, components: project.components.map(withoutPosition) },
  )
}
function withoutPosition(component: Component) {
  return { ...component, position: undefined }
}
/** Tell running hosts about map or selection edits, coalesced and only when they changed. */
function scheduleNotify() {
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    const s = useStore.getState()
    const project = s.project ? s.toProject() : null
    const key = JSON.stringify([projectKey(project), s.activeTask])
    const selected = project?.components.find((c) => c.id === s.selectedId)
    const selection = JSON.stringify(selected ? withoutPosition(selected) : null)
    const events = { project: key !== lastProjectKey, selection: selection !== lastSelection }
    lastProjectKey = key
    lastSelection = selection
    if (!events.project && !events.selection) return
    for (const runtime of runtimes.values()) notify(runtime, events)
    if (events.project) scheduleBadges()
  }, 150)
}
export async function activateExtension(
  extension: Extension,
  project = useStore.getState().project ? useStore.getState().toProject() : null,
  taskId = useStore.getState().captureProjects()[project?.projectId ?? '']?.state?.activeTask ??
    null,
): Promise<Runtime | undefined> {
  if (!extension.manifest.main || !installed) return undefined
  await stopping
  if (quarantined.has(extension.id))
    throw new Error(`${extension.id} stopped; reload extensions to retry`)
  const projectId = project?.projectId ?? ''
  const key = runtimeKey(projectId, taskId, extension.id)
  const existing = runtimes.get(key)
  if (existing) {
    await existing.ready
    notify(existing)
    for (const [view, html] of existing.renderedViews) setRuntimeView(existing, view, html)
    return existing
  }
  if (!active().some((e) => e === extension)) return undefined
  const frame = document.createElement('iframe')
  frame.sandbox.add('allow-scripts')
  frame.hidden = true
  frame.dataset.extensionHost = extension.id
  frame.src = `${convertFileSrc('', 'patchbay-ext')}${extension.id}/__bootstrap.html`
  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const runtime: Runtime = {
    projectId,
    taskId,
    renderedViews: new Map(),
    project,
    extension,
    frame,
    ready,
    isReady: false,
    resolveReady,
    rejectReady,
    pending: new Map(),
    commands: new Set(),
    providers: new Set(),
    views: new Set(),
    inflight: 0,
    timeouts: 0,
    calls: 0,
    period: Date.now(),
    disposed: false,
  }
  runtimes.set(key, runtime)
  // The frame loads its bootstrap once; another load means it navigated away, and the page
  // it now shows must not inherit this extension's API access.
  let loads = 0
  frame.addEventListener('load', () => {
    if (++loads > 1 && !runtime.disposed) {
      error(`${extension.id}: extension frame navigated away`)
      shutdown(runtime)
    }
  })
  const timer = setTimeout(() => {
    rejectReady(new Error(`${extension.id}: activation timed out`))
    shutdown(runtime)
  }, TIMEOUT)
  document.body.append(frame)
  try {
    await ready
    runtime.isReady = true
    notify(runtime)
    scheduleBadges()
    return runtime
  } catch (e) {
    shutdown(runtime)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
async function activationEvent(
  event: string,
  project = useStore.getState().project ? useStore.getState().toProject() : null,
) {
  const current = epoch
  for (const extension of active()) {
    if (current !== epoch) return
    if (extension.manifest.activationEvents.includes(event))
      await activateExtension(extension, project).catch(error)
  }
}
async function projectActivation() {
  await stopping
  if (!useStore.getState().project) return
  const project = useStore.getState().toProject()
  await activationEvent('onStartup', project)
  await activationEvent('onProjectOpen', project)
  scheduleBadges()
  const current = epoch
  for (const extension of active())
    for (const event of extension.manifest.activationEvents) {
      if (current !== epoch) return
      const file = event.startsWith('workspaceContains:') ? event.slice(18) : null
      if (!file) continue
      const slash = file.lastIndexOf('/')
      const folder = slash < 0 ? '.' : file.slice(0, slash)
      const name = file.slice(slash + 1)
      const files = await ipc.listDir(folder, project.projectId).catch(() => [])
      if (files.some((f) => f.name === name && !f.isDir))
        await activateExtension(extension, project).catch(error)
    }
}
export async function executeExtensionCommand(
  id: string,
  args: unknown[] = [],
  componentId = useStore.getState().selectedId,
  project = useStore.getState().project ? useStore.getState().toProject() : null,
  taskId = useStore.getState().captureProjects()[project?.projectId ?? '']?.state?.activeTask ??
    null,
): Promise<unknown> {
  const extension = ownerOfCommand(id)
  const command = extension?.manifest.contributes.commands.find((c) => c.id === id)
  if (!extension || !command) throw new Error(`Unknown command ${id}`)
  const s = useStore.getState()
  if (command.run) {
    if (!componentId || !project) throw new Error('Select a component first')
    const sid = await ipc.commandRun(project, componentId, id, taskId ?? undefined)
    s.addRuntimeTerminal(
      sid,
      {
        projectId: project.projectId,
        taskId,
        componentId,
        terminal: { id: `ext-${id}`, name: command.title, ...command.run },
        commandId: id,
      },
      true,
    )
    return sid
  }
  const runtime = await activateExtension(extension, project, taskId)
  if (!runtime?.commands.has(id)) throw new Error(`Command ${id} was not registered`)
  return request(runtime, 'command', id, args, COMMAND_TIMEOUT)
}
/** Short stable name for a command, so repeating a `terminals.run` reuses its session. */
function runKey(command: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < command.length; i++)
    hash = Math.imul(hash ^ command.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16)
}
async function runTerminal(runtime: Runtime, componentId: string, command: string) {
  const s = stateForRuntime(runtime)
  if (!s.project) throw new Error('Open a project first')
  const key = runKey(command)
  const own = Object.entries(s.runtimeTerminals).filter(
    ([, t]) => t.projectId === runtime.projectId && t.extensionId === runtime.extension.id,
  )
  const existing = own.find(
    ([, t]) =>
      t.componentId === componentId && t.key === key && (t.taskId ?? null) === runtime.taskId,
  )
  if (existing && s.sessions[existing[0]]?.running)
    throw new Error('That command is still running in this component')
  if (!existing && own.length >= MAX_RUN_TERMINALS)
    throw new Error(`An extension may keep at most ${MAX_RUN_TERMINALS} terminals`)
  const sid = await ipc.extensionTerminalRun(
    s.toProject(),
    runtime.extension.id,
    componentId,
    command,
    key,
    runtime.taskId ?? undefined,
  )
  s.addRuntimeTerminal(sid, {
    projectId: runtime.projectId,
    taskId: runtime.taskId,
    componentId,
    terminal: {
      // The id `extensions::run_terminal` gives it, from which `sid` was derived.
      id: `ext-${runtime.extension.id}-${key}`,
      name: runtime.extension.manifest.displayName ?? runtime.extension.id,
      command,
      kind: 'task',
    },
    extensionId: runtime.extension.id,
    key,
  })
  const deadline = Date.now() + 8000
  let snapshot = await ipc.terminalSnapshot(sid)
  const generation = snapshot?.generation
  while (snapshot?.running && Date.now() < deadline && !runtime.disposed) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    snapshot = await ipc.terminalSnapshot(sid)
  }
  if (runtime.disposed) throw new Error('Extension stopped')
  if (snapshot?.generation !== generation)
    throw new Error('Command restarted while reading its result; Refresh again')
  return {
    sessionId: sid,
    output: snapshot
      ? new TextDecoder().decode(Uint8Array.from(atob(snapshot.data), (c) => c.charCodeAt(0)))
      : '',
    exitCode: snapshot?.exitCode ?? null,
    running: snapshot?.running ?? false,
  }
}
const storageQueues = new Map<string, Promise<unknown>>()
async function api(runtime: Runtime, method: string, args: unknown[]): Promise<unknown> {
  const s = stateForRuntime(runtime)
  const id = runtime.extension.id
  const text = (i: number, max = 32768) => {
    if (typeof args[i] !== 'string' || (args[i] as string).length > max)
      throw new Error('Invalid argument')
    return args[i] as string
  }
  switch (method) {
    case 'commands.register': {
      const command = text(0)
      if (!runtime.extension.manifest.contributes.commands.some((c) => c.id === command && !c.run))
        throw new Error('Command must be contributed by this extension')
      runtime.commands.add(command)
      return null
    }
    case 'commands.execute': {
      const target = ownerOfCommand(text(0))
      const command = target?.manifest.contributes.commands.find((c) => c.id === args[0])
      if (command?.run) permission(runtime, 'terminals')
      if (target?.id !== id)
        for (const required of target?.manifest.permissions ?? []) permission(runtime, required)
      const commandArgs = Array.isArray(args[1]) ? args[1] : []
      if (target?.id === id && !command?.run) {
        // Never wait on our own activation from inside it.
        if (!runtime.commands.has(text(0))) throw new Error(`Command ${text(0)} is not registered`)
        return request(runtime, 'command', text(0), commandArgs, COMMAND_TIMEOUT)
      }
      return executeExtensionCommand(
        text(0),
        commandArgs,
        s.selectedId,
        s.project ? s.toProject() : null,
        runtime.taskId,
      )
    }
    case 'workspace.get':
      permission(runtime, 'project:read')
      return s.project ? { projectId: runtime.projectId, taskId: runtime.taskId } : null
    case 'sessions.list':
      permission(runtime, 'sessions:read')
      return ipc.extensionSessionsList(id, s.toProject(), text(0), runtime.taskId ?? undefined)
    case 'urls.open':
      permission(runtime, 'urls:open')
      return ipc.extensionUrlOpen(id, runtime.projectId, text(0, 2048))
    case 'project.get':
      permission(runtime, 'project:read')
      return s.project ? s.toProject() : null
    case 'git.status':
      permission(runtime, 'project:read')
      return { changes: s.gitChanges, repos: s.repos }
    case 'terminals.start':
      permission(runtime, 'terminals')
      if (!s.project) throw new Error('Open a project first')
      // In the active task's worktree, like terminals the user starts.
      return ipc.terminalStart(s.toProject(), text(0), text(1), id, s.activeTask ?? undefined)
    case 'terminals.run':
      permission(runtime, 'terminals')
      return runTerminal(runtime, text(0), text(1))
    case 'files.read':
      permission(runtime, 'files:read')
      return ipc.extensionFileRead(id, text(0), runtime.projectId, runtime.taskId ?? undefined)
    case 'context.register':
    case 'badges.register':
      permission(runtime, 'project:read')
      runtime.providers.add(method.split('.')[0])
      scheduleBadges()
      return null
    case 'views.register': {
      const view = text(0)
      if (!runtime.extension.manifest.contributes.views.some((v) => v.id === view))
        throw new Error('View must be contributed by this extension')
      runtime.views.add(view)
      return null
    }
    case 'views.render': {
      const view = text(0)
      if (!runtime.views.has(view)) throw new Error('View is not registered')
      setRuntimeView(runtime, view, text(1, 512 * 1024))
      return null
    }
    case 'views.postMessage': {
      const view = text(0)
      if (!runtime.views.has(view)) throw new Error('View is not registered')
      if (!isCurrent(runtime)) return null
      viewFrames.get(view)?.contentWindow?.postMessage({ patchbay: 1, value: args[1] }, '*')
      return null
    }
    case 'window.showMessage':
      if (isCurrent(runtime)) s.setMessage(text(0, 2048))
      return null
    case 'storage.get': {
      await storageQueues.get(id)
      const data = await ipc.extensionStorageGet(id)
      return Object.hasOwn(data, text(0, 200)) ? data[text(0, 200)] : null
    }
    case 'storage.set': {
      const key = text(0, 200)
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('Invalid storage key')
      const queue = (storageQueues.get(id) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const data = await ipc.extensionStorageGet(id)
          data[key] = args[1]
          await ipc.extensionStorageSet(id, data)
        })
      storageQueues.set(id, queue)
      await queue
      return null
    }
    case 'dispose': {
      const registration = text(0)
      const key = text(1)
      if (registration === 'commands.register') runtime.commands.delete(key)
      else if (registration === 'views.register') {
        runtime.views.delete(key)
        setRuntimeView(runtime, key, '')
      } else {
        runtime.providers.delete(key)
        scheduleBadges()
      }
      return null
    }
    default:
      throw new Error(`Unknown API method ${method}`)
  }
}
async function onMessage(event: MessageEvent) {
  if (event.origin !== 'null' || event.data?.patchbay !== 1) return
  let encoded: string
  try {
    encoded = JSON.stringify(event.data)
  } catch {
    const invalid = [...runtimes.values()].find((r) => r.frame.contentWindow === event.source)
    if (invalid) shutdown(invalid)
    return
  }
  const runtime = [...runtimes.values()].find((r) => r.frame.contentWindow === event.source)
  if (!runtime) {
    for (const [viewId, frame] of viewFrames)
      if (frame.contentWindow === event.source) {
        const owner = [...runtimes.values()].find((r) => isCurrent(r) && r.views.has(viewId))
        if (owner && encoded.length <= 512 * 1024)
          send(owner, { method: 'viewMessage', viewId, value: event.data.value })
      }
    return
  }
  const message = event.data
  if (runtime.disposed) return
  if (encoded.length > 1024 * 1024) {
    shutdown(runtime)
    return
  }
  const pending = message.reply === undefined ? undefined : runtime.pending.get(message.reply)
  if (pending) {
    clearTimeout(pending.timer)
    runtime.pending.delete(message.reply)
    runtime.timeouts = 0
    if (message.error) pending.reject(new Error(String(message.error)))
    else pending.resolve(message.result)
    return
  }
  if (Date.now() - runtime.period > 1000) {
    runtime.period = Date.now()
    runtime.calls = 0
  }
  if (++runtime.calls > 200) {
    error(`${runtime.extension.id}: message limit exceeded`)
    shutdown(runtime)
    return
  }
  // A reply whose request already timed out (or was never sent): that call has failed, so drop it.
  if (message.reply !== undefined) return
  if (message.method === 'ready') {
    runtime.resolveReady()
    return
  }
  if (message.method === 'failed') {
    runtime.rejectReady(new Error(String(message.error)))
    shutdown(runtime)
    return
  }
  if (
    !Number.isSafeInteger(message.id) ||
    typeof message.method !== 'string' ||
    !Array.isArray(message.args)
  ) {
    shutdown(runtime)
    return
  }
  if (++runtime.inflight > 32) {
    shutdown(runtime)
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      api(runtime, message.method, message.args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('API call timed out')), API_TIMEOUT)
      }),
    ])
    if (!runtime.disposed) send(runtime, { reply: message.id, result: result ?? null })
  } catch (e) {
    if (!runtime.disposed) send(runtime, { reply: message.id, error: String(e) })
  } finally {
    clearTimeout(timer)
    runtime.inflight--
  }
}
/** Start the extensions that activate eagerly, except `caller`, which may still be activating. */
async function activateProviders(caller?: string, project?: Project) {
  if (!useStore.getState().project) return
  await Promise.all(
    active()
      .filter(
        (e) => !e.manifest.activationEvents.length && !quarantined.has(e.id) && e.id !== caller,
      )
      .map((e) => activateExtension(e, project).catch(error)),
  )
}
/**
 * Ask every ready context provider about each component, all in parallel. A provider's
 * timeouts in one collection count as a single strike, so a slow one isn't stopped at once.
 */
async function collectContext(
  project: Project,
  ids: string[],
  caller?: string,
): Promise<ContextSection[]> {
  await activateProviders(caller, project)
  const current = epoch
  const taskId =
    useStore.getState().captureProjects()[project.projectId ?? '']?.state?.activeTask ?? null
  const components = project.components.filter((c) => !ids.length || ids.includes(c.id))
  const asks = [...runtimes.values()]
    .filter(
      (r) =>
        r.projectId === project.projectId &&
        r.taskId === taskId &&
        r.isReady &&
        r.providers.has('context'),
    )
    .map(async (runtime) => {
      let timedOut = false
      const answers = await Promise.all(
        components.map(async (component) => {
          try {
            const body = await request(runtime, 'provider', 'context', [component], 2000, false)
            if (typeof body !== 'string' || !body) return []
            const name = runtime.extension.manifest.displayName ?? runtime.extension.id
            return [{ title: `${name} — ${component.name}`, body: body.slice(0, 32768) }]
          } catch (e) {
            if (e instanceof Timeout) timedOut = true
            else error(e)
            return []
          }
        }),
      )
      if (timedOut) {
        error(`${runtime.extension.id}: context provider timed out`)
        strike(runtime)
      }
      return answers.flat()
    })
  const sections = (await Promise.all(asks)).flat()
  return current === epoch ? sections : []
}
function scheduleBadges() {
  clearTimeout(badgeTimer)
  badgeTimer = setTimeout(() => void refreshBadges(), 150)
}
async function refreshBadges() {
  await activateProviders()
  const generation = ++badgeEpoch
  const current = epoch
  const result: Record<string, ExtensionBadge[]> = {}
  const projectId = useStore.getState().project?.id
  const taskId = useStore.getState().activeTask
  const components = useStore.getState().toProject().components
  await Promise.all(
    [...runtimes.values()]
      .filter((r) => isCurrent(r) && r.providers.has('badges'))
      .map(async (runtime) => {
        for (const component of components) {
          if (current !== epoch || runtime.disposed) return
          try {
            const badge = (await request(
              runtime,
              'provider',
              'badges',
              [component],
              2000,
            )) as ExtensionBadge | null
            if (badge && typeof badge.text === 'string')
              (result[component.id] ??= []).push({
                text: badge.text.slice(0, 40),
                tone: ['info', 'success', 'warning', 'error'].includes(badge.tone ?? '')
                  ? badge.tone
                  : 'info',
                tooltip:
                  typeof badge.tooltip === 'string' ? badge.tooltip.slice(0, 500) : undefined,
              })
          } catch (e) {
            error(e)
            break
          }
        }
      }),
  )
  if (
    current === epoch &&
    generation === badgeEpoch &&
    useStore.getState().project?.id === projectId &&
    useStore.getState().activeTask === taskId
  )
    useStore.getState().setExtensionBadges(result)
}
export async function activateView(id: string) {
  const extension = active().find((e) => e.manifest.contributes.views.some((v) => v.id === id))
  if (extension) await activateExtension(extension)
}
export function bindViewFrame(id: string, frame: HTMLIFrameElement | null) {
  if (frame) viewFrames.set(id, frame)
  else viewFrames.delete(id)
}
export function startExtensionHost() {
  if (getCurrentWebviewWindow().label !== 'main') return () => {}
  installed = true
  window.addEventListener('message', onMessage)
  setContextCollector(collectContext)
  const project = useStore.getState().project ? useStore.getState().toProject() : null
  lastProjectKey = JSON.stringify([projectKey(project), useStore.getState().activeTask])
  // Pop-outs send only ids; answer from the main window's own map.
  const unsubscribeContext = serveContextRequests((projectId, ids) => {
    const entry = useStore.getState().captureProjects()[projectId]
    if (!entry?.state?.project) return Promise.resolve([])
    return collectContext(projectFromState(entry.state), ids)
  })
  const unsubscribe = useStore.subscribe((s, previous) => {
    if (
      s.project !== previous.project ||
      s.activeTask !== previous.activeTask ||
      s.projects !== previous.projects
    )
      retireStale()
    if (s.extensions !== previous.extensions) {
      stopping = stopping.then(deactivateAll)
      void stopping
        .then(async () => {
          if (!installed) return
          await activationEvent('onStartup')
          await projectActivation()
        })
        .catch(error)
    } else if (
      s.project !== previous.project ||
      s.nodes !== previous.nodes ||
      s.edges !== previous.edges ||
      s.selectedId !== previous.selectedId ||
      s.activeTask !== previous.activeTask
    ) {
      scheduleNotify()
      if (s.project?.id !== previous.project?.id || s.activeTask !== previous.activeTask) {
        useStore.setState({ extensionViews: {}, extensionBadges: {} })
        void projectActivation().catch(error)
      }
    } else if (s.sessions !== previous.sessions || s.gitChanges !== previous.gitChanges)
      scheduleBadges()
  })
  void activationEvent('onStartup').then(projectActivation).catch(error)
  return () => {
    installed = false
    clearTimeout(notifyTimer)
    unsubscribe()
    unsubscribeContext()
    window.removeEventListener('message', onMessage)
    setContextCollector(undefined)
    stopping = stopping.then(deactivateAll)
  }
}
export async function refreshExtensions(registry?: Awaited<ReturnType<typeof ipc.listExtensions>>) {
  const [extensions, devices] = await Promise.all([
    registry ?? ipc.listExtensions(),
    ipc.listDevices(),
  ])
  const s = useStore.getState()
  s.setExtensions(extensions)
  s.setDevices(devices)
}
export function selectedComponent(): Component | null {
  const s = useStore.getState()
  return s.toProject().components.find((c) => c.id === s.selectedId) ?? null
}

const projectFromState = (s: import('../store').ProjectState): Project => projectFrom(s)
function stateForRuntime(runtime: Runtime) {
  const global = useStore.getState()
  const entry = global.captureProjects()[runtime.projectId]
  const scoped = entry?.state
  return {
    ...global,
    ...scoped,
    project:
      scoped?.project ??
      (runtime.project
        ? { id: runtime.projectId, name: runtime.project.name, root: runtime.project.root }
        : null),
    activeTask: runtime.taskId,
    toProject: () => (scoped ? projectFromState(scoped) : runtime.project!),
  }
}

function setRuntimeView(runtime: Runtime, view: string, html: string) {
  const s = useStore.getState()
  runtime.renderedViews.set(view, html)
  if (isCurrent(runtime)) {
    s.setExtensionView(view, html)
    return
  }
  const entry = s.projects[runtime.projectId]
  if (!entry?.state || entry.state.activeTask !== runtime.taskId) return
  useStore.setState({
    projects: {
      ...s.projects,
      [runtime.projectId]: {
        ...entry,
        state: { ...entry.state, extensionViews: { ...entry.state.extensionViews, [view]: html } },
      },
    },
  })
}
