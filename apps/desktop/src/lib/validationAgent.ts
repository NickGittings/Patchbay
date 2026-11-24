import { create } from 'zustand'
import { useStore } from '../store'
import type { PendingValidation, ProposedCheck } from '../types'
import { validationProposalClear, validationProposalRead } from './ipc'
import { mapEditsBlocked, flushMapSaves } from './mapSave'
import { graphActionIn } from './actions'
import { applyChecks } from './stackAgent'

/**
 * Checks the retired validation discovery agent proposed before run & test detection took over,
 * reviewed once more in the Activity panel. New checks come with run & test detection's proposal.
 */
export const useValidationProposals = create<{
  pending: Record<string, PendingValidation>
  busy: Record<string, boolean>
}>(() => ({ pending: {}, busy: {} }))

/** Submissions cleared (or being cleared), per project, which a stale read must not bring back. */
const cleared = new Map<string, string>()

const canEdit = (projectId: string) =>
  !!useStore.getState().projects[projectId] &&
  !mapEditsBlocked(useStore.getState().projects[projectId])

function setPending(projectId: string, pending: PendingValidation | null) {
  useValidationProposals.setState(({ pending: all }) => {
    const next = { ...all }
    if (pending) next[projectId] = pending
    else delete next[projectId]
    return { pending: next }
  })
}

function setBusy(projectId: string, busy: boolean) {
  useValidationProposals.setState((s) => ({ busy: { ...s.busy, [projectId]: busy } }))
}

/** Read `projectId`'s leftover submission; `null` when it couldn't be read. */
export async function readValidationProposal(projectId: string): Promise<boolean | null> {
  let pending: PendingValidation | null
  try {
    pending = await validationProposalRead(projectId)
  } catch {
    return null
  }
  const shown = !!pending && cleared.get(projectId) !== pending.id
  setPending(projectId, shown ? pending : null)
  return shown
}

/** Forget the reviewed submission; one already `wasApplied` is hidden even if that fails. */
export async function discardValidationProposal(projectId: string, id: string, wasApplied = false) {
  cleared.set(projectId, id)
  setBusy(projectId, true)
  if (useValidationProposals.getState().pending[projectId]?.id === id) setPending(projectId, null)
  try {
    await validationProposalClear(projectId, id).catch((e: unknown) => {
      if (!wasApplied) cleared.delete(projectId)
      useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    })
  } finally {
    setBusy(projectId, false)
  }
}

/** Apply the leftover checks as map edits, optionally running them in the active worktree. */
export async function applyValidationProposal(
  pending: PendingValidation,
  chosen: ProposedCheck[],
  projectId: string,
  run = false,
) {
  const s = useStore.getState()
  if (
    s.project?.id !== projectId ||
    !canEdit(projectId) ||
    useValidationProposals.getState().busy[projectId]
  )
    return
  if (
    run &&
    (s.graphActionBusy ||
      Object.values(s.taskActivities).some(
        (a) =>
          a.state === 'running' &&
          ['validate', 'validateChanged', 'validateSelected', 'environmentStart'].includes(
            a.action.kind,
          ),
      ))
  )
    return
  const task = s.activeTask
  const { count, components, skipped } = applyChecks(chosen, pending.componentIds)
  if (skipped.length)
    s.setMessage(`Left unapplied: ${skipped.join('; ')}`, undefined, undefined, 'warning')
  if (!count) return
  // Capture the updated map and active worktree before any asynchronous clearing or project switch.
  const project = useStore.getState().toProject()
  setBusy(projectId, true)
  try {
    if (!(await flushMapSaves(projectId))) {
      if (useStore.getState().project?.id === projectId)
        useStore
          .getState()
          .setMessage(
            'Checks were applied locally. Resolve the map save error or conflict before running or dismissing this proposal.',
            undefined,
            undefined,
            'warning',
          )
      return
    }
    if (!skipped.length) await discardValidationProposal(projectId, pending.id, true)
    if (run)
      await graphActionIn(projectId, task, project, {
        kind: 'validateSelected',
        componentIds: components,
      }).catch((e: unknown) => {
        if (useStore.getState().project?.id === projectId)
          useStore.getState().setMessage(String(e), undefined, undefined, 'error')
      })
  } finally {
    setBusy(projectId, false)
  }
}

let stop: (() => void) | undefined
/** Main window: read any leftover submission once each project's map can be edited. */
export function initializeValidationProposals(): () => void {
  if (stop) return stop
  const checked = new Set<string>()
  const opened = useStore.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.restoring === prev.restoring) return
    for (const id of checked) if (!s.projects[id]) checked.delete(id)
    const { pending } = useValidationProposals.getState()
    if (Object.keys(pending).some((id) => !s.projects[id]))
      useValidationProposals.setState({
        pending: Object.fromEntries(Object.entries(pending).filter(([id]) => s.projects[id])),
      })
    if (s.restoring) return
    for (const [id, entry] of Object.entries(s.projects))
      if (!mapEditsBlocked(entry) && !checked.has(id)) {
        checked.add(id)
        void readValidationProposal(id).then((shown) => shown === null && checked.delete(id))
      }
  })
  stop = () => {
    opened()
    stop = undefined
  }
  return stop
}
