import { requireDeviceAuth } from './providerAuth'
import { useStore } from '../store'
import { TASK_ROOT_SCOPE, sessionId, type DeviceManifest, type TerminalSpec } from '../types'
import { startTerminal } from './sessions'

/** A blank command, typed in the terminal's own editor. */
export const CUSTOM: DeviceManifest = {
  id: 'custom',
  name: 'Custom terminal',
  kind: 'task',
  command: '',
  category: 'terminal',
  source: 'builtin',
}

/** What the Add terminal dialog adds: a preset (`null` for a custom command) or a saved terminal. */
export type TaskTerminalChoice =
  { kind: 'device'; device: DeviceManifest | null } | { kind: 'saved'; terminalId: string }

/** A terminal already running this preset, so adding it again reuses that one. */
function matching(
  terminals: TerminalSpec[],
  device: Pick<TerminalSpec, 'command' | 'kind' | 'adapter'>,
) {
  return terminals.find(
    (t) =>
      t.kind === device.kind &&
      t.command.trim() === device.command.trim() &&
      (t.adapter ?? null) === (device.adapter ?? null),
  )
}

function focus(componentId: string, terminalId: string, task: string | null) {
  const s = useStore.getState()
  if (task !== s.activeTask) return
  s.setMaximizedTerminal(null)
  s.setActiveSession(sessionId(componentId, terminalId, task))
}

/** One implementation agent coordinates the task's complete selected scope. */
export async function startTaskAgent(
  device: DeviceManifest,
  task = useStore.getState().activeTask,
) {
  const s = useStore.getState()
  const match = matching(s.rootTerminals, device)
  if (!match || !s.sessions[sessionId(TASK_ROOT_SCOPE, match.id, task)]?.running)
    await requireDeviceAuth(device, s.project?.id, task)
  if (
    useStore.getState().project?.id !== s.project?.id ||
    useStore.getState().activeTask !== s.activeTask
  )
    throw new Error('The worktree changed. Click Start again in the worktree you want.')
  const terminalId = match?.id ?? s.addRootTerminal(device)
  focus(TASK_ROOT_SCOPE, terminalId, task)
  return startTerminal(TASK_ROOT_SCOPE, terminalId, task)
}

/**
 * Adds a terminal to the active task at the worktree root or in a component. Presets added to a
 * component are saved on the map (reusing a matching one); agents start, other terminals wait.
 */
export async function addTaskTerminal(target: string, choice: TaskTerminalChoice) {
  const s = useStore.getState()
  const device = choice.kind === 'device' ? choice.device : null
  if (target === TASK_ROOT_SCOPE) {
    if (choice.kind === 'saved') return
    if (device?.kind === 'agent') return startTaskAgent(device)
    if (device) await requireDeviceAuth(device, s.project?.id, s.activeTask)
    if (
      useStore.getState().project?.id !== s.project?.id ||
      useStore.getState().activeTask !== s.activeTask
    )
      throw new Error('The worktree changed. Your terminal selection was kept.')
    s.addRootTerminal(device ?? CUSTOM)
    return
  }
  const node = s.nodes.find((n) => n.id === target)
  if (!node) return
  const preset =
    device ??
    (choice.kind === 'saved'
      ? node.data.terminals.find((t) => t.id === choice.terminalId)
      : undefined)
  if (preset) {
    const match = matching(node.data.terminals, preset)
    if (!match || !s.sessions[sessionId(target, match.id, s.activeTask)]?.running)
      await requireDeviceAuth(preset, s.project?.id, s.activeTask, target)
  }
  if (
    useStore.getState().project?.id !== s.project?.id ||
    useStore.getState().activeTask !== s.activeTask
  )
    throw new Error('The worktree changed. Your terminal selection was kept.')
  const terminalId =
    choice.kind === 'saved'
      ? choice.terminalId
      : ((device && matching(node.data.terminals, device)?.id) ??
        s.addTerminal(target, device, false))
  s.addTaskComponentTerminal(target, terminalId)
  if (device?.kind !== 'agent') return
  const task = s.activeTask
  focus(target, terminalId, task)
  return startTerminal(target, terminalId, task)
}
