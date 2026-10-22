import { useLayoutEffect, useRef, useState } from 'react'
import { usePanelRef, type PanelImperativeHandle, type PanelSize } from 'react-resizable-panels'
import { useStore } from '../store'

/** Where Navigation's collapsible panels remember their open sizes, in the project's `panels`. */
const OPEN_SIZES = 'App-open'

function openPanel(p: PanelImperativeHandle, id: string, openSizes: string) {
  p.expand()
  const size = useStore.getState().panels[openSizes]?.[id]
  if (size) p.resize(`${size}%`)
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
) {
  const panelRef = usePanelRef()
  const shownRef = useRef(shown)
  const [collapsed, setCollapsed] = useState(true)
  const [measured, setMeasured] = useState(false)
  useLayoutEffect(() => {
    shownRef.current = shown
    const p = panelRef.current
    if (!p) return
    if (shown && p.isCollapsed()) openPanel(p, id, openSizes)
    else if (!shown && !p.isCollapsed()) {
      const size = p.getSize().asPercentage
      const s = useStore.getState()
      if (size > 0) s.setPanelLayout(openSizes, { ...s.panels[openSizes], [id]: size })
      p.collapse()
    }
  }, [panelRef, id, shown, reveal, openSizes, measured])
  const onResize = (size: PanelSize, _: unknown, prev: PanelSize | undefined) => {
    // A restored zero-size panel can report its first size after the mount layout effect.
    // Retry once then, without reopening panels the user subsequently drags shut.
    setMeasured(true)
    setCollapsed(size.asPercentage === 0)
    if (size.asPercentage === 0 && prev?.asPercentage && shownRef.current) onDragShut?.()
  }
  return { props: { panelRef, onResize, collapsible: true }, collapsed }
}
