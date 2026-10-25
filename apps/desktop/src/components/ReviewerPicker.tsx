import type { DeviceManifest } from '../types'
import Popover from './Popover'

/** Shared reviewer selection; saved assignments can also expose missing presets for removal. */
export default function ReviewerPicker({
  agents,
  selected,
  onChange,
  disabled = false,
  showMissing = false,
  dropdown = false,
  emptyLabel = 'Select reviewers',
}: {
  agents: DeviceManifest[]
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
  showMissing?: boolean
  dropdown?: boolean
  emptyLabel?: string
}) {
  const choices = agents.map((a) => ({ id: a.id, name: a.name }))
  if (showMissing)
    for (const id of selected)
      if (!agents.some((a) => a.id === id)) choices.push({ id, name: `${id} (not installed)` })
  const options = choices.map((a) => (
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
      <span>{a.name}</span>
    </label>
  ))
  if (!dropdown) return options
  const summary =
    selected.length > 1
      ? `${selected.length} agents selected`
      : (choices.find((a) => a.id === selected[0])?.name ?? emptyLabel)
  return (
    <Popover
      caret={false}
      className="reviewer-picker"
      listClassName="reviewer-options"
      label={<span className="reviewer-summary">{summary}</span>}
      title="Review agents"
      triggerLabel={`Review agents: ${summary}`}
      initialFocus={(list) =>
        list.querySelector<HTMLInputElement>('input:not(:disabled)') ?? undefined
      }
    >
      {options.length ? options : <p className="hint">No agent presets</p>}
    </Popover>
  )
}
