import { createContext } from 'react'
import type { ChangeRef } from '../../lib/changeNav'
import type { SimpleWorktree } from '../../lib/simple'

/** Navigation's artifact reader supplies exactly the files SimpleDiff lists. */
export interface SimpleChanges {
  files: ChangeRef[]
  newest?: ChangeRef
  bySession: ReadonlyMap<string, ChangeRef>
}
export const SimpleChangesContext = createContext<SimpleChanges>({
  files: [],
  bySession: new Map(),
})
/** The worktree Navigation's Chat is showing. */
export const SimpleWorktreeContext = createContext<SimpleWorktree | undefined>(undefined)
