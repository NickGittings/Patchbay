import { MenuItem, MenuSeparator } from '../components/Menu'
import { useStore } from '../store'
import { executeExtensionCommand } from './host'
import { evaluateWhen } from './when'
import { useWhenContext } from './whenContext'

/**
 * Extension commands contributed to `slot`, as buttons or, with `as="menuitem"`, as items of the
 * enclosing `Menu` (after a separator, when there are any).
 */
export default function ExtensionMenu({
  slot,
  componentId,
  as = 'button',
}: {
  slot: string
  componentId?: string | null
  as?: 'button' | 'menuitem'
}) {
  const menus = useStore((s) => s.menus)
  const commands = useStore((s) => s.commands)
  const context = useWhenContext(componentId)
  const entries = (menus[slot] ?? []).flatMap((entry) => {
    if (!evaluateWhen(entry.when, context)) return []
    const command = commands.find((c) => c.id === entry.command)
    if (!command || !evaluateWhen(command.when, context) || (command.run && !context.component))
      return []
    return [{ id: entry.command, title: command.title }]
  })
  const run = (id: string) =>
    void executeExtensionCommand(id, [], context.component?.id).catch((e) =>
      useStore.getState().setMessage(String(e)),
    )

  if (as === 'menuitem')
    return entries.length === 0 ? null : (
      <>
        <MenuSeparator />
        {entries.map((e) => (
          <MenuItem key={e.id} data-extension-command={e.id} onClick={() => run(e.id)}>
            {e.title}
          </MenuItem>
        ))}
      </>
    )
  return (
    <>
      {entries.map((e) => (
        <button key={e.id} data-extension-command={e.id} onClick={() => run(e.id)}>
          {e.title}
        </button>
      ))}
    </>
  )
}
