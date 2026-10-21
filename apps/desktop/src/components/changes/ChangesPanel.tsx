import PersistedGroup from '../PersistedGroup'
import { useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { latestChange, lineTotals } from '../../lib/review'
import { activeWorktree } from '../../lib/tasks'
import { useStore } from '../../store'
import ChangeList from './ChangeList'
import DiffStat from './DiffStat'
import DiffView from './DiffView'
import ValidationChips from './ValidationChips'
import { useComponentChanges } from './useComponentChanges'
import EmptyState from '../EmptyState'

/** One component's uncommitted changes, its validation status, and the selected file's diff. */
export default function ChangesPanel({ componentId }: { componentId: string }) {
  const [selected, setSelected] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  // `revision` is a new object on every Git refresh (pop-outs get it over `patchbay://git`), so
  // the list also reloads when an edit leaves the change count as it was.
  const { files, error, base, task, revision } = useComponentChanges(componentId, refresh)
  const worktree = useStore(activeWorktree)

  const file = files?.find((f) => f.path === selected) ?? files?.[0] ?? null
  return (
    <div className="changes-panel">
      <div className="changes-header">
        <span className="panel-title">
          Changes{files && files.length > 0 && <span className="git-badge">±{files.length}</span>}
          {files && files.length > 0 && <DiffStat {...lineTotals(files)} />}
        </span>
        <button
          title="Refresh changes"
          aria-label="Refresh changes"
          onClick={() => setRefresh((n) => n + 1)}
        >
          ↻
        </button>
      </div>
      <ValidationChips componentId={componentId} changedAt={latestChange(files ?? undefined)} />
      {error ? (
        <div className="hint file-tree-error">{error}</div>
      ) : !files ? (
        <div className="hint">Loading…</div>
      ) : !files.length ? (
        <EmptyState icon="✓" title="No uncommitted changes" />
      ) : (
        <PersistedGroup layoutId="ChangesPanel-1" orientation="vertical" className="changes-split">
          <Panel id="ChangesPanel-pane-1" defaultSize="35" minSize="15">
            <ChangeList
              files={files}
              base={base}
              selected={file?.path}
              onSelect={setSelected}
              task={task}
              worktree={worktree}
            />
          </Panel>
          <Separator className="separator horizontal" />
          <Panel id="ChangesPanel-pane-2" defaultSize="65" minSize="20">
            <DiffView
              componentId={componentId}
              file={file}
              revision={revision}
              worktree={worktree}
            />
          </Panel>
        </PersistedGroup>
      )}
    </div>
  )
}
