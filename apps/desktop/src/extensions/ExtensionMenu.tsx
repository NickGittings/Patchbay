import { useContext } from 'react'
import { MenuItem, MenuSeparator } from '../components/Menu'
import { MenuOpens } from '../components/menuContext'
import { useExtensionCommands } from './commands'
import type { Story } from '../types'

/**
 * Extension commands contributed to `slot`, as buttons or, with `asMenuItems`, as items of the
 * enclosing `Menu` after a separator (when there are any). `separator` puts an `<hr>` before the
 * buttons, when there are any.
 */
export default function ExtensionMenu({
  slot,
  componentId,
  asMenuItems = false,
  separator = false,
  itemRole,
  story,
  args,
  className,
}: {
  slot: string
  /** For `stories/item`: the item `story.*` clauses see; commands receive `args`. */
  story?: Story | null
  args?: unknown[]
  className?: string
  componentId?: string | null
  asMenuItems?: boolean
  separator?: boolean
  /** For plain buttons inside a custom `role="menu"` container. */
  itemRole?: 'menuitem'
}) {
  // Inside a menu, re-read the component's files each time it opens (as the palette does).
  const opens = useContext(MenuOpens)
  const { entries, run } = useExtensionCommands(
    slot,
    componentId,
    asMenuItems ? opens : 0,
    story,
    args,
  )
  if (entries.length === 0) return null
  const Item = asMenuItems ? MenuItem : 'button'
  return (
    <>
      {asMenuItems ? <MenuSeparator /> : separator && <hr />}
      {entries.map((e) => (
        <Item
          key={e.id}
          role={asMenuItems ? undefined : itemRole}
          className={asMenuItems ? undefined : className}
          data-extension-command={e.id}
          onClick={() => run(e.id)}
        >
          {e.title}
        </Item>
      ))}
    </>
  )
}
