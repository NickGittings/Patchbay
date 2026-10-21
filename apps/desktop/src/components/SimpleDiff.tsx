import { useStore } from '../store'
import { changeGroups } from '../lib/changeGroups'
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
  selection: Selection
  reader: ReturnType<typeof useSimpleData>
}) {
  const nodes = useStore((s) => s.nodes)
  const task = useStore((s) => s.activeTask)
  const groups = changeGroups(nodes, reader.data?.review)
  const file =
    reader.data?.review.changes[selection.componentId]?.find((f) => f.path === selection.path) ??
    null
  const patch = useSimpleUi.getState().patch
  return (
    <div className="simple-diff">
      <header>
        <button onClick={() => patch(scopeKey, { diff: null })}>← Map</button>
        <span>
          {selection.path}
          {selection.line ? `:${selection.line}` : ''}
        </span>
      </header>
      <div className="simple-diff-body">
        <aside>
          {groups.map((g) => (
            <section key={g.id}>
              <h3>{g.name}</h3>
              <ChangeList
                files={g.files}
                base={g.base}
                selected={g.id === selection.componentId ? selection.path : undefined}
                onSelect={(path) => patch(scopeKey, { diff: { componentId: g.id, path } })}
                task={task}
                worktree={reader.source?.path}
              />
            </section>
          ))}
        </aside>
        {file ? (
          <DiffView
            componentId={selection.componentId}
            file={file}
            revision={reader.data?.review}
            worktree={reader.source?.path}
            lineFocus={selection.line}
          />
        ) : (
          <div className="diff-view hint">No diff for {selection.path} in this worktree.</div>
        )}
      </div>
    </div>
  )
}
