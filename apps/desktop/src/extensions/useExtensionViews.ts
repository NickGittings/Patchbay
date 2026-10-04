import { useState } from 'react'
import { useStore } from '../store'
export function useExtensionViews(location: 'inspector' | 'dock') {
  const registry = useStore((s) => s.extensions)
  const views = registry.extensions
    .filter((e) => e.enabled && !e.errors.length)
    .flatMap((e) => e.manifest.contributes.views)
    .filter((v) => v.location === location)
  const [selected, setSelected] = useState<string | null>(null)
  const active = views.some((v) => v.id === selected) ? selected : null
  return { views, selected: active, setSelected }
}
