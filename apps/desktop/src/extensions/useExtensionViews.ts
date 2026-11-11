import { useState } from 'react'
import { useStore } from '../store'
export function useExtensionViews(location: 'inspector' | 'dock', reset?: unknown) {
  const registry = useStore((s) => s.extensions)
  const views = registry.extensions
    .filter((e) => e.enabled && !e.errors.length)
    .flatMap((e) => e.manifest.contributes.views)
    .filter((v) => v.location === location)
  // A terminal reveal overrides a selected dock view, even when its session was already active.
  const [selection, setSelection] = useState<{ id: string | null; reset: unknown }>({
    id: null,
    reset,
  })
  const setSelected = (id: string | null) => setSelection({ id, reset })
  const active =
    Object.is(selection.reset, reset) && views.some((v) => v.id === selection.id)
      ? selection.id
      : null
  return { views, selected: active, setSelected }
}
