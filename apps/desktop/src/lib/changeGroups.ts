import type { FlowNode } from '../store'
import type { ChangedFile, Review } from '../types'
import { PROJECT_SCOPE } from '../types'
import { KIND_COLOR } from './display'

export interface ChangeGroup {
  id: string
  name: string
  color: string
  base: string
  files: ChangedFile[]
}
/** File lists come from gitReview, never gitChanges' counts. Shared by Full and Simple. */
export function changeGroups(nodes: readonly FlowNode[], review?: Review | null): ChangeGroup[] {
  if (!review) return []
  const groups = nodes.flatMap((n) => {
    const files = review.changes[n.id]
    return files?.length
      ? [{ id: n.id, name: n.data.name, color: KIND_COLOR[n.data.kind], base: n.data.path, files }]
      : []
  })
  const loose = review.changes[PROJECT_SCOPE]
  if (loose?.length)
    groups.push({ id: PROJECT_SCOPE, name: 'Project files', color: '', base: '.', files: loose })
  return groups
}
