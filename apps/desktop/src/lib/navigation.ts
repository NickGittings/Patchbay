import { editorOpen, terminalOpenReference } from './ipc'
import { useStore } from '../store'
import { sessionMetadata, type EditorTarget } from '../types'

export const EDITOR_SETTINGS_EVENT = 'patchbay:editor-settings'
export const FILE_SEARCH_EVENT = 'patchbay:file-search'
export const revealLabel = /mac/i.test(navigator.userAgent)
  ? 'Reveal in Finder'
  : /win/i.test(navigator.userAgent)
    ? 'Reveal in Explorer'
    : 'Reveal in file manager'

export function configureEditor(explanation = '') {
  window.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_EVENT, { detail: explanation }))
}
export function showFileSearch() {
  window.dispatchEvent(new Event(FILE_SEARCH_EVENT))
}
export function navigationError(error: unknown) {
  const message = String(error)
  if (message.includes('Editor unavailable:')) configureEditor(message)
  else useStore.getState().setMessage(message)
}
/** Capture originating workspace identity before an asynchronous editor request. */
export async function openInEditor(
  target: EditorTarget,
  scope?: { projectId: string; task: string | null; worktree?: string },
) {
  const s = useStore.getState()
  const projectId = scope?.projectId ?? s.project?.id
  if (!projectId) return
  const task = scope ? scope.task : s.activeTask
  try {
    await editorOpen(target, projectId, task, scope?.worktree)
  } catch (e) {
    if (useStore.getState().project?.id === projectId && useStore.getState().activeTask === task)
      navigationError(e)
  }
}
export async function openTerminalReference(sid: string, reference: string, generation?: number) {
  if (generation === undefined) return
  const origin = sessionMetadata.get(sid)
  const projectId = origin?.projectId ?? useStore.getState().project?.id
  const task = origin?.task ?? null
  try {
    await terminalOpenReference(sid, generation, reference)
  } catch (e) {
    const current = useStore.getState()
    if (current.project?.id === projectId && current.activeTask === task) navigationError(e)
  }
}
/** Compiler locations, including quoted filenames with spaces and Windows drive prefixes. */
export function terminalReferences(text: string) {
  const pattern =
    /(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:[A-Za-z]:)?[^\s:"'<>()[\]]+)(?::\d+(?::\d+)?|\(\d+,\d+\))/g
  return [...text.matchAll(pattern)].filter((m) => {
    const preceding = text.slice(Math.max(0, (m.index ?? 0) - 8), m.index)
    return !preceding.includes('://') && !m[0].includes('://')
  })
}
