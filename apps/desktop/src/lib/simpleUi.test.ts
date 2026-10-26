import { expect, test } from 'vitest'
import { simpleKey, useSimpleUi } from './simpleUi'
test('drafts and drawer intent are independent per worktree', () => {
  useSimpleUi.setState({ worktrees: {} })
  const a = simpleKey('p', null),
    b = simpleKey('p', 't')
  useSimpleUi.getState().patch(a, { draft: 'project', terminal: 'user' })
  useSimpleUi.getState().patch(b, { terminal: 'input' })
  expect(useSimpleUi.getState().worktrees[a]).toMatchObject({ draft: 'project', terminal: 'user' })
  useSimpleUi.getState().patch(b, { terminal: 'closed' })
  expect(useSimpleUi.getState().worktrees[a].terminal).toBe('user')
})
