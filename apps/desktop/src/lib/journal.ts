import type { SessionState } from '../types'

/** Merge snapshots and live events by journal identity, independent of response order. */
export function hydrateJournal<K extends 'activity' | 'replies'>(key: K, limit: number) {
  return (
    previous: SessionState | undefined,
    generation: number,
    incoming: readonly NonNullable<SessionState[K]>[number][] = [],
  ): NonNullable<SessionState[K]> => {
    if (previous?.generation !== undefined && previous.generation > generation)
      return (previous[key] ?? []) as NonNullable<SessionState[K]>
    const events =
      previous?.generation === generation ? [...(previous[key] ?? []), ...incoming] : [...incoming]
    return [...new Map(events.map((event) => [event.sequence, event])).values()]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-limit) as NonNullable<SessionState[K]>
  }
}
