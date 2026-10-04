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
