import { hunkRange, type DiffLine, type ParsedDiff } from './diff'

/** Match white-space: pre with eight-space tab stops, relative to the code cell. */
export function diffTextWidth(text: string, measure: (text: string) => number): number {
  if (!text.includes('\t')) return measure(text)
  const tabWidth = 8 * measure(' ')
  const parts = text.split('\t')
  let width = measure(parts[0])
  for (let i = 1; i < parts.length; i++) {
    width = (Math.floor(width / tabWidth) + 1) * tabWidth + measure(parts[i])
  }
  return width
}

export function diffRows(parsed: ParsedDiff) {
  let offset = 0
  return parsed.hunks.flatMap((hunk) => {
    const header = {
      offset,
      height: 30,
      label: `${hunkRange(hunk)} ${hunk.context}`,
      line: undefined as DiffLine | undefined,
    }
    offset += 30
    return [
      header,
      ...hunk.lines.map((line) => {
        const row = { offset, height: 19.2, label: '', line }
        offset += 19.2
        return row
      }),
    ]
  })
}

/** First intersecting row, found without scanning the full patch on every scroll. */
export function firstDiffRow(rows: { offset: number; height: number }[], top: number) {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (rows[mid].offset + rows[mid].height < top) low = mid + 1
    else high = mid
  }
  return Math.min(low, Math.max(0, rows.length - 1))
}
