import CommitHistory from './changes/CommitHistory'
import CommitDetails from './changes/CommitDetails'
import type { HistorySelection } from '../lib/history'
import { useRef, useState } from 'react'
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
  const [history, setHistory] = useState<HistorySelection | null>(null)
  const task = useStore((s) => s.activeTask)
  const { groups, files: order } = reader
  const file = selection
    ? (reader.data?.review.changes[selection.componentId]?.find((f) => f.path === selection.path) ??
      null)
    : null
  const patch = useSimpleUi.getState().patch
  const step = (delta: -1 | 1) => {
    if (history) return
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
          <div className="hint">
            {reader.base ? `Changes since merge base with ${reader.base}` : 'Uncommitted changes'}
          </div>
          {groups.map((g) => (
            <section key={g.id}>
              <h3>{g.name}</h3>
              <ChangeList
                files={g.files}
                base={g.base}
                selected={!history && g.id === selection?.componentId ? selection.path : undefined}
                onSelect={(path) => {
                  setHistory(null)
                  patch(scopeKey, { diff: { componentId: g.id, path } })
                }}
                onStep={step}
                task={task}
                worktree={reader.source?.path}
              />
            </section>
          ))}
          <CommitHistory worktree={reader.source?.path} selected={history} onSelect={setHistory} />
        </aside>
        {history ? (
          <CommitDetails onSelect={setHistory} selection={history} worktree={reader.source?.path} />
        ) : file && selection ? (
          <DiffView
            base={reader.base}
            componentId={selection.componentId}
            file={file}
            revision={reader.data?.review}
            worktree={reader.source?.path}
            lineFocus={selection.line}
            nav={nav}
          />
        ) : (
          <div className="diff-view hint">
            {reader.error
              ? `Could not load changes: ${reader.error}`
              : selection
                ? `Diff unavailable: ${selection.path} is no longer changed in this comparison.`
                : !order.length
                  ? reader.base
                    ? `No changes since merge base with ${reader.base}.`
                    : 'No uncommitted changes.'
                  : 'Select a changed file.'}
          </div>
        )}
      </div>
    </div>
  )
}
