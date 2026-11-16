import { describe, expect, test } from 'vitest'
import { parseBlocks, parseInline } from './markdown'

describe('parseBlocks', () => {
  test('reads headings, paragraphs, lists, code, quotes and tables', () => {
    expect(
      parseBlocks(
        [
          '## Impact',
          'Writes are',
          'lost.',
          '',
          '- one',
          '  continued',
          '- two',
          '1. first',
          '2. second',
          '```rust',
          'let x = [high];',
          '```',
          '> quoted',
          '| a | b |',
          '| - | - |',
          '---',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'heading', level: 2, text: 'Impact' },
      { kind: 'paragraph', text: 'Writes are lost.' },
      { kind: 'list', ordered: false, items: ['one continued', 'two'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
      { kind: 'code', text: 'let x = [high];\n' },
      { kind: 'quote', text: 'quoted' },
      { kind: 'plain', text: '| a | b |\n| - | - |' },
    ])
  })

  test('folds nested list items into their parent', () => {
    expect(parseBlocks('- a\n  - b\n- c')).toEqual([
      { kind: 'list', ordered: false, items: ['a b', 'c'] },
    ])
  })
})

describe('parseInline', () => {
  test('splits code, strong, emphasis and links', () => {
    expect(
      parseInline('See `a_b.ts:3`, **bold**, *it* and [docs](http://x) in snake_case'),
    ).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'code', text: 'a_b.ts:3' },
      { kind: 'text', text: ', ' },
      { kind: 'strong', text: 'bold' },
      { kind: 'text', text: ', ' },
      { kind: 'em', text: 'it' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'docs', href: 'http://x' },
      { kind: 'text', text: ' in snake_case' },
    ])
  })
  test('leaves dunder names alone', () => {
    expect(parseInline('see __init__.py:3')).toEqual([{ kind: 'text', text: 'see __init__.py:3' }])
  })
})

test.each([
  'javascript:alert(1)',
  'data:text/html,hi',
  'file:///tmp/a',
  '/tmp/a',
  'https://',
  'https://user:pass@host',
])('keeps unsafe or local URL %s literal', (url) => {
  const source = `[link](${url})`
  expect(parseInline(source)).toEqual([{ kind: 'text', text: source }])
})
test('keeps malformed and unsupported input as text', () => {
  expect(parseBlocks('```ts\nunfinished')).toEqual([{ kind: 'plain', text: '```ts\nunfinished' }])
  expect(parseInline('[broken](https://host')).toEqual([
    { kind: 'text', text: '[broken](https://host' },
  ])
  expect(parseInline('<script>alert(1)</script>')).toEqual([
    { kind: 'text', text: '<script>alert(1)</script>' },
  ])
})
test('parses semantic tables, escaped pipes, and rejects mismatched rows', () => {
  expect(parseBlocks('a | b\n:--- | ---:\nx \\| y | `z`')).toEqual([
    { kind: 'table', header: ['a', 'b'], rows: [['x | y', '`z`']] },
  ])
  expect(parseBlocks('| a | b |\n| --- | --- |\n| short |')).toEqual([
    { kind: 'plain', text: '| a | b |\n| --- | --- |\n| short |' },
  ])
})
test('code copy source preserves whitespace, CRLF and fence-like code', () => {
  expect(parseBlocks('````ts\r\n  a\t \r\n```\r\n\r\n````')).toEqual([
    { kind: 'code', text: '  a\t \r\n```\r\n\r\n' },
  ])
})
