/**
 * Patchbay's own credential prompt for extensions. The person types the value here and it goes
 * straight to the keychain (`extension_secret_set`); extension code only learns whether it saved.
 */
export interface SecretRequest {
  extensionId: string
  extensionName: string
  name: string
  hosts: string[]
  /** The extension's short label, such as "GitHub token". */
  label: string
  /** The extension's own explanation, shown as plain text. */
  description?: string
}

export interface PendingSecret extends SecretRequest {
  id: number
}

let current: (PendingSecret & { resolve: (saved: boolean) => void }) | null = null
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Resolves true once the value is saved, false on Cancel or a newer request. */
export function promptSecret(request: SecretRequest): Promise<boolean> {
  current?.resolve(false)
  return new Promise((resolve) => {
    current = {
      ...request,
      label: request.label.slice(0, 80),
      description: request.description?.slice(0, 500),
      id: nextId++,
      resolve,
    }
    emit()
  })
}

export function settleSecret(id: number, saved: boolean) {
  if (current?.id !== id) return
  const { resolve } = current
  current = null
  emit()
  resolve(saved)
}

export function subscribeSecret(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const pendingSecret = (): PendingSecret | null => current
