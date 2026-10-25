import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  usePanelRef,
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels'
import { useStore } from '../store'

/** Where Navigation's collapsible panels remember their open sizes, in the project's `panels`. */
const OPEN_SIZES = 'App-open'

/** Collapse a panel into a specific sibling without changing the other panels' sizes. */
export function collapsedInto(layout: Record<string, number>, id: string, fill: string) {
  if (!Object.hasOwn(layout, id) || !Object.hasOwn(layout, fill)) return undefined
  return { ...layout, [id]: 0, [fill]: layout[fill] + layout[id] }
}

/** Open a panel using only the space available in a specific sibling. */
export function expandedFrom(
  layout: Record<string, number>,
  id: string,
  fill: string,
  size: number,
) {
  if (!Object.hasOwn(layout, id) || !Object.hasOwn(layout, fill)) return undefined
  const delta = Math.min(Math.max(size - layout[id], 0), layout[fill])
  return { ...layout, [id]: layout[id] + delta, [fill]: layout[fill] - delta }
}

function openPanel(
  p: PanelImperativeHandle,
  id: string,
  openSizes: string,
  group?: GroupImperativeHandle | null,
  fill?: string,
  defaultSize?: number,
) {
  const remembered = useStore.getState().panels[openSizes]?.[id]
  const size = remembered || defaultSize
  const next =
    group &&
    fill !== undefined &&
    size !== undefined &&
    expandedFrom(group.getLayout(), id, fill, size)
  if (next) {
    group.setLayout(next)
    return
  }
  p.expand()
  if (remembered) p.resize(`${remembered}%`)
}

/**
 * Collapse panel `id` while it has nothing to show and expand it, at the size it had when it was
 * last collapsed, once it does or `reveal` changes. Returns the panel's props and whether it is
 * collapsed, including by the user dragging it shut; `onDragShut` runs then.
 */
export function useCollapsed(
  id: string,
  shown: boolean,
  reveal?: unknown,
  onDragShut?: () => void,
  openSizes = OPEN_SIZES,
  fill?: { group: RefObject<GroupImperativeHandle | null>; panel: string; defaultSize: number },
) {
  const panelRef = usePanelRef()
  const shownRef = useRef(shown)
  const [collapsed, setCollapsed] = useState(true)
  const [measured, setMeasured] = useState(false)
  const fillGroup = fill?.group
  const fillPanel = fill?.panel
  const defaultSize = fill?.defaultSize
  useLayoutEffect(() => {
    shownRef.current = shown
    const p = panelRef.current
    if (!p) return
    if (shown && p.isCollapsed())
      openPanel(p, id, openSizes, fillGroup?.current, fillPanel, defaultSize)
    else if (!shown && !p.isCollapsed()) {
      const size = p.getSize().asPercentage
      const s = useStore.getState()
      if (size > 0) s.setPanelLayout(openSizes, { ...s.panels[openSizes], [id]: size })
      const group = fillGroup?.current
      const next =
        group && fillPanel !== undefined && collapsedInto(group.getLayout(), id, fillPanel)
      if (next) group.setLayout(next)
      else p.collapse()
    }
  }, [panelRef, id, shown, reveal, openSizes, measured, fillGroup, fillPanel, defaultSize])
  const onResize = (size: PanelSize, _: unknown, prev: PanelSize | undefined) => {
    // A restored zero-size panel can report its first size after the mount layout effect.
    // Retry once then, without reopening panels the user subsequently drags shut.
    setMeasured(true)
    setCollapsed(size.asPercentage === 0)
    if (size.asPercentage === 0 && prev?.asPercentage && shownRef.current) onDragShut?.()
  }
  const expand = () => {
    const p = panelRef.current
    if (p) openPanel(p, id, openSizes, fillGroup?.current, fillPanel, defaultSize)
  }
  return { props: { panelRef, onResize, collapsible: true }, collapsed, expand }
}
