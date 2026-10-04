// Dev-only handles for smoke/popout.js, loaded from main.tsx when import.meta.env.DEV.
import { emit } from '@tauri-apps/api/event'
import { useStore } from '../store'
import { openProject, terminalReset, terminalWrite } from './ipc'
import { resetSessions, startTerminal } from './sessions'
import { terminalText } from './terminals'
import { openComponentWindow } from './windows'
import { applyAdded } from './project'
import { requestGitRefresh } from './git'
import { syncCurrentRoots } from './access'

const hooks = {
  store: useStore,
  openProject,
  applyAdded,
  requestGitRefresh,
  syncCurrentRoots,
  startTerminal,
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
