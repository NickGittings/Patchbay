import { expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MergeFields from './MergeFields'

const mergeFields = (inPlaceBase: { branch: string; head: string } | null) =>
  renderToStaticMarkup(
    createElement(MergeFields, {
      inPlaceBase,
      mode: 'ask',
      onMode: () => {},
      cleanup: 'keep',
      destination: 'main',
      destinations: ['main'],
      onDestination: () => {},
    }),
  )

test('a run in place offers no merge choices and names the commit it reviews against', () => {
  const html = mergeFields({ branch: 'main', head: 'abc1234def5678' })
  expect(html).toContain('Runs in place on main, reviewing against abc1234, no')
  expect(html).not.toContain('Merge automatically after review')
  expect(html).not.toContain('After merge')
  expect(html).not.toContain('Destination branch')
})

test('a worktree with a review base keeps its merge choices', () => {
  const html = mergeFields(null)
  expect(html).not.toContain('Runs in place')
  expect(html).toContain('Merge automatically after review')
  expect(html).toContain('After merge')
  expect(html).toContain('Destination branch')
})
