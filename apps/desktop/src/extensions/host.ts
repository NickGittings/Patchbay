import { convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import * as ipc from '../lib/ipc'
import { useStore } from '../store'
import type { Component, ContextSection, Extension, ExtensionBadge, Project } from '../types'
import { setContextCollector } from './context'

const TIMEOUT = 10000
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface Runtime {
  extension: Extension
  frame: HTMLIFrameElement
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  pending: Map<number, Pending>
  commands: Set<string>
  providers: Set<string>
  views: Set<string>
  inflight: number
  calls: number
  period: number
  disposed: boolean
}
const runtimes = new Map<string, Runtime>()
const quarantined = new Set<string>()
const viewFrames = new Map<string, HTMLIFrameElement>()
let next = 0
let epoch = 0
let stopping: Promise<void> = Promise.resolve()
let badgeTimer: ReturnType<typeof setTimeout> | undefined
let badgeEpoch = 0
let installed = false
const error = (e: unknown) => useStore.getState().setMessage(String(e))
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
function request(
  runtime: Runtime,
  target: string,
  key: string,
  args: unknown[],
  timeout = TIMEOUT,
): Promise<unknown> {
  if (runtime.disposed) return Promise.reject(new Error('Extension stopped'))
  return new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      runtime.pending.delete(id)
      reject(new Error(`${runtime.extension.id}: ${target} timed out`))
      shutdown(runtime)
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
  runtimes.delete(runtime.extension.id)
  for (const pending of runtime.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Extension stopped'))
  }
  runtime.pending.clear()
  const s = useStore.getState()
  for (const view of runtime.views) {
    s.setExtensionView(view, '')
    viewFrames.delete(view)
  }
  scheduleBadges()
}
async function deactivateAll() {
  epoch++
  clearTimeout(badgeTimer)
  useStore.getState().setExtensionBadges({})
  await Promise.all(
    [...runtimes.values()].map(async (runtime) => {
      const id = ++next
      // Give deactivate a bounded chance to finish before removing its frame.
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
    }),
  )
  quarantined.clear()
}
function notify(runtime: Runtime) {
  const s = useStore.getState()
  if (runtime.extension.manifest.permissions.includes('project:read')) {
    send(runtime, { method: 'event', event: 'project', value: s.project ? s.toProject() : null })
    send(runtime, {
      method: 'event',
      event: 'selection',
      value: s.toProject().components.find((c) => c.id === s.selectedId) ?? null,
    })
  }
}
export async function activateExtension(extension: Extension): Promise<Runtime | undefined> {
  if (!extension.manifest.main || !installed) return undefined
  await stopping
  if (quarantined.has(extension.id))
    throw new Error(`${extension.id} stopped; reload extensions to retry`)
  const existing = runtimes.get(extension.id)
  if (existing) {
    await existing.ready
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
    extension,
    frame,
    ready,
    resolveReady,
    rejectReady,
    pending: new Map(),
    commands: new Set(),
    providers: new Set(),
    views: new Set(),
    inflight: 0,
    calls: 0,
    period: Date.now(),
    disposed: false,
  }
  runtimes.set(extension.id, runtime)
  const timer = setTimeout(() => {
    rejectReady(new Error(`${extension.id}: activation timed out`))
    shutdown(runtime)
  }, TIMEOUT)
  document.body.append(frame)
  try {
    await ready
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
async function activationEvent(event: string) {
  const current = epoch
  for (const extension of active()) {
    if (current !== epoch) return
    if (extension.manifest.activationEvents.includes(event))
      await activateExtension(extension).catch(error)
  }
}
async function projectActivation() {
  await stopping
  if (!useStore.getState().project) return
  await activationEvent('onProjectOpen')
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
      const files = await ipc.listDir(folder).catch(() => [])
      if (files.some((f) => f.name === name && !f.isDir))
        await activateExtension(extension).catch(error)
    }
}
export async function executeExtensionCommand(
  id: string,
  args: unknown[] = [],
  componentId = useStore.getState().selectedId,
): Promise<unknown> {
  const extension = ownerOfCommand(id)
  const command = extension?.manifest.contributes.commands.find((c) => c.id === id)
  if (!extension || !command) throw new Error(`Unknown command ${id}`)
  const s = useStore.getState()
  if (command.run) {
    const current = epoch
    if (!componentId || !s.project) throw new Error('Select a component first')
    const sid = await ipc.commandRun(s.toProject(), componentId, id)
    if (current !== epoch || useStore.getState().project !== s.project) {
      await ipc.terminalStop(sid)
      throw new Error('Project changed during command launch')
    }
    s.addRuntimeTerminal(sid, {
      componentId,
      terminal: { id: `ext-${id}`, name: command.title, ...command.run },
      commandId: id,
    })
    return sid
  }
  const runtime = await activateExtension(extension)
  if (!runtime?.commands.has(id)) throw new Error(`Command ${id} was not registered`)
  return request(runtime, 'command', id, args)
}
async function runTerminal(runtime: Runtime, componentId: string, command: string) {
  const s = useStore.getState()
  if (!s.project) throw new Error('Open a project first')
  const current = epoch
  const requestId = String(++next)
  const sid = await ipc.extensionTerminalRun(
    s.toProject(),
    runtime.extension.id,
    componentId,
    command,
    requestId,
  )
  if (current !== epoch || runtime.disposed || useStore.getState().project !== s.project) {
    await ipc.terminalStop(sid)
    throw new Error('Extension stopped during terminal launch')
  }
  s.addRuntimeTerminal(sid, {
    componentId,
    terminal: {
      id: sid.slice(sid.lastIndexOf('/') + 1),
      name: runtime.extension.manifest.displayName ?? runtime.extension.id,
      command,
      kind: 'task',
    },
    extensionId: runtime.extension.id,
    requestId,
  })
  const deadline = Date.now() + 8000
  let snapshot = await ipc.terminalSnapshot(sid)
  while (snapshot?.running && Date.now() < deadline && !runtime.disposed) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    snapshot = await ipc.terminalSnapshot(sid)
  }
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
  const s = useStore.getState()
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
      if (target?.id === id && !command?.run && runtime.commands.has(text(0)))
        return request(runtime, 'command', text(0), Array.isArray(args[1]) ? args[1] : [])
      return executeExtensionCommand(text(0), Array.isArray(args[1]) ? args[1] : [])
    }
    case 'project.get':
      permission(runtime, 'project:read')
      return s.project ? s.toProject() : null
    case 'git.status':
      permission(runtime, 'project:read')
      return { changes: s.gitChanges, repos: s.repos }
    case 'terminals.start':
      permission(runtime, 'terminals')
      if (!s.project) throw new Error('Open a project first')
      return ipc.terminalStart(s.toProject(), text(0), text(1))
    case 'terminals.run':
      permission(runtime, 'terminals')
      return runTerminal(runtime, text(0), text(1))
    case 'files.read':
      permission(runtime, 'files:read')
      return ipc.extensionFileRead(id, text(0))
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
      s.setExtensionView(view, text(1, 512 * 1024))
      return null
    }
    case 'views.postMessage': {
      const view = text(0)
      if (!runtime.views.has(view)) throw new Error('View is not registered')
      viewFrames.get(view)?.contentWindow?.postMessage({ patchbay: 1, value: args[1] }, '*')
      return null
    }
    case 'window.showMessage':
      s.setMessage(text(0, 2048))
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
        s.setExtensionView(key, '')
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
        const owner = [...runtimes.values()].find((r) => r.views.has(viewId))
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
  if (message.reply !== undefined && runtime.pending.has(message.reply)) {
    const pending = runtime.pending.get(message.reply)
    if (pending) {
      clearTimeout(pending.timer)
      runtime.pending.delete(message.reply)
      if (message.error) pending.reject(new Error(String(message.error)))
      else pending.resolve(message.result)
    }
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
        timer = setTimeout(() => {
          reject(new Error('API call timed out'))
          shutdown(runtime)
        }, TIMEOUT)
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
async function activateProviders() {
  if (!useStore.getState().project) return
  await Promise.all(
    active()
      .filter((e) => !e.manifest.activationEvents.length && !quarantined.has(e.id))
      .map((e) => activateExtension(e).catch(error)),
  )
}
async function collectContext(project: Project, ids: string[]): Promise<ContextSection[]> {
  await activateProviders()
  const current = epoch
  const sections: ContextSection[] = []
  await Promise.all(
    [...runtimes.values()]
      .filter((r) => r.providers.has('context'))
      .map(async (runtime) => {
        for (const component of project.components.filter(
          (c) => !ids.length || ids.includes(c.id),
        )) {
          if (current !== epoch) return
          try {
            const body = await request(runtime, 'provider', 'context', [component], 2000)
            if (typeof body === 'string')
              sections.push({
                title: `${runtime.extension.manifest.displayName ?? runtime.extension.id} — ${component.name}`,
                body: body.slice(0, 32768),
              })
          } catch (e) {
            error(e)
            break
          }
        }
      }),
  )
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
  const components = useStore.getState().toProject().components
  await Promise.all(
    [...runtimes.values()]
      .filter((r) => r.providers.has('badges'))
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
  if (current === epoch && generation === badgeEpoch) useStore.getState().setExtensionBadges(result)
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
  const unsubscribe = useStore.subscribe((s, previous) => {
    if (s.extensions !== previous.extensions || s.project !== previous.project) {
      stopping = stopping.then(deactivateAll)
      void stopping
        .then(async () => {
          if (!installed) return
          await activationEvent('onStartup')
          await projectActivation()
        })
        .catch(error)
    } else if (
      s.nodes !== previous.nodes ||
      s.edges !== previous.edges ||
      s.selectedId !== previous.selectedId
    ) {
      for (const runtime of runtimes.values()) notify(runtime)
      if (s.nodes !== previous.nodes || s.edges !== previous.edges) scheduleBadges()
    } else if (s.sessions !== previous.sessions || s.gitChanges !== previous.gitChanges)
      scheduleBadges()
  })
  void activationEvent('onStartup').then(projectActivation).catch(error)
  return () => {
    installed = false
    unsubscribe()
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
