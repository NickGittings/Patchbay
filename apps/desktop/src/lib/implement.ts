import { useStore } from '../store'
import type { DeviceManifest } from '../types'
import { startTerminal } from './sessions'

/**
 * Start `device`'s agent in each component: reuse a terminal already running
 * its command with the same adapter, otherwise add one to the map (saved like
 * any other edit) without moving the dock's focus.
 */
export function startAgentsIn(
  componentIds: string[],
  device: DeviceManifest,
  task?: string | null,
): Promise<void[]> {
  const command = device.command.trim()
  return Promise.all(
    componentIds.map((id) => {
      const s = useStore.getState()
      const node = s.nodes.find((n) => n.id === id)
      if (!node) return Promise.resolve()
      const existing = node.data.terminals.find(
        (t) =>
          t.kind === 'agent' &&
          t.command.trim() === command &&
          (t.adapter ?? null) === (device.adapter ?? null),
      )
      const terminalId = existing?.id ?? s.addTerminal(id, device, false)
      return startTerminal(id, terminalId, task)
    }),
  )
}
