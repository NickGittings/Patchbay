/** IDs and percentage constraints shared by Navigation's layouts. */
export const NAVIGATION_LAYOUT = 'App-1'
export const CHAT_LAYOUT = 'App-simple'
/** Where Navigation's collapsible panels remember their open sizes, in the project's `panels`. */
export const PANEL_OPEN_SIZES = 'App-open'
export const CHAT_OPEN_SIZES = 'App-simple-open'
export const CHAT_PANEL = 'App-simple-chat'
/** The Hierarchy panel older Navigation layouts still name. */
export const HIERARCHY_PANEL = 'App-pane-1'
export const CANVAS_PANEL = 'App-pane-2'
export const INSPECTOR_PANEL = 'App-pane-5'
export const CHAT_DEFAULT_SIZE = 35
export const CHAT_MIN_SIZE = 20
/** The map keeps at least this much when a panel opens beside it. */
export const CANVAS_MIN_SIZE = 20

/** Collapse a panel into a specific sibling without changing the other panels' sizes. */
export function collapsedInto(layout: Record<string, number>, id: string, fill: string) {
  if (!Object.hasOwn(layout, id) || !Object.hasOwn(layout, fill)) return undefined
  return { ...layout, [id]: 0, [fill]: layout[fill] + layout[id] }
}

/** Open a panel using only the space a specific sibling can spare above its own minimum. */
export function expandedFrom(
  layout: Record<string, number>,
  id: string,
  fill: string,
  size: number,
  minSize = 0,
  fillMinSize = CANVAS_MIN_SIZE,
) {
  if (!Object.hasOwn(layout, id) || !Object.hasOwn(layout, fill)) return undefined
  const spare = Math.max(layout[fill] - fillMinSize, 0)
  // Let the panel API redistribute siblings if the canvas cannot supply the minimum.
  if (layout[id] + spare < minSize) return undefined
  const delta = Math.min(Math.max(Math.max(size, minSize) - layout[id], 0), spare)
  return { ...layout, [id]: layout[id] + delta, [fill]: layout[fill] - delta }
}
