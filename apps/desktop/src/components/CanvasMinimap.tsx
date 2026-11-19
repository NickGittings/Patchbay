import { ControlButton, MiniMap, type Node } from '@xyflow/react'
import { create } from 'zustand'

const STORAGE_KEY = 'patchbay.canvasMinimapVisible'

function savedVisibility() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

/** Shared because the Map stays mounted beneath Chat's Agents tab. */
const useMinimapVisible = create(savedVisibility)

function toggleMinimap() {
  const next = !useMinimapVisible.getState()
  useMinimapVisible.setState(next, true)
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    /* Keep the toggle usable when storage is unavailable. */
  }
}

/** The show/hide button, for a canvas's `Controls`. */
export function MinimapToggle() {
  const visible = useMinimapVisible()
  return (
    <ControlButton
      onClick={toggleMinimap}
      aria-label="Minimap"
      aria-pressed={visible}
      title={visible ? 'Hide minimap' : 'Show minimap'}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m8 4 0 16m8-16v16M3 13l5-3 8 4 5-3" />
      </svg>
    </ControlButton>
  )
}

export default function CanvasMinimap({ nodeColor }: { nodeColor: (node: Node) => string }) {
  const visible = useMinimapVisible()
  if (!visible) return null
  return <MiniMap pannable zoomable nodeColor={nodeColor} style={{ width: 140, height: 90 }} />
}
