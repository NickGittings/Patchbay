import { planWrite } from './ipc'

/** Editor drafts survive view, task and project switches. */
export const planDrafts = new Map<string, { text: string; base: string; overwrite: boolean }>()
const saving = new Map<string, Promise<void>>()

/** Save edits before briefing implementation agents; conflicts require review in Plan. */
export function savePlanDraft(projectId: string, task: string | null): Promise<void> {
  const key = `${projectId}\n${task ?? ''}`
  const running = saving.get(key)
  if (running) return running
  const request = (async () => {
    let draft = planDrafts.get(key)
    while (draft) {
      const saved = await planWrite(projectId, task ?? undefined, draft.text, draft.base)
      if (!saved)
        throw new Error(
          'The saved plan changed. Review and save your edits in Plan before starting an agent.',
        )
      const latest = planDrafts.get(key)
      if (latest === draft) planDrafts.delete(key)
      else if (latest) planDrafts.set(key, { ...latest, base: draft.text })
      draft = planDrafts.get(key)
    }
  })().finally(() => saving.delete(key))
  saving.set(key, request)
  return request
}
