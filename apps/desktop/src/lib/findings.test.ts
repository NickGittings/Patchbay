import { describe, expect, test } from 'vitest'
import { fileRefs, parseFindings, severityCounts } from './findings'

describe('parseFindings', () => {
  test('splits tagged findings and drops the verdict and counts lines', () => {
    const [section, ...rest] = parseFindings(
      [
        'Verdict: issues',
        'Counts: {"critical":0,"high":1,"medium":0,"low":1}',
        '',
        'Two problems.',
        '',
        '1. **[high]** Lost writes in `src/store.ts:42`',
        '   The save races the flush.',
        '',
        '2. [low] Typo — docs/readme.md:3',
      ].join('\n'),
    )
    expect(rest).toEqual([])
    expect(section.reviewer).toBeNull()
    expect(section.intro).toBe('Two problems.')
    expect(section.items).toEqual([
      {
        severity: 'high',
        title: 'Lost writes in `src/store.ts:42`',
        body: '   The save races the flush.',
        refs: [{ path: 'src/store.ts', line: 42 }],
      },
      {
        severity: 'low',
        title: 'Typo — docs/readme.md:3',
        body: '',
        refs: [{ path: 'docs/readme.md', line: 3 }],
      },
    ])
  })

  test('reads headings, bullets, checkboxes and emphasis around the tag', () => {
    const items = parseFindings(
      [
        '**Verdict:** issues',
        '### [medium] Heading finding',
        '- **[critical] Bold finding**',
        '- [ ] [low] Task finding',
        '* `[high]` Code-tagged',
      ].join('\n'),
    )[0].items
    expect(items.map((f) => [f.severity, f.title])).toEqual([
      ['medium', 'Heading finding'],
      ['critical', 'Bold finding'],
      ['low', 'Task finding'],
      ['high', 'Code-tagged'],
    ])
  })

  test('ignores legends, bare tag lists and tags inside code blocks', () => {
    const items = parseFindings(
      [
        'Verdict: issues',
        '## Severity legend',
        '- [critical] highest priority',
        '## Findings',
        '[critical], [high], [medium] or [low]',
        '- [medium] real one',
        '```text',
        '[high] example',
        '```',
      ].join('\n'),
    )[0].items
    expect(items).toHaveLength(1)
    expect(items[0].severity).toBe('medium')
    expect(items[0].body).toBe('```text\n[high] example\n```')
  })

  test('splits combined reviewers', () => {
    const sections = parseFindings(
      [
        '## Reviewer: claude',
        '',
        'Verdict: issues',
        '- [high] A',
        '',
        '## Reviewer: codex',
        '',
        'Verdict: clean',
        'No findings.',
      ].join('\n'),
    )
    expect(sections.map((s) => [s.reviewer, s.items.length, s.intro])).toEqual([
      ['claude', 1, ''],
      ['codex', 0, 'No findings.'],
    ])
    expect(severityCounts(sections)).toEqual({ critical: 0, high: 1, medium: 0, low: 0 })
  })

  test('leaves untagged text as the intro', () => {
    const [section] = parseFindings('Verdict: clean\n\nNo findings; looks good.')
    expect(section.items).toEqual([])
    expect(section.intro).toBe('No findings; looks good.')
  })
  test('stays fast on long rule lines without a tag', () => {
    const start = performance.now()
    parseFindings(['#', '_', '*', '`'].map((c) => c.repeat(5000)).join('\n'))
    expect(performance.now() - start).toBeLessThan(500)
  })
  test('splits combined reviewers even after an unclosed fence', () => {
    const sections = parseFindings(
      [
        '## Reviewer: claude',
        '',
        '[high] One',
        '```ts',
        'never closed',
        '',
        '## Reviewer: codex',
        '',
        '[low] Two',
      ].join('\n'),
    )
    expect(sections.map((s) => [s.reviewer, s.items.map((f) => f.title)])).toEqual([
      ['claude', ['One']],
      ['codex', ['Two']],
    ])
  })

  test('a fence closes only on its own marker', () => {
    const [section] = parseFindings(['~~~', '```', '[high] quoted', '~~~', '[low] Real'].join('\n'))
    expect(section.items.map((f) => f.title)).toEqual(['Real'])
  })
})

describe('fileRefs', () => {
  test('finds paths with lines and ranges, once each', () => {
    expect(
      fileRefs('See (src/a.ts:3-9), Cargo.toml:2, src/a.ts:3 and ./lib/x.rs:10, not v1.2:3'),
    ).toEqual([
      { path: 'src/a.ts', line: 3, endLine: 9 },
      { path: 'Cargo.toml', line: 2 },
      { path: 'lib/x.rs', line: 10 },
    ])
  })

  test('skips URLs and bare words', () => {
    expect(fileRefs('http://localhost:1420 and note:3')).toEqual([])
  })
})

test('native Codex findings retain absolute file links after priority conversion', () => {
  const [section] = parseFindings(
    'Verdict: issues\nCounts: {"critical":0,"high":1,"medium":0,"low":0}\n\n' +
      'The change breaks division.\n\nReview comment:\n\n' +
      '- [high] Restore division — /private/tmp/review/math.py:2-2\n  Restore the operator.',
  )
  expect(section.items[0].refs).toEqual([
    { path: '/private/tmp/review/math.py', line: 2, endLine: 2 },
  ])
  expect(fileRefs(String.raw`- [high] Restore division — C:\work\review\math.py:2-3`)).toEqual([
    { path: 'C:/work/review/math.py', line: 2, endLine: 3 },
  ])
})
