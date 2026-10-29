import { useEffect, useRef, type RefObject } from 'react'
import { stepKey } from '../../lib/changeNav'

/**
 * Arrow keys step files while focus sits on body, which WebKit leaves there when a view first
 * opens and after a click on text that can't take focus. They act only while the last click
 * landed inside `scopes` (the change list and diff),
 * so arrows still scroll a chat thread or findings the user clicked into. Focused controls,
 * including the change list and diff, handle their own keys.
 */
export function useStepKeys(
  step: (delta: -1 | 1) => void,
  scopes: readonly RefObject<HTMLElement | null>[],
) {
  const latest = useRef({ step, scopes })
  useEffect(() => {
    latest.current = { step, scopes }
  })
  useEffect(() => {
    let inside = false
    const pointerdown = (event: PointerEvent) => {
      const target = event.target as Node | null
      inside = !!target && latest.current.scopes.some((s) => s.current?.contains(target))
    }
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !inside ||
        (document.activeElement && document.activeElement !== document.body)
      )
        return
      const delta = stepKey(event, 'list')
      if (delta) {
        event.preventDefault()
        latest.current.step(delta)
      }
    }
    document.addEventListener('pointerdown', pointerdown, true)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', pointerdown, true)
      document.removeEventListener('keydown', keydown)
    }
  }, [])
}
