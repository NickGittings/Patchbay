import { flushSync } from 'react-dom'

/** On the root while a panel transition runs: names the workspace panels for the snapshot. */
export const PANELS_TRANSITIONING = 'panels-transitioning'
/** On the root while the Agents view's details panel slides in or out. */
export const DETAILS_TRANSITIONING = 'details-transitioning'

const running = new Map<string, number>()

/** Whether a panel open or close can glide: the browser supports it and motion is welcome. */
export function canTransitionPanels() {
  return (
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Runs a programmatic panel open or close as a view transition, so the workspace panels glide to
 * their new sizes. The layout changes once, under the snapshot, so terminals in the dock refit
 * once instead of on every frame. `update` runs later, in the transition's callback; without
 * support or under reduced motion it runs at once. Drags never come through here and stay 1:1.
 */
export function transitionPanels(update: () => void, rootClass = PANELS_TRANSITIONING) {
  if (!canTransitionPanels()) {
    update()
    return
  }
  // Names go on only for the transition: a named element is its own stacking context.
  const root = document.documentElement
  running.set(rootClass, (running.get(rootClass) ?? 0) + 1)
  root.classList.add(rootClass)
  const transition = document.startViewTransition(() => {
    try {
      flushSync(update)
    } catch (error) {
      // Report it as an uncaught error would be; the transition itself just ends.
      queueMicrotask(() => {
        throw error
      })
    }
  })
  void transition.finished
    .finally(() => {
      const left = (running.get(rootClass) ?? 1) - 1
      running.set(rootClass, left)
      if (left === 0) root.classList.remove(rootClass)
    })
    // A skipped transition rejects; the update's own errors were reported above.
    .catch(() => {})
}
