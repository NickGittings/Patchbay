import { useState } from 'react'
import { addTaskTerminal, type TaskTerminalChoice } from '../../lib/implement'
import { agentDevices } from '../../lib/plan'
import { useStore } from '../../store'
import { TASK_ROOT_SCOPE } from '../../types'

interface Option {
  key: string
  name: string
  command: string
  choice: TaskTerminalChoice
}

/**
 * Adds a terminal to the active task: pick the worktree root or a component, then an agent, one
 * of the component's saved terminals, a preset or a custom command.
 */
export default function AddTaskTerminal() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="header-action add-task-terminal-button" onClick={() => setOpen(true)}>
        ＋ Add terminal
      </button>
      {open && <AddTaskTerminalDialog close={() => setOpen(false)} />}
    </>
  )
}

function AddTaskTerminalDialog({ close }: { close: () => void }) {
  const devices = useStore((s) => s.devices)
  const nodes = useStore((s) => s.nodes)
  const added = useStore((s) => s.componentTerminals)
  const [target, setTarget] = useState(() => {
    const selected = useStore.getState().selectedId
    return nodes.some((n) => n.id === selected) ? selected! : TASK_ROOT_SCOPE
  })
  const node = nodes.find((n) => n.id === target)
  const device = (d: (typeof devices)[number]): Option => ({
    key: `device\n${d.id}`,
    name: d.name,
    command: d.command,
    choice: { kind: 'device', device: d },
  })
  const groups: { label: string; options: Option[] }[] = [
    { label: 'Agents', options: agentDevices(devices).map(device) },
    {
      label: node ? `Saved on ${node.data.name}` : '',
      options: (node?.data.terminals ?? [])
        .filter(
          (t) =>
            t.kind !== 'agent' &&
            !added.some((a) => a.componentId === node!.id && a.terminalId === t.id),
        )
        .map((t): Option => ({
          key: `saved\n${t.id}`,
          name: t.name,
          command: t.command,
          choice: { kind: 'saved', terminalId: t.id },
        })),
    },
    { label: 'Presets', options: devices.filter((d) => d.kind !== 'agent').map(device) },
    {
      label: 'Custom',
      options: [
        {
          key: 'custom',
          name: 'Custom command',
          command: '',
          choice: { kind: 'device' as const, device: null },
        },
      ],
    },
  ].filter((g) => g.options.length)
  const options = groups.flatMap((g) => g.options)
  const [picked, setPicked] = useState(options[0]?.key ?? '')
  // A saved terminal of another component isn't offered once the target changes.
  const chosen = options.find((o) => o.key === picked) ?? options[0]
  const agent = chosen?.choice.kind === 'device' && chosen.choice.device?.kind === 'agent'
  const submit = () => {
    if (!chosen) return
    close()
    void addTaskTerminal(target, chosen.choice).catch((e) =>
      useStore.getState().setMessage(String(e)),
    )
  }
  return (
    <div className="extension-overlay centered" onClick={close}>
      <form
        className="extensions-panel task-dialog add-task-terminal"
        role="dialog"
        aria-modal="true"
        aria-label="Add terminal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2>Add terminal</h2>
        <label>
          Where
          <select
            autoFocus
            aria-label="Where"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value={TASK_ROOT_SCOPE}>Project root</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.data.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Terminal
          <select
            aria-label="Terminal"
            value={chosen?.key ?? ''}
            onChange={(e) => setPicked(e.target.value)}
          >
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.name}
                    {o.command && o.command !== o.name.toLowerCase() ? ` — ${o.command}` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="row">
          <span className="spacer" />
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!chosen}>
            {agent ? 'Start agent' : 'Add terminal'}
          </button>
        </div>
      </form>
    </div>
  )
}
