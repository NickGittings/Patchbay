import { useEffect, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { componentPaths } from '../../lib/git'
import { gitChanges } from '../../lib/ipc'
import { latestChange } from '../../lib/review'
import { useStore } from '../../store'
import type { ChangedFile } from '../../types'
import ChangeList from './ChangeList'
import DiffView from './DiffView'
import ValidationChips from './ValidationChips'

/** One component's uncommitted changes, its validation status, and the selected file's diff. */
export default function ChangesPanel({ componentId }: { componentId: string }) {
  // A new object on every Git refresh (pop-outs get it over `patchbay://git`), so the list
  // also reloads when an edit leaves the change count as it was.
  const revision = useStore((s) => s.gitChanges)
  const base = useStore((s) => s.nodes.find((n) => n.id === componentId)?.data.path ?? '.')
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string>()
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let disposed = false
    void gitChanges(componentPaths(), componentId)
      .then((list) => {
        if (!disposed) {
          setFiles(list)
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [componentId, base, revision, refresh])

  const file = files?.find((f) => f.path === selected) ?? files?.[0] ?? null
  return (
    <div className="changes-panel">
      <div className="changes-header">
        <span className="panel-title">
          Changes{files && files.length > 0 && <span className="git-badge">±{files.length}</span>}
        </span>
        <button title="Refresh changes" onClick={() => setRefresh((n) => n + 1)}>
          ↻ Refresh
        </button>
      </div>
      <ValidationChips componentId={componentId} changedAt={latestChange(files ?? undefined)} />
      {error ? (
        <div className="hint file-tree-error">{error}</div>
      ) : !files ? (
        <div className="hint">Loading…</div>
      ) : !files.length ? (
        <div className="hint">No uncommitted changes.</div>
      ) : (
        <Group orientation="vertical" className="changes-split">
          <Panel defaultSize="35" minSize="15">
            <ChangeList files={files} base={base} selected={file?.path} onSelect={setSelected} />
          </Panel>
          <Separator className="separator horizontal" />
          <Panel defaultSize="65" minSize="20">
            <DiffView componentId={componentId} file={file} revision={revision} />
          </Panel>
        </Group>
      )}
    </div>
  )
}
