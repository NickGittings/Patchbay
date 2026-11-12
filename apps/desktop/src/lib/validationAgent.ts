import { create } from 'zustand'
import { useStore } from '../store'
import {
  MAP_SCOPE,
  VALIDATION_AGENT_TERMINAL,
  sessionId,
  type PendingValidation,
  type ProposedValidationCheck,
  type TerminalSpec,
} from '../types'
import { startDetectionAgent } from './dependencies'
import { onValidationProposals, validationProposalClear, validationProposalRead } from './ipc'
import { mapEditsBlocked, flushMapSaves } from './mapSave'
import { selectPanel } from './rail'
import { graphActionIn } from './actions'

/** The validation each open project's detection agent proposed, awaiting review in the Validation panel. */
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

/** Each project's latest read, and the newest one whose result was applied. */
const requested = new Map<string, number>()
const applied = new Map<string, number>()

/**
 * Read `projectId`'s waiting submission; returns whether one is waiting, or `null` when it
 * couldn't be read, leaving whatever is shown. A read older than one already applied may predate
 * a newer submission, so it is ignored.
 */
async function readValidationProposal(projectId: string): Promise<boolean | null> {
  const seq = (requested.get(projectId) ?? 0) + 1
  requested.set(projectId, seq)
  let pending: PendingValidation | null
  try {
    pending = await validationProposalRead(projectId)
  } catch {
    return null
  }
  if (seq <= (applied.get(projectId) ?? 0))
    return !!useValidationProposals.getState().pending[projectId]
  applied.set(projectId, seq)
  const shown = !!pending && cleared.get(projectId) !== pending.id
  setPending(projectId, shown ? pending : null)
  return shown
}

/** Read `projectId`'s waiting submission; returns whether one is waiting (or still shown). */
export async function refreshValidationProposal(projectId: string): Promise<boolean> {
  return (
    (await readValidationProposal(projectId)) ??
    !!useValidationProposals.getState().pending[projectId]
  )
}

export const validationAgentSession = (projectId: string) =>
  sessionId(MAP_SCOPE, VALIDATION_AGENT_TERMINAL, null, projectId)

/** Start the validation detection agent with `preset`; one already running is shown instead. */
export function startValidationAgent(
  projectId: string,
  preset: TerminalSpec,
  componentIds: string[],
) {
  return startDetectionAgent(projectId, preset, {
    terminalId: VALIDATION_AGENT_TERMINAL,
    label: 'Validation discovery',
    tab: 'Configure checks',
    componentIds,
  })
}

/**
 * Forget the reviewed submission, unless a newer one replaced it, then show any newer one. One
 * already `wasApplied` is hidden at once and stays so even when it can't be forgotten, and the
 * review stays busy until the read after the clear, so it isn't applied twice.
 */
export async function discardValidationProposal(projectId: string, id: string, wasApplied = false) {
  cleared.set(projectId, id)
  setBusy(projectId, true)
  if (wasApplied && useValidationProposals.getState().pending[projectId]?.id === id)
    setPending(projectId, null)
  try {
    await validationProposalClear(projectId, id).catch((e: unknown) => {
      if (wasApplied)
        useStore
          .getState()
          .setMessage(
            `Applied the validation, but couldn’t forget the proposal: ${e}`,
            undefined,
            undefined,
            'error',
          )
      else {
        cleared.delete(projectId)
        useStore.getState().setMessage(String(e), undefined, undefined, 'error')
      }
    })
    await refreshValidationProposal(projectId)
  } finally {
    setBusy(projectId, false)
  }
}

/** Apply additive map edits after checking the discovery snapshots against the current map. */
export async function applyValidationProposal(
  pending: PendingValidation,
  chosen: ProposedValidationCheck[],
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
  const skipped: string[] = []
  let count = 0
  for (const t of chosen) {
    const node = useStore.getState().nodes.find((n) => n.id === t.component)
    const stale = () =>
      skipped.push(`${t.component} › ${t.name ?? t.terminal}: folder, command or terminal changed`)
    if (!node || node.data.path !== t.path || !pending.componentIds.includes(t.component)) {
      stale()
      continue
    }
    const terminals = node.data.terminals
    const current = t.terminal
      ? terminals.find((x) => x.id === t.terminal)
      : terminals.find(
          (x) =>
            x.command === t.command &&
            x.kind === 'task' &&
            (x.action === null || x.action === undefined || x.action === 'validation'),
        )
    if (current?.action === 'validation' && current.command === t.command) {
      count++
      continue
    }
    if (t.terminal && !current) {
      stale()
      continue
    }
    if (current && (current.kind !== 'task' || current.action || current.command !== t.command)) {
      stale()
      continue
    }
    if (
      !current &&
      terminals.some((x) => x.name.trim().toLowerCase() === t.name?.trim().toLowerCase())
    ) {
      stale()
      continue
    }
    s.updateTerminal(t.component, current?.id ?? s.addTerminal(t.component, null, false), {
      name: current?.name ?? t.name ?? 'Check',
      command: t.command,
      kind: 'task',
      action: 'validation',
    })
    count++
  }
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
    if (run) {
      try {
        await graphActionIn(projectId, task, project, {
          kind: 'validateSelected',
          componentIds: pending.componentIds,
        })
      } catch (e) {
        if (useStore.getState().project?.id === projectId)
          useStore.getState().setMessage(String(e), undefined, undefined, 'error')
      }
    }
  } finally {
    setBusy(projectId, false)
  }
}

let stop: (() => void) | undefined
/** Main window: load waiting submissions as projects open, and point to new ones. */
export function initializeValidationProposals(): () => void {
  if (stop) return stop
  const unlisten = onValidationProposals(({ projectId }) => {
    void refreshValidationProposal(projectId).then((shown) => {
      const s = useStore.getState()
      if (shown && s.project?.id === projectId && s.utilityPanel !== 'activity')
        s.setMessage('Validation discovery proposed checks.', false, {
          label: 'Review',
          projectId,
          run: () => selectPanel('activity'),
        })
    })
  })
  const checked = new Set<string>()
  const opened = useStore.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.restoring === prev.restoring) return
    for (const id of checked)
      if (!s.projects[id] || mapEditsBlocked(s.projects[id])) checked.delete(id)
    const { pending } = useValidationProposals.getState()
    if (Object.keys(pending).some((id) => !s.projects[id]))
      useValidationProposals.setState({
        pending: Object.fromEntries(Object.entries(pending).filter(([id]) => s.projects[id])),
      })
    if (s.restoring) return
    // As dependency detection's: once the project's map can be edited, and again after a failed
    // read, at the next project change.
    for (const [id, entry] of Object.entries(s.projects))
      if (!mapEditsBlocked(entry) && !checked.has(id)) {
        checked.add(id)
        void readValidationProposal(id).then((shown) => shown === null && checked.delete(id))
      }
  })
  stop = () => {
    opened()
    void unlisten.then((f) => f())
    stop = undefined
  }
  return stop
}
