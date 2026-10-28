import { createContext } from 'react'
import type { ChangeRef } from '../../lib/changeNav'

/** Navigation's artifact reader supplies exactly the files SimpleDiff lists. */
export const SimpleChangesContext = createContext<{ files: ChangeRef[]; newest?: ChangeRef }>({
  files: [],
})
