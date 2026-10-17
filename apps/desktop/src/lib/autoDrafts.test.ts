import { beforeEach, expect, test } from 'vitest'
import {
  autoDraftKey,
  autoDrafts,
  emptyAutoDraft,
  forgetAutoDrafts,
  savedAutoDraft,
} from './autoDrafts'

beforeEach(() => autoDrafts.clear())

const keep = (projectId: string, task: string | null) =>
  autoDrafts.set(autoDraftKey(projectId, task), {
    ...emptyAutoDraft(),
    goal: `${projectId}/${task}`,
  })

test("a removed worktree's draft goes, its project's other drafts stay", () => {
  keep('p', null)
  keep('p', 't')
  keep('q', 't')
  forgetAutoDrafts('p', (t) => t === 't')
  expect([...autoDrafts.keys()]).toEqual([autoDraftKey('p', null), autoDraftKey('q', 't')])
})

test("a closed project's drafts all go", () => {
  keep('p', null)
  keep('p', 't')
  keep('q', null)
  forgetAutoDrafts('p')
  expect([...autoDrafts.keys()]).toEqual([autoDraftKey('q', null)])
})

test('a blank goal or destination is inferred again rather than kept', () => {
  const draft = { ...emptyAutoDraft(), goal: '  \n ', destination: '', mode: 'auto' as const }
  expect(savedAutoDraft(draft)).toEqual({ ...draft, goal: undefined, destination: undefined })
  expect(savedAutoDraft({ ...draft, goal: ' Goal ' }).goal).toBe(' Goal ')
})
