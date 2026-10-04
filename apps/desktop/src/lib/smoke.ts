import { extensionStorageGet, reloadExtensions } from './ipc'
import { refreshExtensions } from '../extensions/host'
import { evaluateWhen } from '../extensions/when'
import { executeExtensionCommand } from '../extensions/host'
// Dev-only handles for smoke/popout.js, loaded from main.tsx when import.meta.env.DEV.
import { emit } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { componentContext, openProject, terminalReset, terminalWrite } from './ipc'
import { resetSessions, startTerminal, stopTerminal } from './sessions'
import { terminalText } from './terminals'
import { openComponentWindow } from './windows'
import { applyAdded } from './project'
import { requestGitRefresh } from './git'
import { syncCurrentRoots } from './access'
import { runGraphAction, stopGroup } from './actions'
import { graphActionPlan } from './ipc'

const hooks = {
  store: useStore,
  runGraphAction,
  stopGroup,
  graphActionPlan,
  evaluateWhen,
  reloadExtensions,
  extensionStorageGet,
  refreshExtensions,
  componentContext,
  executeExtensionCommand,
  openProject,
  applyAdded,
  requestGitRefresh,
  syncCurrentRoots,
  startTerminal,
  stopTerminal,
  terminalReset,
  resetSessions,
  terminalWrite,
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
