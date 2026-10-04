/** One line of a hunk, with its number in the old and/or new file. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'note'
  old?: number
  new?: number
  text: string
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The enclosing function or section git found, if any. */
  context: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: Hunk[]
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Parse a single file's unified diff into hunks with line numbers. File headers (`diff --git`,
 * `index`, `---`/`+++`, modes) are dropped; each hunk ends when its line counts are used up, so
 * content that looks like a header is still read as content.
 */
export function parsePatch(patch: string): ParsedDiff {
  const hunks: Hunk[] = []
  let added = 0
  let removed = 0
  let hunk: Hunk | undefined
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of patch.split('\n')) {
    if (hunk && line.startsWith('\\')) {
      hunk.lines.push({ kind: 'note', text: line.slice(2) })
      continue
    }
    if (!hunk || (oldLeft <= 0 && newLeft <= 0)) {
      const m = HUNK.exec(line)
      if (!m) {
        hunk = undefined
        continue
      }
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        context: m[5].trim(),
        lines: [],
      }
      hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      oldLeft = hunk.oldLines
      newLeft = hunk.newLines
      continue
    }
    const text = line.slice(1)
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', new: newNo++, text })
      newLeft--
      added++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', old: oldNo++, text })
      oldLeft--
      removed++
    } else {
      hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text })
      oldLeft--
      newLeft--
    }
  }
  return { hunks, added, removed }
}

/** "Lines 40–52" for a hunk, in the new file unless it only removes lines. */
export function hunkRange(h: Hunk): string {
  const [start, count] = h.newLines > 0 ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines]
  return count <= 1 ? `Line ${start}` : `Lines ${start}–${start + count - 1}`
}
