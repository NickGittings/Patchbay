import { useRef } from 'react'
import { StoryViewTabs } from './stories/StoryBoard'
import { useStepKeys } from './changes/useStepKeys'
import { useStore } from '../store'
import { changePosition, stepChange } from '../lib/changeNav'
import { useSimpleUi, type SimpleDiff as Selection } from '../lib/simpleUi'
import type { useSimpleData } from '../lib/useSimpleData'
import ChangeList from './changes/ChangeList'
import DiffView from './changes/DiffView'

export default function SimpleDiff({
  scopeKey,
  selection,
  reader,
}: {
  scopeKey: string
  selection?: Selection | null
  reader: ReturnType<typeof useSimpleData>
}) {
  const task = useStore((s) => s.activeTask)
  const { groups, files: order } = reader
  const file = selection
    ? (reader.data?.review.changes[selection.componentId]?.find((f) => f.path === selection.path) ??
      null)
    : null
  const patch = useSimpleUi.getState().patch
  const step = (delta: -1 | 1) => {
    const next = stepChange(order, selection, delta)
    if (next) patch(scopeKey, { diff: next })
  }
  const body = useRef<HTMLDivElement>(null)
  useStepKeys(step, [body])
  const nav = { position: changePosition(order, selection), total: order.length, step }
  return (
    <div className="simple-diff">
      <header className="view-tabs-header">
        <StoryViewTabs />
      </header>
      <div className="simple-diff-body" ref={body}>
        <aside>
          {groups.map((g) => (
            <section key={g.id}>
              <h3>{g.name}</h3>
              <ChangeList
                files={g.files}
                base={g.base}
                selected={g.id === selection?.componentId ? selection.path : undefined}
                onSelect={(path) => patch(scopeKey, { diff: { componentId: g.id, path } })}
                onStep={step}
                task={task}
                worktree={reader.source?.path}
              />
            </section>
          ))}
        </aside>
        {file && selection ? (
          <DiffView
            componentId={selection.componentId}
            file={file}
            revision={reader.data?.review}
            worktree={reader.source?.path}
            lineFocus={selection.line}
            nav={nav}
          />
        ) : (
          <div className="diff-view hint">
            {!order.length
              ? 'No uncommitted changes'
              : selection
                ? `No diff for ${selection.path} in this worktree.`
                : 'Select a changed file.'}
          </div>
        )}
      </div>
    </div>
  )
}
