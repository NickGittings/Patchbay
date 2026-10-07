import { TASK_ROOT_SCOPE } from '../types'
import { useStore } from '../store'

/** Adds a saved terminal (a device preset or a custom command) to a component. */
export default function AddTerminalSelect({
  componentId,
  className = 'add-terminal',
}: {
  componentId: string
  className?: string
}) {
  const devices = useStore((s) => s.devices)
  const addTerminal = useStore((s) => s.addTerminal)
  return (
    <select
      className={className}
      value=""
      aria-label="Add terminal"
      onChange={(e) => {
        const v = e.target.value
        const s = useStore.getState()
        if (
          s.view === 'implementation' &&
          componentId !== TASK_ROOT_SCOPE &&
          !s.highlighted.includes(componentId)
        )
          s.toggleHighlight(componentId)
        const add =
          componentId === TASK_ROOT_SCOPE
            ? (_id: string, device: Parameters<typeof addTerminal>[1]) =>
                useStore.getState().addRootTerminal(device)
            : addTerminal
        add(componentId, v === 'custom' ? null : (devices.find((d) => d.id === v) ?? null))
      }}
    >
      <option value="" disabled>
        + Add terminal…
      </option>
      <option value="shell">Shell</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} {d.command ? `— ${d.command}` : ''}
        </option>
      ))}
      <option value="custom">Custom terminal</option>
    </select>
  )
}
