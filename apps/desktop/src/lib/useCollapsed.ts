import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  usePanelRef,
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels'
import { useStore } from '../store'
import { PANEL_OPEN_SIZES, collapsedInto, expandedFrom } from './panelLayout'
import { canTransitionPanels, transitionPanels } from './panelTransition'

/** Whether the panel is collapsed, or undefined while its group has no layout to tell. */
function collapsedNow(p: PanelImperativeHandle) {
  try {
    return p.isCollapsed()
  } catch {
    return undefined
  }
}

/**
 * Remember the open width before collapsing, optionally giving it to a specific sibling. Returns
 * whether the panel is collapsed afterwards.
 */
export function closePanel(
  p: PanelImperativeHandle,
  id: string,
  openSizes: string,
  group?: GroupImperativeHandle | null,
  fill?: string,
) {
  if (p.isCollapsed()) return true
  const size = p.getSize().asPercentage
  const s = useStore.getState()
  if (size > 0) s.setPanelLayout(openSizes, { ...s.panels[openSizes], [id]: size })
  const next = group && fill !== undefined && collapsedInto(group.getLayout(), id, fill)
  if (next) group.setLayout(next)
  else p.collapse()
  return p.isCollapsed()
}

export function openPanel(
  p: PanelImperativeHandle,
  id: string,
  openSizes: string,
  group?: GroupImperativeHandle | null,
  fill?: string,
  defaultSize?: number,
  minSize = 0,
) {
  const remembered = useStore.getState().panels[openSizes]?.[id]
  const size = remembered || defaultSize
  const next =
    group &&
    fill !== undefined &&
    size !== undefined &&
    expandedFrom(group.getLayout(), id, fill, size, minSize)
  if (next) {
    group.setLayout(next)
    return
  }
  p.expand()
  if (size) p.resize(`${Math.max(size, minSize)}%`)
}

interface Visibility {
  shown: boolean
  reveal: unknown
}

/** A restored or user-collapsed panel stays shut until explicitly shown or revealed. */
export function shouldOpenPanel(
  current: Visibility,
  previous: Visibility | undefined,
  keepCollapsed: boolean,
) {
  return (
    current.shown &&
    (!keepCollapsed || (current.reveal != null && !Object.is(current.reveal, previous?.reveal)))
  )
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
  openSizes = PANEL_OPEN_SIZES,
  fill?: {
    group: RefObject<GroupImperativeHandle | null>
    panel: string
    defaultSize: number
    minSize?: number
  },
  { keepCollapsed = false, onReveal }: { keepCollapsed?: boolean; onReveal?: () => void } = {},
) {
  const panelRef = usePanelRef()
  const visibilityRef = useRef<Visibility | undefined>(undefined)
  // Set while a request could not be handled yet, so the next measurement retries it.
  const retryRef = useRef(false)
  const measuredRef = useRef(false)
  // Set while a gliding open or close waits for its transition to apply it, then for the one run
  // after it, which settles the request in place (a refused open retries on measurement as usual).
  const pendingRef = useRef(false)
  const settlingRef = useRef(false)
  const [collapsed, setCollapsed] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const fillGroup = fill?.group
  const fillPanel = fill?.panel
  const defaultSize = fill?.defaultSize
  const minSize = fill?.minSize
  useLayoutEffect(() => {
    const p = panelRef.current
    if (!p) return
    // Before its group has a layout the panel can't say; its first measurement retries.
    if (collapsedNow(p) === undefined) {
      retryRef.current = true
      return
    }
    retryRef.current = false
    // A request arriving mid-transition is picked up by the re-run the transition schedules.
    if (pendingRef.current) return
    const settling = settlingRef.current
    settlingRef.current = false
    const previous = visibilityRef.current
    const opening = shouldOpenPanel({ shown, reveal }, previous, keepCollapsed)
    // Only a measured panel glides; restoring a layout at launch lands in place.
    const glide =
      !settling &&
      measuredRef.current &&
      (opening ? p.isCollapsed() : !shown && !p.isCollapsed()) &&
      canTransitionPanels()
    if (glide) {
      pendingRef.current = true
      transitionPanels(() => {
        pendingRef.current = false
        settlingRef.current = true
        if (opening)
          openPanel(p, id, openSizes, fillGroup?.current, fillPanel, defaultSize, minSize)
        else closePanel(p, id, openSizes, fillGroup?.current, fillPanel)
        // Re-run with the latest visibility to confirm the change and finish the request.
        setAttempt((n) => n + 1)
      })
      return
    }
    if (opening) {
      if (p.isCollapsed())
        openPanel(p, id, openSizes, fillGroup?.current, fillPanel, defaultSize, minSize)
      // Unmeasured, the handle may still describe the default rather than the restored layout, so
      // the request is kept until a measurement confirms the panel open.
      if (!measuredRef.current || p.isCollapsed()) {
        retryRef.current = true
        visibilityRef.current = { shown, reveal: previous?.reveal }
        return
      }
      onReveal?.()
    } else if (!shown) {
      closePanel(p, id, openSizes, fillGroup?.current, fillPanel)
      // A hidden panel has nothing to reveal: drop the request rather than replay it later.
      if (reveal != null) onReveal?.()
    }
    visibilityRef.current = { shown, reveal }
  }, [
    panelRef,
    id,
    shown,
    reveal,
    openSizes,
    attempt,
    fillGroup,
    fillPanel,
    defaultSize,
    keepCollapsed,
    minSize,
    onReveal,
  ])
  const onResize = (size: PanelSize, _: unknown, prev: PanelSize | undefined) => {
    // A restored zero-size panel can report its first size after the mount layout effect, and an
    // open can be refused until the group has room. Retry then, without reopening panels the user
    // subsequently drags shut.
    if (!measuredRef.current || retryRef.current) {
      measuredRef.current = true
      retryRef.current = false
      setAttempt((n) => n + 1)
    }
    setCollapsed(size.asPercentage === 0)
    if (size.asPercentage === 0 && prev?.asPercentage && visibilityRef.current?.shown)
      onDragShut?.()
  }
  const expand = () => {
    const p = panelRef.current
    if (!p) return
    transitionPanels(() =>
      openPanel(p, id, openSizes, fillGroup?.current, fillPanel, defaultSize, minSize),
    )
  }
  /**
   * Returns whether the panel is collapsed afterwards, or, while the close glides, whether it will
   * be once the transition applies it.
   */
  const collapse = () => {
    const p = panelRef.current
    if (!p) return false
    if (!canTransitionPanels() || p.isCollapsed())
      return closePanel(p, id, openSizes, fillGroup?.current, fillPanel)
    transitionPanels(() => closePanel(p, id, openSizes, fillGroup?.current, fillPanel))
    return true
  }
  return { props: { panelRef, onResize, collapsible: true }, collapsed, expand, collapse }
}
