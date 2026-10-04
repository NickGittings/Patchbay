import { useContext } from 'react'
import { MenuItem, MenuSeparator } from '../components/Menu'
import { MenuOpen } from '../components/menuContext'
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
  const menuOpen = useContext(MenuOpen)
  const { entries, run } = useExtensionCommands(slot, componentId, asMenuItems && menuOpen)
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
