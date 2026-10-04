import { extensionStorageGet, reloadExtensions } from './ipc'
import { refreshExtensions } from '../extensions/host'
import { evaluateWhen } from '../extensions/when'
import { executeExtensionCommand } from '../extensions/host'
// Dev-only handles for smoke/popout.js, loaded from main.tsx when import.meta.env.DEV.
import { emit } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { componentContext, openProject, terminalReset, terminalWrite, terminalAttach } from './ipc'
import { resetSessions, startTerminal, stopTerminal, reconcileSessions } from './sessions'
import { terminalText } from './terminals'
import { openComponentWindow } from './windows'
import { applyAdded } from './project'
import { requestGitRefresh } from './git'
import { syncCurrentRoots } from './access'

import { sessionId } from '../types'
import { acceptOpened, flushWorkspace } from './workspace'
const hooks = {
  sessionId,
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
  evaluateWhen,
  reloadExtensions,
  extensionStorageGet,
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
