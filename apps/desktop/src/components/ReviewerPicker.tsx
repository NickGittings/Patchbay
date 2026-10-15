import type { DeviceManifest } from '../types'

/** Shared reviewer selection; saved assignments can also expose missing presets for removal. */
export default function ReviewerPicker({
  agents,
  selected,
  onChange,
  disabled = false,
  showMissing = false,
}: {
  agents: DeviceManifest[]
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  showMissing?: boolean
}) {
  const choices = agents.map((a) => ({ id: a.id, name: a.name }))
  if (showMissing)
    for (const id of selected)
      if (!agents.some((a) => a.id === id)) choices.push({ id, name: `${id} (not installed)` })
  return choices.map((a) => (
    <label key={a.id}>
      <input
        type="checkbox"
        value={a.id}
        disabled={disabled}
        checked={selected.includes(a.id)}
        onChange={(e) =>
          onChange(e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id))
        }
      />{' '}
      {a.name}
    </label>
  ))
}
