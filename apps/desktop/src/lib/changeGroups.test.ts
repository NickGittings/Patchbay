import { expect, test } from 'vitest'
import { changeGroups } from './changeGroups'
import type { FlowNode } from '../store'
import type { Review } from '../types'
test('Full and Simple share component order, paths and loose project files from gitReview', () => {
  const nodes = [
    { id: 'a', data: { name: 'A', path: 'a', kind: 'app' } },
    { id: 'b', data: { name: 'B', path: '/external', kind: 'library' } },
  ] as FlowNode[]
  const review = {
    changes: {
      b: [{ path: '/external/b.rs' }],
      a: [{ path: 'a/app.ts' }],
      '@project': [{ path: 'README.md' }],
    },
  } as unknown as Review
  expect(
    changeGroups(nodes, review).map(({ id, base, files }) => ({
      id,
      base,
      files: files.map((f) => f.path),
    })),
  ).toEqual([
    { id: 'a', base: 'a', files: ['a/app.ts'] },
    { id: 'b', base: '/external', files: ['/external/b.rs'] },
    { id: '@project', base: '.', files: ['README.md'] },
  ])
  expect(changeGroups(nodes)).toEqual([])
})
