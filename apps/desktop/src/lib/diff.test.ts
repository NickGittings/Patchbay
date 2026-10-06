import { describe, expect, test } from 'vitest'
import { hunkRange, parsePatch } from './diff'

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -3,4 +3,5 @@ export function main() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
 const e = 6
@@ -40 +41,0 @@
-gone
\\ No newline at end of file
`

describe('parsePatch', () => {
  test('numbers lines in the old and new file and counts changes', () => {
    const { hunks, added, removed } = parsePatch(PATCH)
    expect([added, removed]).toEqual([2, 2])
    expect(hunks).toHaveLength(2)
    const [first, second] = hunks
    expect(first).toMatchObject({
      oldStart: 3,
      oldLines: 4,
      newStart: 3,
      newLines: 5,
      context: 'export function main() {',
    })
    expect(first.lines).toEqual([
      { kind: 'ctx', old: 3, new: 3, text: 'const a = 1' },
      { kind: 'del', old: 4, text: 'const b = 2' },
      { kind: 'add', new: 4, text: 'const b = 3' },
      { kind: 'add', new: 5, text: 'const c = 4' },
      { kind: 'ctx', old: 5, new: 6, text: 'const d = 5' },
      { kind: 'ctx', old: 6, new: 7, text: 'const e = 6' },
    ])
    // Omitted counts mean one line; the "\ No newline" marker is a note, not content.
    expect(second).toMatchObject({ oldStart: 40, oldLines: 1, newStart: 41, newLines: 0 })
    expect(second.lines).toEqual([
      { kind: 'del', old: 40, text: 'gone' },
      { kind: 'note', text: 'No newline at end of file' },
    ])
  })

  test('reads content that looks like a header as content', () => {
    const { hunks } = parsePatch('@@ -1 +1 @@\n--- a/x\n+++ b/x\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ['del', '-- a/x'],
      ['add', '++ b/x'],
    ])
  })

  test('has no hunks for an empty or binary patch', () => {
    expect(parsePatch('')).toEqual({ hunks: [], added: 0, removed: 0 })
    expect(parsePatch('Binary files a/x.png and b/x.png differ\n').hunks).toEqual([])
  })
})

test('hunkRange names new-file lines unless a hunk only removes', () => {
  const [first, second] = parsePatch(PATCH).hunks
  expect(hunkRange(first)).toBe('Lines 3–7')
  expect(hunkRange(second)).toBe('Line 40')
})
