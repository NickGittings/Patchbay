import { expect, test } from 'vitest'
import { SharedRequests } from './sharedRequests'

test('shares concurrent and completed requests only within the same scope and revision', async () => {
  const cache = new SharedRequests<number>()
  const revision = {}
  let calls = 0
  const load = async () => ++calls
  const first = cache.get('project/task/component', revision, load)
  expect(cache.get('project/task/component', revision, load)).toBe(first)
  await expect(first).resolves.toBe(1)
  expect(cache.get('project/task/component', revision, load)).toBe(first)
  await expect(cache.get('project/other/component', revision, load)).resolves.toBe(2)
  await expect(cache.get('project/task/component', {}, load)).resolves.toBe(3)
})

test('refresh notifies consumers and late failures cannot evict newer requests', async () => {
  const cache = new SharedRequests<number>()
  let fail!: (reason: Error) => void
  const old = cache.get(
    'scope',
    {},
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  await Promise.resolve()
  let notifications = 0
  const unsubscribe = cache.subscribe('scope', () => notifications++)
  cache.invalidate('scope')
  expect(notifications).toBe(1)
  const revision = {}
  const fresh = cache.get('scope', revision, async () => 2)
  fail(new Error('old'))
  await expect(old).rejects.toThrow('old')
  expect(cache.get('scope', revision, async () => 3)).toBe(fresh)
  unsubscribe()
  cache.invalidate('scope')
  expect(notifications).toBe(1)
})

test('failures retry and project eviction removes completed entries', async () => {
  const cache = new SharedRequests<number>()
  const revision = {}
  await expect(
    cache.get('scope', revision, async () => {
      throw new Error('retry')
    }),
  ).rejects.toThrow('retry')
  await expect(cache.get('scope', revision, async () => 1)).resolves.toBe(1)
  cache.retain(() => false)
  await expect(cache.get('scope', revision, async () => 2)).resolves.toBe(2)
})
