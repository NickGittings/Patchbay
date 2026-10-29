import { refreshUsage, useUsage } from './usage'
import { usageRead, usageStatusLineCheck, usageStatusLineConfigure } from './ipc'
import { selectPanel, selectRailView, useRail } from './rail'
import {
  agentHooksCheck,
  agentHooksConfigure,
  extensionStorageGet,
  reloadExtensions,
  extensionSessionsList,
  extensionUrlOpen,
  extensionTerminalRun,
  extensionFileRead,
  sessionsList,
  sessionForget,
  terminalStop,
  terminalSnapshot,
  syncAgentProject,
  planRead,
  taskAttach,
  inspectNativeMenu,
} from './ipc'
import { refreshExtensions } from '../extensions/host'
import { evaluateWhen } from '../extensions/when'
import { executeExtensionCommand } from '../extensions/host'
// Dev-only handles for smoke/popout.js, loaded from main.tsx when import.meta.env.DEV.
import { emit } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { componentContext, openProject, terminalReset, terminalWrite, terminalAttach } from './ipc'
import { resetSessions, startTerminal, stopTerminal, reconcileSessions } from './sessions'
import {
  editorOpen,
  editorPreferences,
  editorSavePreferences,
  fileSearch,
  terminalOpenReference,
} from './ipc'
import { terminalReferences } from './navigation'
import { sessionGeneration } from './sessions'
import { terminalNavigationState, terminalText } from './terminals'
import { openComponentWindow } from './windows'
import { applyAdded } from './project'
import { saveMap, flushMapSaves } from './mapSave'
import { saveProject } from './ipc'
import { requestGitRefresh } from './git'
import { syncCurrentRoots } from './access'
import { runGraphAction, stopGroup } from './actions'
import { graphActionPlan } from './ipc'
import { createTask, refreshTasks, removeTask } from './tasks'
import { useDependencies } from './dependencies'
import { mapLinksRead, stackProposalRead } from './ipc'

import { sessionId } from '../types'
import { acceptOpened, flushWorkspace } from './workspace'
import {
  reviewRescan,
  applyMapReview,
  useMaintenance,
  removeComponents,
  repairComponentPath,
} from './maintenance'
import {
  rescanProject,
  applyReconciliation,
  mapIssues,
  editMapComponents,
  releaseMapEdit,
  syncRoots,
} from './ipc'
import { startAuto, mergeNow, pauseAuto, resumeAuto, stopAuto } from './auto'
import { gitWorktrees, taskCreate, mergeOutcome } from './ipc'
import { attentionItems, revealTerminal } from './attention'
import { restoredLayout, workspaceDocument } from './workspace'
import type { NotificationDelivery } from './notifications'
import { CHAT_LAYOUT, CHAT_PANEL } from './panelLayout'

/** Polls `check` until it holds, for the pointer-driven panel helpers below. */
async function waitFor(label: string, check: () => boolean, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Navigation's Chat panel: its saved width, its resize handle and a drag of that handle. */
const chatPanel = {
  width: () => useStore.getState().panels[CHAT_LAYOUT]?.[CHAT_PANEL],
  separator: () => document.getElementById(CHAT_PANEL)?.previousElementSibling as HTMLElement,
  /** Drags the handle `delta` pixels with pointer events, until the panel's width changes. */
  drag: async (delta: number) => {
    const handle = chatPanel.separator()
    const bounds = handle.getBoundingClientRect()
    const panel = document.getElementById(CHAT_PANEL)!
    const before = panel.getBoundingClientRect().width
    const pointer = (type: string, x: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: bounds.top + bounds.height / 2,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons,
        }),
      )
    pointer('pointermove', bounds.left + 2, 0)
    await waitFor('chat separator hover', () => handle.dataset.separator === 'hover')
    pointer('pointerdown', bounds.left + 2, 1)
    await waitFor('chat separator active', () => handle.dataset.separator === 'active')
    pointer('pointermove', bounds.left + 2 + delta, 1)
    pointer('pointerup', bounds.left + 2 + delta, 0)
    await waitFor('chat resized', () => {
      const after = panel.getBoundingClientRect().width
      return delta < 0 ? after > before : after < before
    })
  },
}
const hooks = {
  chatPanel,
  refreshUsage,
  usage: useUsage,
  usageRead,
  usageStatusLineCheck,
  usageStatusLineConfigure,
  inspectNativeMenu,
  nativeMenuAction: (id: string) =>
    import('@tauri-apps/api/event').then(({ emitTo }) =>
      emitTo('main', 'patchbay://menu-action', id),
    ),
  selectPanel,
  selectRailView,
  rail: useRail,
  stubNotifications: window.__patchbaySmokeRun === true,
  notificationLog: [] as NotificationDelivery[],
  startAuto,
  mergeNow,
  pauseAuto,
  resumeAuto,
  stopAuto,
  gitWorktrees,
  taskAttach,
  taskCreate,
  mergeOutcome,
  attentionItems,
  revealTerminal,
  restoredLayout,
  workspaceDocument,
  planRead,
  syncAgentProject,
  saveMap,
  flushMapSaves,
  saveProject,
  agentHooksCheck,
  agentHooksConfigure,
  reviewRescan,
  applyMapReview,
  maintenance: useMaintenance,
  dependencies: useDependencies,
  mapLinksRead,
  stackProposalRead,
  removeComponents,
  repairComponentPath,
  rescanProject,
  applyReconciliation,
  mapIssues,
  editMapComponents,
  releaseMapEdit,
  syncRoots,
  sessionId,
  editorOpen,
  editorPreferences,
  editorSavePreferences,
  fileSearch,
  terminalOpenReference,
  terminalReferences,
  sessionGeneration,
  terminalNavigationState,
  flushWorkspace,
  resizeWindow: async (width: number, height: number) => {
    const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setSize(new LogicalSize(width, height))
  },
  focusWindow: async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setFocus()
  },
  windowLabels: () =>
    import('@tauri-apps/api/webviewWindow').then(async ({ getAllWebviewWindows }) =>
      (await getAllWebviewWindows()).map((w) => w.label),
    ),
  acceptOpened,
  reconcileSessions,
  openSecondProject: () =>
    import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<import('../types').OpenedProject>('open_project', { second: true }),
    ),
  store: useStore,
  runGraphAction,
  stopGroup,
  graphActionPlan,
  evaluateWhen,
  reloadExtensions,
  extensionStorageGet,
  extensionSessionsList,
  extensionUrlOpen,
  extensionTerminalRun,
  extensionFileRead,
  sessionsList,
  sessionForget,
  terminalStop,
  terminalSnapshot,
  refreshExtensions,
  componentContext,
  executeExtensionCommand,
  openProject: async () => {
    const deadline = Date.now() + 15000
    while (!useStore.getState().serviceConnected && Date.now() < deadline) {
      await reconcileSessions().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const opened = await openProject()
    return opened
  },
  applyAdded,
  requestGitRefresh,
  syncCurrentRoots,
  startTerminal,
  stopTerminal,
  terminalReset,
  resetSessions,
  terminalWrite: async (sid: string, data: string) => {
    await terminalAttach(sid, true)
    await terminalWrite(sid, data)
  },
  terminalText,
  openComponentWindow,
  createTask,
  refreshTasks,
  removeTask,
  report: (message: string) => emit('patchbay://smoke-report', message),
  /**
   * Reports `message`, then resolves to the launcher's answer to it, a `<message>: <answer>` line
   * on the app's stdin (forwarded by `smoke.rs`).
   */
  reportAndWait: async (message: string, timeout = 60000) => {
    const { listen } = await import('@tauri-apps/api/event')
    let answer = (_: string) => {}
    const answered = new Promise<string>((resolve) => (answer = resolve))
    const unlisten = await listen<string>('patchbay://smoke-ack', ({ payload }) => {
      if (payload.startsWith(`${message}: `)) answer(payload.slice(message.length + 2))
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer to ${message}`)), timeout)
    })
    try {
      await emit('patchbay://smoke-report', message)
      return await Promise.race([answered, expired])
    } finally {
      clearTimeout(timer)
      unlisten()
    }
  },
}

declare global {
  interface Window {
    __patchbaySmokeRun?: boolean
    __patchbaySmoke?: typeof hooks
  }
}

export function installSmokeHooks() {
  window.__patchbaySmoke = hooks
}
