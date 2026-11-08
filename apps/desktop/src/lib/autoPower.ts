import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { projectStateOf, useStore } from '../store'
import type { AutoRun } from '../types'
import { autoRuns } from './autoState'

export type PowerStatus = 'inactive' | 'active' | 'onBattery' | 'powerUnknown' | 'unavailable'
export const useAutoPower = create<{ status: PowerStatus; error?: string | null }>(() => ({
  status: 'inactive',
}))

export function needsAutoPower(run: AutoRun, eligible: boolean) {
  return (
    eligible &&
    (run.status === 'running' ||
      (run.status === 'paused' &&
        ['scheduled', 'usage'].includes(run.pauseKind ?? '') &&
        !!run.resumeTrigger &&
        Number.isFinite(run.resumeTrigger.atMs)))
  )
}

export const autoKeepAwakeEnabled = () =>
  useStore.getState().workspaceSettings.autoKeepAwake === true

export function setAutoKeepAwake(enabled: boolean) {
  useStore.setState((s) => ({
    workspaceSettings: { ...s.workspaceSettings, autoKeepAwake: enabled },
  }))
}

/** Main window only. A pending Web Lock keeps background work eligible for execution on
 * webviews without Tauri's native throttling control. The backend also expires stale demand.
 */
export function followAutoPower() {
  let disposed = false
  let busy = false
  let pending = false
  let backgroundAvailable = false
  const lifetime = new AbortController()
  let releaseLock: (() => void) | undefined
  // Web Locks are a documented workaround for engines where background_throttling is
  // unsupported. Hold the lock for the driver lifetime, including before a schedule is due.
  const locks = globalThis.navigator?.locks
  const backgroundReady = locks
    ? new Promise<boolean>((ready) => {
        void locks
          .request('patchbay-auto-scheduler', { signal: lifetime.signal }, async () => {
            ready(true)
            await new Promise<void>((release) => {
              releaseLock = release
            })
          })
          .catch(() => ready(false))
      })
    : Promise.resolve(false)
  const tick = async () => {
    const backgroundSupported = await backgroundReady
    backgroundAvailable = backgroundSupported
    if (disposed) return
    if (busy) {
      pending = true
      return
    }
    const state = useStore.getState()
    const requested = state.workspaceSettings.autoKeepAwake === true
    const enabled = requested && backgroundSupported
    if (requested && !backgroundSupported) {
      useAutoPower.setState({
        status: 'unavailable',
        error: 'Background scheduling is unavailable in this webview.',
      })
    }
    const needed =
      !state.restoring &&
      state.serviceConnected &&
      state.projectOrder.some((id) => {
        const project = projectStateOf(id, state)
        return (
          project &&
          autoRuns(project).some(({ task, run }) =>
            needsAutoPower(
              run,
              (state.project?.id === id && state.activeTask === task) || run.background === true,
            ),
          )
        )
      })
    busy = true
    try {
      await invoke('set_auto_keep_awake_demand', { enabled, needed })
    } catch (e) {
      if (!disposed) useAutoPower.setState({ status: 'unavailable', error: String(e) })
    } finally {
      busy = false
      if (disposed) {
        void invoke('set_auto_keep_awake_demand', { enabled: false, needed: false }).catch(() => {})
      }
      if (pending) {
        pending = false
        void tick()
      }
    }
  }
  const unlisten = listen<{ status: PowerStatus; error: string | null }>(
    'auto-power-status',
    ({ payload }) => {
      if (!disposed && !(autoKeepAwakeEnabled() && !backgroundAvailable))
        useAutoPower.setState(payload)
    },
  ).catch((e) => {
    if (!disposed) useAutoPower.setState({ status: 'unavailable', error: String(e) })
  })
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (
      s.workspaceSettings !== prev.workspaceSettings ||
      s.auto !== prev.auto ||
      s.projects !== prev.projects ||
      s.taskWorkspaces !== prev.taskWorkspaces ||
      s.project !== prev.project ||
      s.activeTask !== prev.activeTask ||
      s.serviceConnected !== prev.serviceConnected ||
      s.restoring !== prev.restoring ||
      s.projectOrder !== prev.projectOrder
    )
      void tick()
  })
  const timer = setInterval(() => void tick(), 5000)
  void tick()
  return () => {
    disposed = true
    lifetime.abort()
    releaseLock?.()
    unsubscribe()
    clearInterval(timer)
    void unlisten.then((stop) => stop?.())
    // The in-flight command also releases in finally, preserving cleanup ordering.
    void invoke('set_auto_keep_awake_demand', { enabled: false, needed: false }).catch(() => {})
  }
}
