import type { ReactNode } from 'react'
import { shortSha } from '../../lib/commitId'
import type { Worktree } from '../../types'

/**
 * Which worktree and comparison a change list shows: title and branch on one line, the
 * comparison (with optional totals) beneath, and the path one click away. Shared by Review and
 * Chat's Changes. `action` sits at the end of the title line, for a header with no action row.
 */
export default function ReviewContext({
  title,
  source,
  base,
  totals,
  action,
}: {
  title: string | undefined
  source: Worktree | undefined
  base: string | null | undefined
  totals?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="review-context">
      <div className="review-context-title">
        <strong>{title ?? 'Main worktree'}</strong>
        <code>
          {source?.branch ?? (source ? `detached ${shortSha(source.head)}` : 'Resolving branch…')}
        </code>
        {action}
      </div>
      <div className="review-context-meta">
        <span>{base ? `Changes since merge base with ${base}` : 'Uncommitted changes'}</span>
        {totals && <span className="review-totals">{totals}</span>}
      </div>
      {source?.path && (
        <details>
          <summary>Worktree location</summary>
          <code>{source.path}</code>
        </details>
      )}
    </div>
  )
}
