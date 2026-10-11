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
const hooks = {
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
}

declare global {
  interface Window {
    __patchbaySmoke?: typeof hooks
  }
}

export function installSmokeHooks() {
  window.__patchbaySmoke = hooks
}
