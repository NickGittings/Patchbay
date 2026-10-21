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
      { kind: 'code', text: 'let x = [high];' },
      { kind: 'quote', text: 'quoted' },
      { kind: 'code', text: '| a | b |\n| - | - |' },
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
      { kind: 'text', text: 'docs' },
      { kind: 'text', text: ' in snake_case' },
    ])
  })
  test('leaves dunder names alone', () => {
    expect(parseInline('see __init__.py:3')).toEqual([{ kind: 'text', text: 'see __init__.py:3' }])
  })
})
