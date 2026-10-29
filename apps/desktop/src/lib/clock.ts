import { useEffect, useState, useSyncExternalStore } from 'react'

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

/**
 * Re-render once when this deadline expires. An absent deadline schedules no work.
 * Returning the expired deadline lets pure render code compare against it without a clock tick.
 */
export function useExpiredDeadline(deadline: number | undefined) {
  const [expired, setExpired] = useState<number>()
  useEffect(() => {
    if (deadline === undefined) return
    const timer = setTimeout(() => setExpired(deadline), Math.max(0, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [deadline])
  return expired === deadline ? expired : undefined
}
