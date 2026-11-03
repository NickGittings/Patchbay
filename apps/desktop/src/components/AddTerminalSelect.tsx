import { useState } from 'react'
import { requireDeviceAuth } from '../lib/providerAuth'
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
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async (value: string) => {
    if (busy) return
    setPicked(value)
    setBusy(true)
    const before = useStore.getState()
    try {
      const device = devices.find((d) => d.id === value) ?? null
      if (device)
        await requireDeviceAuth(device, before.project?.id, before.activeTask, componentId)
      const current = useStore.getState()
      if (current.project?.id !== before.project?.id || current.activeTask !== before.activeTask)
        throw new Error('The worktree changed. Your preset selection was kept.')
      current.addTerminal(componentId, device)
      setPicked('')
    } catch (e) {
      useStore.getState().setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <select
        className={className}
        value={picked}
        disabled={busy}
        aria-label="Add terminal"
        onChange={(e) => void add(e.target.value)}
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
      {picked && (
        <button disabled={busy} onClick={() => void add(picked)}>
          Add terminal
        </button>
      )}
    </>
  )
}
