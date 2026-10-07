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
        addTerminal(componentId, v === 'custom' ? null : (devices.find((d) => d.id === v) ?? null))
      }}
    >
      <option value="" disabled>
        + Add terminal…
      </option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} {d.command ? `— ${d.command}` : ''}
        </option>
      ))}
      <option value="custom">Custom command</option>
    </select>
  )
}
