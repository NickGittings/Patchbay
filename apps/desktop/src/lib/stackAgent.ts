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
import { revealTerminal } from './attention'
import { onStackProposals, stackProposalClear, stackProposalRead } from './ipc'
import { mapEditsBlocked } from './mapSave'
import { selectPanel } from './rail'
import { launching, startMapAgent } from './sessions'

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
export async function startStackAgent(projectId: string, preset: TerminalSpec) {
  const sid = stackAgentSession(projectId)
  const s = useStore.getState()
  if (s.sessions[sid]?.running || launching(sid)) {
    revealTerminal({ sid, componentId: MAP_SCOPE })
    return
  }
  const previous = s.runtimeTerminals[sid]
  s.addRuntimeTerminal(sid, {
    projectId,
    taskId: null,
    componentId: MAP_SCOPE,
    terminal: {
      id: STACK_AGENT_TERMINAL,
      name: `Detect stack · ${preset.name}`,
      kind: 'agent',
      command: preset.command,
    },
  })
  const ours = useStore.getState().runtimeTerminals[sid]
  let started = false
  try {
    started = await startMapAgent(projectId, preset, STACK_AGENT_TERMINAL)
  } finally {
    if (!started && useStore.getState().runtimeTerminals[sid] === ours)
      useStore.setState((st) => {
        const runtimeTerminals = { ...st.runtimeTerminals }
        if (previous) runtimeTerminals[sid] = previous
        else delete runtimeTerminals[sid]
        return { runtimeTerminals }
      })
  }
  if (started && useStore.getState().project?.id === projectId)
    revealTerminal({ sid, componentId: MAP_SCOPE })
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
 * Mark the chosen terminals Development with their ready text (adding the proposed new ones) and
 * put their components in the proposed stack, an ordinary map edit; a stack of the same name
 * gains them. Only for the active project, whose map the store holds.
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
    let id = t.terminal ?? null
    if (id && !node.data.terminals.some((x) => x.id === id)) continue
    id ??= s.addTerminal(t.component, null, false)
    s.updateTerminal(t.component, id, {
      ...(t.terminal ? {} : { name: t.name ?? 'Dev', command: t.command ?? '', kind: 'task' }),
      action: 'development',
      readyWhen: t.readyWhen.trim(),
    })
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
