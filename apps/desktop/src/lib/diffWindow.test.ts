import { expect, test } from 'vitest'
import { diffGutterSize, parsePatch } from './diff'
import { diffRows, diffTextWidth, firstDiffRow } from './diffWindow'

test('gutters allow for the largest old or new line number across all hunks', () => {
  expect(diffGutterSize(parsePatch('@@ -1 +1 @@\n-old\n+new\n'))).toBe(3)
  expect(diffGutterSize(parsePatch('@@ -99999 +1,0 @@\n-removed\n'))).toBe(8)
  expect(diffGutterSize(parsePatch('@@ -1 +9999,2 @@\n+one\n+two\n'))).toBe(7)
})

test.each([
  ['', 0],
  ['plain', 5],
  ['\t', 8],
  ['\t\tcode', 20],
  ['a\tb', 9],
  ['1234567\tx', 9],
  ['12345678\tx', 17],
  ['a\tb\tc', 17],
  ['\t'.repeat(64) + 'code', 516],
])('measures tab stops for %j', (text, columns) => {
  expect(diffTextWidth(text, (part) => part.length * 7.25)).toBe(columns * 7.25)
})

test('tab stops use measured glyph widths instead of string length', () => {
  const measure = (text: string) => [...text].reduce((n, char) => n + (char === '界' ? 16 : 8), 0)
  expect(diffTextWidth('界界界\tx', measure)).toBe(72)
  expect(diffTextWidth('界界界界\tx', measure)).toBe(136)
})

test('window indices retain hunk headers and old/new coordinates beyond the old cutoff', () => {
  const patch = `@@ -1,6000 +1,6000 @@\n${' context\n'.repeat(6000)}`
  const rows = diffRows(parsePatch(patch))
  expect(rows).toHaveLength(6001)
  expect(rows[0].label).toContain('Lines 1–6000')
  expect(rows[5500].line).toMatchObject({ old: 5500, new: 5500 })
  expect(firstDiffRow(rows, rows[5500].offset + 1)).toBe(5500)
  expect(firstDiffRow(rows, -100)).toBe(0)
  expect(firstDiffRow(rows, Number.MAX_SAFE_INTEGER)).toBe(6000)
})

test('deleted lines preserve old coordinates and offsets remain contiguous across hunks', () => {
  const rows = diffRows(parsePatch('@@ -12 +11,0 @@\n-removed\n@@ -20 +19 @@\n-old\n+new\n'))
  expect(rows[1].line).toMatchObject({ old: 12, kind: 'del' })
  expect(rows[1].line?.new).toBeUndefined()
  for (let i = 1; i < rows.length; i++)
    expect(rows[i].offset).toBeCloseTo(rows[i - 1].offset + rows[i - 1].height)
})
