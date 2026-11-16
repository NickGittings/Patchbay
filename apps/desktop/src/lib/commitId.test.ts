import { expect, test } from 'vitest'
import { isCommitId, shortSha } from './commitId'

test('only full SHA-1 or SHA-256 ids are commit ids', () => {
  expect(isCommitId('a'.repeat(40))).toBe(true)
  expect(isCommitId('a'.repeat(64))).toBe(true)
  for (const value of ['main', 'abc', 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(40)}\n`])
    expect(isCommitId(value)).toBe(false)
})

test('a short sha keeps the first seven characters', () => {
  expect(shortSha('abc1234def5678')).toBe('abc1234')
})
