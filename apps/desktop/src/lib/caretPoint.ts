/** Styles that decide where text wraps and how tall a line is, copied onto the mirror. */
const MIRRORED = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontFeatureSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
] as const

/**
 * Where `index` sits inside a textarea, relative to its padding box and after its scroll,
 * measured with an offscreen mirror that wraps text the same way.
 */
export function caretPoint(textarea: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(textarea)
  const mirror = document.createElement('div')
  for (const key of MIRRORED) mirror.style[key] = style[key]
  // The padding box without a scrollbar, so the mirror wraps exactly where the textarea does.
  Object.assign(mirror.style, {
    boxSizing: 'border-box',
    width: `${textarea.clientWidth}px`,
    border: '0',
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    overflow: 'hidden',
    height: 'auto',
  })
  mirror.textContent = textarea.value.slice(0, index)
  const marker = document.createElement('span')
  // The rest of the word wraps with it, as in the textarea; a character keeps the marker on the
  // caret's line when the text ends in a newline.
  marker.textContent = /^\S*/.exec(textarea.value.slice(index))![0] || '.'
  mirror.append(marker)
  document.body.append(mirror)
  const parsed = parseFloat(style.lineHeight)
  const lineHeight = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.2
  const point = {
    left: marker.offsetLeft - textarea.scrollLeft,
    top: marker.offsetTop - textarea.scrollTop,
    lineHeight,
  }
  mirror.remove()
  return point
}

export interface MentionPlacement {
  left: number
  top: number
  maxHeight: number
  placement: 'above' | 'below'
}

const GAP = 6
const EDGE = 4
/** Tallest the list grows: seven 28px rows and its padding. */
export const MENTION_MAX_HEIGHT = 7 * 28 + 8

/**
 * Places the mention popover over the line holding the `@`: above it when it fits there,
 * otherwise below when it fits, otherwise on the roomier side with its height capped to that room.
 * It stays inside the composer horizontally. Coordinates are relative to the popover's positioning
 * box; `bounds.top` and `bounds.bottom` are the clipping ancestor's edges in the same space.
 * `popover.height` is the list's natural height, before any cap.
 */
export function placeMention({
  caret,
  lineHeight,
  popover,
  bounds,
}: {
  caret: { left: number; top: number }
  lineHeight: number
  popover: { width: number; height: number }
  bounds: { width: number; top: number; bottom: number }
}): MentionPlacement {
  const height = Math.min(popover.height, MENTION_MAX_HEIGHT)
  const roomAbove = caret.top - GAP - EDGE - bounds.top
  const belowTop = caret.top + lineHeight + GAP
  const roomBelow = bounds.bottom - EDGE - belowTop
  const placement =
    roomAbove >= height || (roomBelow < height && roomAbove >= roomBelow) ? 'above' : 'below'
  const maxHeight = Math.max(0, Math.min(height, placement === 'above' ? roomAbove : roomBelow))
  const maxLeft = Math.max(0, bounds.width - popover.width)
  return {
    left: Math.min(Math.max(0, caret.left - EDGE), maxLeft),
    top: placement === 'above' ? caret.top - GAP - maxHeight : belowTop,
    maxHeight,
    placement,
  }
}

/** The nearest ancestor that clips overflow, whose top edge limits room above the popover. */
export function clippingAncestor(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') return node
  }
  return document.documentElement
}

export function samePlacement(a: MentionPlacement | undefined, b: MentionPlacement) {
  return (
    !!a &&
    a.left === b.left &&
    a.top === b.top &&
    a.maxHeight === b.maxHeight &&
    a.placement === b.placement
  )
}
