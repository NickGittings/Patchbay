import type { Component, Link } from '../types'

export type Position = Component['position']

/** The same grid `detect::layout` uses for a freshly detected map. */
export const COLUMN_WIDTH = 340
export const ROW_HEIGHT = 230

/** Sweeps stop once they repeat an order, so arranging again keeps the result; this caps them. */
const MAX_SWEEPS = 64

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
    if (!out.has(source)) out.set(source, [])
    if (!into.has(target)) into.set(target, [])
    out.get(source)!.push(target)
    into.get(target)!.push(source)
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
  // Cycle depths depend on which member is visited first. Use IDs so arranging again cannot
  // change the depths just because the previous arrangement changed the reading order.
  for (const id of [...out.keys()].sort()) depthOf(id)
  const depths = linked.map((c) => depth.get(c.id) ?? 0)
  const deepest = Math.max(0, ...depths)
  // A cycle with no way out has no foundation at depth 0; it still ends at the right edge.
  const shallowest = Math.min(deepest, ...depths)
  const columnOf = (id: string) => deepest - (depth.get(id) ?? 0)

  const columns: string[][] = Array.from(
    { length: linked.length ? deepest - shallowest + 1 : 0 },
    () => [],
  )
  for (const c of linked) columns[columnOf(c.id)].push(c.id)
  const tallest = Math.max(0, ...columns.map((col) => col.length))
  // Columns are centred on the tallest one, so rows compare by where they are drawn.
  const offset = (c: number) => (tallest - columns[c].length) / 2

  // Barycenter sweeps: order each column by the mean drawn row of its neighbours on the side
  // just placed; a component without any there keeps its row.
  const rowOf = new Map<string, number>()
  const index = () => columns.forEach((col) => col.forEach((id, row) => rowOf.set(id, row)))
  index()
  const drawnRow = (id: string) => (rowOf.get(id) ?? 0) + offset(columnOf(id))
  const reorder = (col: string[], before: (other: number) => boolean, c: number) => {
    const key = new Map<string, number>()
    for (const id of col) {
      const near = [...(out.get(id) ?? []), ...(into.get(id) ?? [])].filter((n) =>
        before(columnOf(n) - c),
      )
      key.set(
        id,
        near.length ? near.reduce((sum, n) => sum + drawnRow(n), 0) / near.length : drawnRow(id),
      )
    }
    col.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0))
    col.forEach((id, row) => rowOf.set(id, row))
  }
  // Sweeping from a settled order must give it back. When the sweeps cycle instead, take the
  // cycle's least order, which every order on that cycle reaches too.
  const orders: string[] = []
  const snapshots: string[][][] = []
  for (let i = 0; i <= MAX_SWEEPS; i++) {
    const order = JSON.stringify(columns)
    const seen = orders.indexOf(order)
    if (seen >= 0) {
      const cycle = orders.slice(seen)
      const least = cycle.indexOf([...cycle].sort()[0])
      snapshots[seen + least].forEach((col, c) => (columns[c] = [...col]))
      break
    }
    orders.push(order)
    snapshots.push(columns.map((col) => [...col]))
    for (let c = 1; c < columns.length; c++) reorder(columns[c], (d) => d < 0, c)
    for (let c = columns.length - 2; c >= 0; c--) reorder(columns[c], (d) => d > 0, c)
  }
  index()

  const placed = new Map<string, Position>()
  columns.forEach((col, c) =>
    col.forEach((id, row) =>
      placed.set(id, { x: c * COLUMN_WIDTH, y: (row + offset(c)) * ROW_HEIGHT }),
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
