import { invoke } from '@tauri-apps/api/core'
import type { EditorTarget } from '../types'

export interface FileScope {
  projectId: string
  task: string | null
  worktree?: string
}
export interface TextFile {
  path: string
  text: string
  fingerprint: string
}
export interface FileRequest extends FileScope {
  target: EditorTarget
}
export const FILE_EDITOR_EVENT = 'patchbay:file-editor'
export const EDITOR_CLOSE_REQUEST_EVENT = 'patchbay://editor-close-request'

export const readTextFile = (scope: FileScope, path: string) =>
  invoke<TextFile>('text_file_read', { ...scope, path })
export const saveTextFile = (scope: FileScope, file: TextFile, text: string) =>
  invoke<TextFile>('text_file_save', {
    ...scope,
    path: file.path,
    text,
    expected: file.fingerprint,
  })

let closeGuard: () => Promise<boolean> = async () => true
export function registerEditorGuard(guard: () => Promise<boolean>) {
  closeGuard = guard
  return () => {
    closeGuard = async () => true
  }
}
export const guardEditorClose = () => closeGuard()

/** Ask every other window to resolve its drafts before quitting the application. */
export async function guardAllEditorWindows() {
  const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const { emitTo, listen } = await import('@tauri-apps/api/event')
  for (const window of await getAllWebviewWindows()) {
    if (window.label === getCurrentWindow().label || !window.label.startsWith('component-'))
      continue
    const request = crypto.randomUUID()
    const reply = `patchbay://editor-close-${request}`
    let cleanup = () => {}
    const answer = new Promise<boolean>((resolve) => {
      void listen<boolean>(reply, (event) => resolve(event.payload))
        .then((unlisten) => {
          cleanup = unlisten
          void emitTo(window.label, EDITOR_CLOSE_REQUEST_EVENT, {
            reply,
            requester: getCurrentWindow().label,
          }).catch(() => resolve(false))
        })
        .catch(() => resolve(false))
    })
    // The prompt may stay open as long as the user needs to review their drafts.
    const allowed = await answer
    cleanup()
    if (!allowed) return false
  }
  return guardEditorClose()
}
