/** One changed file, named by the component whose list shows it. */
export interface ChangeRef {
  componentId: string
  path: string
}

/** Every listed file in display order, so stepping crosses from one component's list to the next. */
export function changeRefs(
  groups: readonly { id: string; files: readonly { path: string }[] }[],
): ChangeRef[] {
  return groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
}

/** Where `current` sits in `refs`, or -1 when it isn't listed. */
export function changePosition(refs: readonly ChangeRef[], current: ChangeRef | null | undefined) {
  if (!current) return -1
  return refs.findIndex((r) => r.componentId === current.componentId && r.path === current.path)
}

/**
 * The file `delta` steps from `current`, stopping at either end. An unlisted `current` steps to
 * the first file going forward and the last going back.
 */
export function stepChange(
  refs: readonly ChangeRef[],
  current: ChangeRef | null | undefined,
  delta: -1 | 1,
): ChangeRef | undefined {
  const at = changePosition(refs, current)
  const next = at < 0 ? (delta > 0 ? 0 : refs.length - 1) : at + delta
  return next === at ? undefined : refs[next]
}

interface StepKeyEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  target: EventTarget | null
}

/**
 * The step a key asks for. A change list moves with ↑/↓ and ←/→; a diff keeps ↑/↓ for scrolling,
 * so only ←/→ switch files there. Modified keys and keys typed into fields never step.
 */
export function stepKey(e: StepKeyEvent, where: 'list' | 'diff'): -1 | 0 | 1 {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0
  const target = e.target as { tagName?: string; isContentEditable?: boolean } | null
  if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '')) return 0
  if (e.key === 'ArrowLeft' || (where === 'list' && e.key === 'ArrowUp')) return -1
  if (e.key === 'ArrowRight' || (where === 'list' && e.key === 'ArrowDown')) return 1
  return 0
}
