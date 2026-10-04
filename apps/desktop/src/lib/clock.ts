import { useSyncExternalStore } from 'react'

const TICK_MS = 10_000

let tick = 0
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  timer ??= setInterval(() => {
    tick++
    for (const l of listeners) l()
  }, TICK_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

/**
 * Re-render every few seconds, so relative times ("for 3m") stay current while no status event
 * arrives. One shared timer runs while any component uses it.
 */
export function useClockTick() {
  return useSyncExternalStore(subscribe, () => tick)
}
