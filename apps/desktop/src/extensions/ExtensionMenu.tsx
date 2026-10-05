import { useContext } from 'react'
import { MenuItem, MenuSeparator } from '../components/Menu'
import { MenuOpens } from '../components/menuContext'
import { useExtensionCommands } from './commands'

/**
 * Extension commands contributed to `slot`, as buttons or, with `asMenuItems`, as items of the
 * enclosing `Menu` after a separator (when there are any).
 */
export default function ExtensionMenu({
  slot,
  componentId,
  asMenuItems = false,
}: {
  slot: string
  componentId?: string | null
  asMenuItems?: boolean
}) {
  // Inside a menu, re-read the component's files each time it opens (as the palette does).
  const opens = useContext(MenuOpens)
  const { entries, run } = useExtensionCommands(slot, componentId, asMenuItems ? opens : 0)
  if (entries.length === 0) return null
  const Item = asMenuItems ? MenuItem : 'button'
  return (
    <>
      {asMenuItems && <MenuSeparator />}
      {entries.map((e) => (
        <Item key={e.id} data-extension-command={e.id} onClick={() => run(e.id)}>
          {e.title}
        </Item>
      ))}
    </>
  )
}
