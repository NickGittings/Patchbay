import { create } from 'zustand'
import { useStore } from '../store'
import {
  MAP_SCOPE,
  STACK_AGENT_TERMINAL,
  sessionId,
  type PendingStack,
  type ProposedStackTerminal,
  type TerminalSpec,
} from '../types'
import { startDetectionAgent } from './dependencies'
import { onStackProposals, stackProposalClear, stackProposalRead } from './ipc'
import { mapEditsBlocked } from './mapSave'
import { selectPanel } from './rail'
import { proposedPatch } from './stack'

/** The stack each open project's detection agent proposed, awaiting review in the Stack panel. */
export const useStackProposals = create<{
  pending: Record<string, PendingStack>
  busy: Record<string, boolean>
}>(() => ({ pending: {}, busy: {} }))

/** Submissions cleared (or being cleared), per project, which a stale read must not bring back. */
const cleared = new Map<string, string>()

const canEdit = (projectId: string) =>
  !!useStore.getState().projects[projectId] &&
  !mapEditsBlocked(useStore.getState().projects[projectId])

function setPending(projectId: string, pending: PendingStack | null) {
  useStackProposals.setState(({ pending: all }) => {
    const next = { ...all }
    if (pending) next[projectId] = pending
    else delete next[projectId]
    return { pending: next }
  })
}

function setBusy(projectId: string, busy: boolean) {
  useStackProposals.setState((s) => ({ busy: { ...s.busy, [projectId]: busy } }))
}

/** Read `projectId`'s waiting submission; returns whether one is waiting. */
export async function refreshStackProposal(projectId: string): Promise<boolean> {
  const pending = await stackProposalRead(projectId).catch(() => null)
  const shown = !!pending && cleared.get(projectId) !== pending.id
  setPending(projectId, shown ? pending : null)
  return shown
}

export const stackAgentSession = (projectId: string) =>
  sessionId(MAP_SCOPE, STACK_AGENT_TERMINAL, null, projectId)

/** Start the stack detection agent with `preset`; one already running is shown instead. */
export function startStackAgent(projectId: string, preset: TerminalSpec) {
  return startDetectionAgent(projectId, preset, {
    terminalId: STACK_AGENT_TERMINAL,
    label: 'Stack detection',
    tab: 'Detect stack',
  })
}

/** Forget the reviewed submission, unless a newer one replaced it, then show any newer one. */
export async function discardStackProposal(projectId: string, id: string) {
  cleared.set(projectId, id)
  setBusy(projectId, true)
  try {
    await stackProposalClear(projectId, id)
  } catch (e) {
    cleared.delete(projectId)
    useStore.getState().setMessage(String(e))
  } finally {
    setBusy(projectId, false)
  }
  await refreshStackProposal(projectId)
}

/**
 * Mark the chosen terminals Development with their ready text, when the agent gives one (adding
 * the proposed new ones; Validation terminals are left out, `proposedPatch`), and put their
 * components in the proposed stack, an ordinary map edit; a stack of the same name gains them.
 * Only for the active project, whose map the store holds.
 */
export async function applyStackProposal(
  pending: PendingStack,
  chosen: ProposedStackTerminal[],
  projectId: string,
) {
  const s = useStore.getState()
  if (s.project?.id !== projectId || !canEdit(projectId)) return
  const members: string[] = []
  for (const t of chosen) {
    const node = useStore.getState().nodes.find((n) => n.id === t.component)
    if (!node) continue
    const current = t.terminal ? node.data.terminals.find((x) => x.id === t.terminal) : undefined
    if (t.terminal && !current) continue
    // The backend refuses Validation terminals too, but one may have become so since.
    const patch = proposedPatch(t, current)
    if (!patch) continue
    s.updateTerminal(t.component, current?.id ?? s.addTerminal(t.component, null, false), patch)
    if (!members.includes(t.component)) members.push(t.component)
  }
  const existing = useStore.getState().groups.find((g) => g.name === pending.name)
  if (existing)
    s.updateGroup(existing.id, {
      componentIds: [...new Set([...existing.componentIds, ...members])],
      orderedStartup: pending.orderedStartup,
    })
  else if (members.length) s.addGroup(pending.name, members, pending.orderedStartup)
  await discardStackProposal(projectId, pending.id)
}

let stop: (() => void) | undefined
/** Main window: load waiting submissions as projects open, and point to new ones. */
export function initializeStackProposals(): () => void {
  if (stop) return stop
  const unlisten = onStackProposals(({ projectId }) => {
    void refreshStackProposal(projectId).then((shown) => {
      const s = useStore.getState()
      if (shown && s.project?.id === projectId && s.utilityPanel !== 'stack')
        s.setMessage('Stack detection proposed a stack.', false, {
          label: 'Review',
          projectId,
          run: () => selectPanel('stack'),
        })
    })
  })
  const checked = new Set<string>()
  const opened = useStore.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.restoring === prev.restoring) return
    for (const id of checked) if (!s.projects[id]) checked.delete(id)
    const { pending } = useStackProposals.getState()
    if (Object.keys(pending).some((id) => !s.projects[id]))
      useStackProposals.setState({
        pending: Object.fromEntries(Object.entries(pending).filter(([id]) => s.projects[id])),
      })
    if (s.restoring) return
    for (const id of Object.keys(s.projects))
      if (!checked.has(id)) {
        checked.add(id)
        void refreshStackProposal(id)
      }
  })
  stop = () => {
    opened()
    void unlisten.then((f) => f())
    stop = undefined
  }
  return stop
}
