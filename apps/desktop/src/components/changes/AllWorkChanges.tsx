import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../store'
import type { Task } from '../../types'
import { STAGE_LABELS, STATUS_LABELS } from '../../lib/autoSettings'
import { autoOf } from '../../lib/chatHome'
import { focusWork, useAllWorkOn } from '../../lib/workFocus'

type Row = Pick<Task, 'title' | 'branch'> & { id: string | null }

/**
 * All work in Changes: one row per open worktree (branch, linked story, Auto stage), so the
 * changes of any of the lead's worktrees are a click away. The list below shows the focused one.
 */
export default function AllWorkChanges() {
  const on = useAllWorkOn()
  const tasks = useStore(useShallow((s) => s.tasks.filter((t) => !t.missing)))
  if (!on) return null
  const rows: Row[] = [{ id: null, title: 'Project folder', branch: undefined }, ...tasks]
  return (
    <nav className="all-work-changes" aria-label="All work">
      {rows.map((row) => (
        <WorkRow key={row.id ?? ''} row={row} />
      ))}
    </nav>
  )
}

function WorkRow({ row }: { row: Row }) {
  const current = useStore((s) => s.activeTask === row.id)
  const story = useStore((s) =>
    row.id ? s.stories.find((item) => item.task === row.id) : undefined,
  )
  const run = useStore((s) => autoOf(s, row.id))
  return (
    <button
      className={current ? 'active' : ''}
      aria-current={current || undefined}
      onClick={() => focusWork(row.id, { keepAllWork: true })}
    >
      <strong>{row.title}</strong>
      {row.branch && <span> · {row.branch}</span>}
      {story && <span className="all-work-story">{story.title}</span>}
      {run && (
        <span className={`story-stage ${run.status}`}>
          {run.stage === 'done'
            ? STATUS_LABELS[run.status]
            : `${STAGE_LABELS[run.stage]} · ${STATUS_LABELS[run.status]}`}
        </span>
      )}
    </button>
  )
}
