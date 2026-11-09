import { describe, expect, it, vi } from 'vitest'
vi.mock('./ipc', () => ({ gitHistory: vi.fn() }))
import { graphRows, type HistoryCommit } from './history'

const commit = (hash: string, parents: string[] = []): HistoryCommit => ({
  hash,
  parents,
  author: 'author',
  timestamp: 1,
  message: hash,
  refs: '',
})

describe('history graph', () => {
  it('keeps continuation lanes stable when more history is loaded', () => {
    const page = [commit('merge', ['a', 'b']), commit('a', ['root'])]
    const first = graphRows(page)
    const expanded = graphRows([...page, commit('b', ['root']), commit('root')])
    expect(expanded.slice(0, page.length)).toEqual(first)
    expect(first[0].after).toEqual(['a', 'b'])
    expect(expanded[2].after).toEqual(['root'])
    expect(expanded[3].after).toEqual([])
  })
  it('handles an unrelated branch and octopus merges without duplicate lanes', () => {
    const rows = graphRows([
      commit('tip', ['a', 'b', 'c']),
      commit('unrelated'),
      commit('a', ['root']),
      commit('b', ['root']),
      commit('c', ['root']),
      commit('root'),
    ])
    for (const row of rows) {
      expect(new Set(row.after).size).toBe(row.after.length)
      for (const hash of row.before) {
        if (hash !== row.before[row.lane]) expect(row.after).toContain(hash)
      }
    }
    expect(rows.at(-1)?.after).toEqual([])
  })
})
