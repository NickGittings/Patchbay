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
  /** Focused when the first of a run of confirmations opened; focus returns there. */
  returnFocus: Element | null
}

let current: (PendingConfirm & { resolve: (ok: boolean) => void }) | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Resolves true when the person confirms, false on Cancel, Escape, or a newer request. */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  const previous = current
  previous?.resolve(false)
  // A request replacing an open one returns focus where the first one found it, not to the
  // replaced dialog's Cancel button.
  const returnFocus = previous ? previous.returnFocus : document.activeElement
  return new Promise((resolve) => {
    current = { ...request, id: nextId++, returnFocus, resolve }
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
