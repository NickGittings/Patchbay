import { MenuItem, MenuSeparator } from '../components/Menu'
import { useExtensionCommands } from './commands'

export default function ExtensionMenu({
  slot,
  componentId,
}: {
  slot: string
  componentId?: string | null
}) {
  const { entries, run } = useExtensionCommands(slot, componentId)
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

/** The same commands as items of the enclosing `Menu`, after a separator when there are any. */
export function ExtensionMenuItems({ slot }: { slot: string }) {
  const { entries, run } = useExtensionCommands(slot)
  if (entries.length === 0) return null
  return (
    <>
      <MenuSeparator />
      {entries.map((e) => (
        <MenuItem key={e.id} data-extension-command={e.id} onClick={() => run(e.id)}>
          {e.title}
        </MenuItem>
      ))}
    </>
  )
}
