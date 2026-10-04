import { useStore } from '../store'
import { executeExtensionCommand } from './host'
import { evaluateWhen } from './when'
import { useWhenContext } from './whenContext'

/** Extension commands contributed to `slot` whose `when` clauses hold, and a way to run one. */
export function useExtensionCommands(slot: string, componentId?: string | null) {
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
  return { entries, run }
}
