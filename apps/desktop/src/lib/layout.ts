import type { Component, Link } from '../types'

export type Position = Component['position']

/** The same grid `detect::layout` uses for a freshly detected map. */
export const COLUMN_WIDTH = 340
export const ROW_HEIGHT = 230

const SWEEPS = 4

/** Current reading order: top to bottom, then left to right, so a rearranged map stays familiar. */
const byPosition = (a: Component, b: Component) =>
  a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id)

/**
 * Positions for every component: linked ones in columns by dependency depth (dependents on the
 * left, foundations on the right, as `detect::layout`), ordered within each column to cut
 * crossings and centred on the tallest; unlinked ones in a block below. The result keeps the
 * map's current top-left corner, so the view doesn't jump.
 */
export function arrange(
  components: Component[],
  links: Pick<Link, 'source' | 'target'>[],
): Record<string, Position> {
  const ids = new Set(components.map((c) => c.id))
  const edges = links.filter((l) => ids.has(l.source) && ids.has(l.target) && l.source !== l.target)
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const { source, target } of edges) {
    out.set(source, [...(out.get(source) ?? []), target])
    into.set(target, [...(into.get(target) ?? []), source])
  }

  // Longest path to a foundation; a cycle counts as ending where it closes.
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const d = Math.max(0, ...(out.get(id) ?? []).map((t) => 1 + depthOf(t)))
    visiting.delete(id)
    depth.set(id, d)
    return d
  }

  const ordered = [...components].sort(byPosition)
  const linked = ordered.filter((c) => out.has(c.id) || into.has(c.id))
  const loose = ordered.filter((c) => !out.has(c.id) && !into.has(c.id))
  for (const c of linked) depthOf(c.id)
  const deepest = Math.max(0, ...linked.map((c) => depth.get(c.id) ?? 0))
  const columnOf = (id: string) => deepest - (depth.get(id) ?? 0)

  const columns: string[][] = Array.from({ length: linked.length ? deepest + 1 : 0 }, () => [])
  for (const c of linked) columns[columnOf(c.id)].push(c.id)

  // Barycenter sweeps: order each column by the mean row of its neighbours on the side just
  // placed; a component without any there keeps its row.
  const rowOf = new Map<string, number>()
  const index = () => columns.forEach((col) => col.forEach((id, row) => rowOf.set(id, row)))
  index()
  const reorder = (col: string[], before: (other: number) => boolean, c: number) => {
    const key = new Map<string, number>()
    for (const id of col) {
      const near = [...(out.get(id) ?? []), ...(into.get(id) ?? [])].filter((n) =>
        before(columnOf(n) - c),
      )
      key.set(
        id,
        near.length
          ? near.reduce((sum, n) => sum + (rowOf.get(n) ?? 0), 0) / near.length
          : (rowOf.get(id) ?? 0),
      )
    }
    col.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0))
    col.forEach((id, row) => rowOf.set(id, row))
  }
  for (let i = 0; i < SWEEPS; i++) {
    for (let c = 1; c < columns.length; c++) reorder(columns[c], (d) => d < 0, c)
    for (let c = columns.length - 2; c >= 0; c--) reorder(columns[c], (d) => d > 0, c)
  }
  index()

  const placed = new Map<string, Position>()
  const tallest = Math.max(0, ...columns.map((col) => col.length))
  columns.forEach((col, c) =>
    col.forEach((id, row) =>
      placed.set(id, {
        x: c * COLUMN_WIDTH,
        y: (row + (tallest - col.length) / 2) * ROW_HEIGHT,
      }),
    ),
  )
  const perRow = Math.max(columns.length, Math.ceil(Math.sqrt(loose.length)), 1)
  loose.forEach((c, i) =>
    placed.set(c.id, {
      x: (i % perRow) * COLUMN_WIDTH,
      y: (tallest + Math.floor(i / perRow)) * ROW_HEIGHT,
    }),
  )

  // Anchor at the current top-left corner.
  const minX = Math.min(...components.map((c) => c.position.x))
  const minY = Math.min(...components.map((c) => c.position.y))
  const result: Record<string, Position> = {}
  for (const [id, p] of placed)
    result[id] = { x: Math.round(p.x + minX), y: Math.round(p.y + minY) }
  return result
}
