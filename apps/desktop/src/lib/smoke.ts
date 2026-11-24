import { openInEditor } from './navigation'
import { readTextFile, guardEditorClose } from './fileEditor'
import { useChatTeams, refreshChatTeams } from './chatTeams'
import { useSimpleUi, simpleKey } from './simpleUi'
import { startTaskAgent } from './implement'
import { providerAuthCheck, providerLoginWrite, onProviderLoginEvent } from './ipc'
import { worktreeSetup, enableWorktreeSetup } from './ipc'
import {
  createProviderRun,
  providerRuns,
  driveProviderRuns,
  controlProviderRun,
} from './orchestration'
import { implementPlannerPlan } from './planHandoff'
import { graphActionIn } from './actions'
import { startReviewAgents } from './reviewAgents'
import { reviewRead } from './ipc'
import { listAgentProfiles, saveAgentProfile } from './agentProfiles'
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
import { emit, listen } from '@tauri-apps/api/event'
import { useStore } from '../store'
import {
  componentContext,
  openProject,
  reloadProject,
  terminalReset,
  terminalWrite,
  terminalAttach,
  terminalPrompt,
} from './ipc'
import {
  resetSessions,
  startTerminal,
  restartTerminal,
  stopTerminal,
  reconcileSessions,
} from './sessions'
import {
  editorOpen,
  editorPreferences,
  editorSavePreferences,
  fileSearch,
  terminalOpenReference,
} from './ipc'
import { terminalReferences } from './navigation'
import { sessionGeneration } from './sessions'
import {
  hasTerminal,
  terminalNavigationState,
  terminalRendererCounts,
  terminalText,
} from './terminals'
import { openComponentWindow } from './windows'
import { applyAdded } from './project'
import { saveMap, flushMapSaves } from './mapSave'
import { saveProject } from './ipc'
import { requestGitRefresh } from './git'
import { syncCurrentRoots } from './access'
import { runGraphAction, stopGroup } from './actions'
import { graphActionPlan } from './ipc'
import { createTask, refreshTasks, removeTask, tasksSettled } from './tasks'
import { branchRefreshScheduled } from './mainWorktree'
import { useDependencies } from './dependencies'
import { useStackProposals } from './stackAgent'
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
import * as agentQuestionsModule from './agentQuestions'
import { MAIN_WINDOW_LABEL } from './mainWindow'
import { MENU_ACTION_EVENT } from './nativeMenus'

const SMOKE_REPORT_EVENT = 'patchbay://smoke-report'
const SMOKE_ACK_EVENT = 'patchbay://smoke-ack'
const agentQuestions = {
  store: agentQuestionsModule.useAgentQuestions,
  listen: agentQuestionsModule.listenAgentQuestions,
  watch: agentQuestionsModule.watchQuestions,
  claim: agentQuestionsModule.claimQuestion,
  answer: agentQuestionsModule.answerQuestion,
}

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
/** Plain text of retained output, for sessions this webview has no xterm for. */
const backlogText = new Map<string, string>()
const readingBacklog = new Set<string>()
// oxlint-disable-next-line no-control-regex -- terminal escape sequences
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|\r/g
/**
 * Scripts poll this synchronously. Sessions without an xterm (not on screen) answer from the
 * service backlog, refreshed in the background so the next poll sees newer output.
 */
function smokeTerminalText(sid: string) {
  if (hasTerminal(sid)) return terminalText(sid)
  if (!readingBacklog.has(sid)) {
    readingBacklog.add(sid)
    void terminalSnapshot(sid)
      .then((snapshot) => {
        const bytes = Uint8Array.from(atob(snapshot?.data ?? ''), (c) => c.charCodeAt(0))
        backlogText.set(sid, new TextDecoder().decode(bytes).replace(ANSI, ''))
      })
      .catch(() => {})
      .finally(() => readingBacklog.delete(sid))
  }
  return { text: backlogText.get(sid) ?? '', cols: 0, rows: 0 }
}

const hooks = {
  simpleUi: useSimpleUi,
  chatTeams: useChatTeams,
  agentQuestions,
  refreshChatTeams,
  simpleKey,
  startTaskAgent,
  providerAuthCheck,
  providerLoginWrite,
  onProviderLoginEvent,
  emit,
  listen,
  createProviderRun,
  providerRuns,
  driveProviderRuns,
  controlProviderRun,
  implementPlannerPlan,
  graphActionIn,
  startReviewAgents,
  reviewRead,
  chatPanel,
  refreshUsage,
  usage: useUsage,
  usageRead,
  usageStatusLineCheck,
  usageStatusLineConfigure,
  inspectNativeMenu,
  nativeMenuAction: (id: string) =>
    import('@tauri-apps/api/event').then(({ emitTo }) =>
      emitTo(MAIN_WINDOW_LABEL, MENU_ACTION_EVENT, id),
    ),
  selectPanel,
  selectRailView,
  rail: useRail,
  listAgentProfiles,
  saveAgentProfile,
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
  worktreeSetup,
  enableWorktreeSetup,
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
  reloadProject,
  agentHooksCheck,
  agentHooksConfigure,
  reviewRescan,
  applyMapReview,
  maintenance: useMaintenance,
  dependencies: useDependencies,
  stackProposals: useStackProposals,
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
  openInEditor,
  readTextFile,
  guardEditorClose,
  editorOpen,
  editorPreferences,
  editorSavePreferences,
  fileSearch,
  terminalOpenReference,
  terminalReferences,
  sessionGeneration,
  terminalNavigationState,
  flushWorkspace,
  /** Answers each in-app confirmation through its own buttons, given the dialog's text; returns
   *  a function that stops answering. Stands in for overriding `window.confirm`. */
  answerConfirms: (answer: (text: string) => boolean) => {
    const seen = new WeakSet<Element>()
    const answerOpen = () => {
      const dialog = document.querySelector('.confirm-dialog [role="alertdialog"]')
      if (!dialog || seen.has(dialog)) return
      seen.add(dialog)
      const text = [...dialog.querySelectorAll('.dialog-body p')]
        .map((p) => p.textContent)
        .join('\n\n')
      const [cancel, confirm] =
        dialog.querySelectorAll<HTMLButtonElement>('.settings-footer button')
      ;(answer(text) ? confirm : cancel).click()
    }
    const observer = new MutationObserver(answerOpen)
    observer.observe(document.body, { childList: true, subtree: true })
    // A confirmation already open when answering starts gets its answer too.
    answerOpen()
    return () => observer.disconnect()
  },
  resizeWindow: async (width: number, height: number) => {
    const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setSize(new LogicalSize(width, height))
  },
  isWindowMaximized: async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().isMaximized()
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
  restartTerminal,
  stopTerminal,
  terminalReset,
  resetSessions,
  terminalWrite: async (sid: string, data: string) => {
    await terminalAttach(sid, true)
    await terminalWrite(sid, data)
  },
  terminalText: smokeTerminalText,
  terminalRendererCounts,
  terminalPrompt,
  openComponentWindow,
  createTask,
  refreshTasks,
  /** Resolves once watcher-driven branch and task refreshes for `projectId` have landed. */
  settleTaskRefreshes: async (projectId: string) => {
    while (branchRefreshScheduled(projectId)) await new Promise((done) => setTimeout(done, 50))
    await tasksSettled(projectId)
  },
  removeTask,
  report: (message: string) => emit(SMOKE_REPORT_EVENT, message),
  /**
   * Reports `message`, then resolves to the launcher's answer to it, a `<message>: <answer>` line
   * on the app's stdin (forwarded by `smoke.rs`).
   */
  reportAndWait: async (message: string, timeout = 60000) => {
    const { listen } = await import('@tauri-apps/api/event')
    let answer: (value: string) => void = () => {}
    const answered = new Promise<string>((resolve) => (answer = resolve))
    const unlisten = await listen<string>(SMOKE_ACK_EVENT, ({ payload }) => {
      if (payload.startsWith(`${message}: `)) answer(payload.slice(message.length + 2))
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer to ${message}`)), timeout)
    })
    try {
      await emit(SMOKE_REPORT_EVENT, message)
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
