import { createContext } from 'react'
import type { ChangeRef } from '../../lib/changeNav'

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
