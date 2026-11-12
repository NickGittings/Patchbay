/** Bounded, revision-aware request sharing. Failed requests can be retried. */
export class SharedRequests<T> {
  private entries = new Map<string, { revision: object; promise: Promise<T> }>()
  private listeners = new Map<string, Set<() => void>>()

  get(key: string, revision: object, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key)
    if (existing?.revision === revision) return existing.promise
    const promise = Promise.resolve().then(load)
    const entry = { revision, promise }
    this.entries.set(key, entry)
    if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!)
    void promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return promise
  }

  invalidate(key: string) {
    this.entries.delete(key)
    this.listeners.get(key)?.forEach((notify) => notify())
  }

  subscribe(key: string, notify: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    listeners.add(notify)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(notify)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  retain(keep: (key: string) => boolean) {
    for (const key of this.entries.keys()) if (!keep(key)) this.entries.delete(key)
  }
}
