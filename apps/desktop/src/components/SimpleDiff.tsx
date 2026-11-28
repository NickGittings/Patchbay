import CommitDetails from './changes/CommitDetails'
import { setChosenCommit as setHistory, useChosenCommit } from '../lib/gitSync'
import ReviewContext from './changes/ReviewContext'
import { useRef, useState } from 'react'
import { StoryViewTabs } from './stories/StoryBoard'
import { useStepKeys } from './changes/useStepKeys'
import { useStore } from '../store'
import { changePosition, changeRefs, resolveChangeSelection, stepChange } from '../lib/changeNav'
import { useSimpleUi, type SimpleDiff as Selection } from '../lib/simpleUi'
import type { useSimpleData } from '../lib/useSimpleData'
import ChangeList from './changes/ChangeList'
import AllWorkChanges from './changes/AllWorkChanges'
import DiffView from './changes/DiffView'
import DiffStat from './changes/DiffStat'
import ChangeGroupCard from './changes/ChangeGroupCard'
import PanelStatus from './PanelStatus'
import EmptyState from './EmptyState'
import { plural } from '../lib/display'
import { lineTotals } from '../lib/review'

interface Props {
  scopeKey: string
  selection?: Selection | null
  reader: ReturnType<typeof useSimpleData>
}

export default function SimpleDiff(props: Props) {
  // Local disclosures belong to one conversation's worktree.
  return (
    <ChangesContent key={JSON.stringify([props.scopeKey, props.reader.scope.path])} {...props} />
  )
}

function ChangesContent({ scopeKey, selection, reader }: Props) {
  // The Git panel chooses a commit; it opens here, in place of a change's diff.
  const chosen = useChosenCommit()
  const history = chosen?.selection ?? null
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const task = useStore((s) => s.activeTask)
  const title = useStore((s) => s.tasks.find((t) => t.id === task)?.title)
  const { groups, files } = reader
  const order = changeRefs(groups.filter((g) => !collapsed[g.id]))
  // Findings can be clicked while the comparison reloads and its file list is empty.
  // Resolve their path again when files arrive, preserving explicit listed selections.
  const selected = resolveChangeSelection(files, selection, reader.source?.path)
  const file = selected
    ? (reader.data?.review?.changes[selected.componentId]?.find((f) => f.path === selected.path) ??
      null)
    : null
  const patch = useSimpleUi.getState().patch
  const step = (delta: -1 | 1) => {
    if (history) return
    const next = stepChange(order, selected, delta)
    if (next) patch(scopeKey, { diff: next })
  }
  const body = useRef<HTMLDivElement>(null)
  useStepKeys(step, [body])
  const nav = { position: changePosition(order, selected), total: order.length, step }
  return (
    <div className="simple-diff">
      <header className="view-tabs-header">
        <StoryViewTabs />
      </header>
      <div className="simple-diff-body" ref={body}>
        <aside className="review-list" aria-label="Changed files">
          <AllWorkChanges />
          <div className="review-header">
            <ReviewContext
              title={title}
              source={reader.source}
              base={reader.base}
              totals={
                reader.data &&
                files.length > 0 && (
                  <>
                    {plural(files.length, 'file')}
                    <DiffStat {...lineTotals(groups.flatMap((g) => g.files))} />
                  </>
                )
              }
              action={
                <button
                  className="review-refresh"
                  title="Refresh changes"
                  aria-label="Refresh changes"
                  onClick={reader.retry}
                >
                  ↻
                </button>
              }
            />
          </div>
          {reader.error ? (
            <PanelStatus
              kind="error"
              message="Could not load changes."
              details={reader.error}
              onRetry={reader.retry}
            />
          ) : !reader.data ? (
            <PanelStatus kind="loading" message="Loading changes…" />
          ) : !groups.length ? (
            <EmptyState compact tone="ok" icon="✓" title="Nothing to review">
              {reader.base
                ? `No changes since merge base with ${reader.base}.`
                : 'No uncommitted changes.'}
            </EmptyState>
          ) : null}
          {groups.map((g) => {
            const open = !collapsed[g.id]
            return (
              <ChangeGroupCard
                key={g.id}
                group={g}
                open={open}
                onToggle={() => setCollapsed((value) => ({ ...value, [g.id]: open }))}
                task={task}
              >
                <ChangeList
                  files={g.files}
                  base={g.base}
                  selected={!history && g.id === selected?.componentId ? selected.path : undefined}
                  onSelect={(path) => {
                    setHistory(null)
                    patch(scopeKey, { diff: { componentId: g.id, path } })
                  }}
                  onStep={step}
                  task={task}
                  worktree={reader.source?.path}
                />
              </ChangeGroupCard>
            )
          })}
        </aside>
        {history ? (
          <CommitDetails onSelect={setHistory} selection={history} worktree={chosen?.worktree} />
        ) : file && selected ? (
          <DiffView
            base={reader.base}
            componentId={selected.componentId}
            file={file}
            revision={reader.data?.review}
            worktree={reader.source?.path}
            lineFocus={selected.line}
            nav={nav}
          />
        ) : (
          <div className="diff-view hint">
            {reader.error
              ? `Could not load changes: ${reader.error}`
              : selection
                ? `Diff unavailable: ${selection.path} is no longer changed in this comparison.`
                : !files.length
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
