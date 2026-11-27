import { PanOnScrollMode } from '@xyflow/react'

/**
 * Mac canvas conventions shared by both maps: two-finger scroll pans (with the system's own
 * momentum), pinch zooms, and a mouse wheel zooms while Command or Control is held.
 */
export const CANVAS_GESTURES = {
  panOnScroll: true,
  panOnScrollMode: PanOnScrollMode.Free,
  zoomOnScroll: false,
  zoomOnPinch: true,
} as const
