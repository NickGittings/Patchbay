import { expect, test } from 'vitest'
import { followScroll, initialFollow, receiveReplies } from './chatNavigation'
import { mentionKey } from './chatMentions'

test('counts only new replies while away and clears on reaching the bottom', () => {
  const original = [{ id: 'one', atMs: 1 }]
  let state = followScroll(initialFollow(original, 10), false)
  state = receiveReplies(state, [...original, { id: 'two', atMs: 11 }])
  expect(state.unread).toBe(1)
  expect(state.following).toBe(false)
  state = receiveReplies(state, [{ id: 'two', atMs: 11 }])
  expect(state.unread).toBe(1)
  state = followScroll(state, true)
  expect(state.unread).toBe(0)
  expect(receiveReplies(state, [{ id: 'three', atMs: 12 }]).unread).toBe(0)
})
test('reconciliation, pruning and clearing cannot create unread replies', () => {
  let state = followScroll(initialFollow([], 10), false)
  state = receiveReplies(state, [{ id: 'historical', atMs: 5 }])
  expect(state.unread).toBe(0)
  state = receiveReplies(state, [])
  state = receiveReplies(state, [{ id: 'historical', atMs: 5 }])
  expect(state.unread).toBe(0)
  expect(initialFollow([], 20)).toMatchObject({ following: true, unread: 0 })
})
test('component arrows wrap, Escape dismisses, Enter and Shift+Enter remain input actions', () => {
  expect(mentionKey('ArrowUp', 0, 3)).toEqual({ index: 2, dismissed: false })
  expect(mentionKey('ArrowDown', 2, 3)).toEqual({ index: 0, dismissed: false })
  expect(mentionKey('Escape', 1, 3)).toEqual({ index: 1, dismissed: true })
  expect(mentionKey('Enter', 1, 3)).toBeUndefined()
  expect(mentionKey('ArrowDown', 0, 0)).toBeUndefined()
})
