import { useStore } from '../store'
import { executeExtensionCommand } from './host'
import { evaluateWhen } from './when'
import { useWhenContext } from './whenContext'

export default function ExtensionMenu({
  slot,
  componentId,
}: {
  slot: string
  componentId?: string | null
}) {
  const menus = useStore((s) => s.menus)
  const commands = useStore((s) => s.commands)
  const context = useWhenContext(componentId)
  return (
    <>
      {(menus[slot] ?? [])
        .filter((m) => evaluateWhen(m.when, context))
        .map((entry) => {
          const command = commands.find((c) => c.id === entry.command)
          if (
            !command ||
            !evaluateWhen(command.when, context) ||
            (command.run && !context.component)
          )
            return null
          return (
            <button
              key={entry.command}
              data-extension-command={entry.command}
              onClick={() =>
                void executeExtensionCommand(entry.command, [], context.component?.id).catch((e) =>
                  useStore.getState().setMessage(String(e)),
                )
              }
            >
              {command.title}
            </button>
          )
        })}
    </>
  )
}
