/** One confirmation at a time per window, shown by `ConfirmHost` in place of `window.confirm`. */
export interface ConfirmRequest {
  title: string
  message: string
  /** Secondary text under the message, such as the path the action applies to. */
  detail?: string
  /** The verb on the confirming button, e.g. "Stop and remove". */
  confirmLabel: string
  /** Styles the confirming button as destructive; defaults to true. */
  destructive?: boolean
}

export interface PendingConfirm extends ConfirmRequest {
  id: number
}

let current: (PendingConfirm & { resolve: (ok: boolean) => void }) | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Resolves true when the person confirms, false on Cancel, Escape, or a newer request. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  current?.resolve(false)
  return new Promise((resolve) => {
    current = { ...request, id: nextId++, resolve }
    emit()
  })
}

export function settleConfirm(id: number, ok: boolean) {
  if (current?.id !== id) return
  const { resolve } = current
  current = null
  emit()
  resolve(ok)
}

export function subscribeConfirm(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const pendingConfirm = (): PendingConfirm | null => current
