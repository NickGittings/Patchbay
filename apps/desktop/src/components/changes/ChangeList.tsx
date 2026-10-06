import { navigationError, openInEditor, revealLabel } from '../../lib/navigation'
import { revealPath } from '../../lib/ipc'
import { KIND_LABEL, KIND_LETTER, pathWithin, splitPath } from '../../lib/review'
import { useStore } from '../../store'
import type { ChangedFile } from '../../types'
import DiffStat from './DiffStat'

/** A component's changed files; `base` is its folder, so paths show relative to it. */
export default function ChangeList({
  files,
  base,
  selected,
  onSelect,
  worktree,
  task,
}: {
  files: ChangedFile[]
  base: string
  selected: string | undefined
  onSelect: (path: string) => void
  /** Explicit review worktree; task is null when reviewing the open workspace. */
  worktree?: string
  task?: string | null
}) {
  const projectId = useStore((s) => s.project?.id)
  const activeTask = useStore((s) => s.activeTask)
  const originTask = task === undefined ? activeTask : task
  return (
    <div className="change-list" role="listbox">
      {files.map((f) => {
        const [dir, name] = splitPath(pathWithin(f.path, base))
        return (
          <div className="change-file-row" key={f.path}>
            <button
              role="option"
              aria-selected={f.path === selected}
              className={`change-row kind-${f.kind} ${f.path === selected ? 'active' : ''}`}
              title={`${KIND_LABEL[f.kind]}: ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`}
              onClick={() => onSelect(f.path)}
              onDoubleClick={() => {
                if (f.kind !== 'deleted' && projectId)
                  void openInEditor({ path: f.path }, { projectId, task: originTask, worktree })
              }}
            >
              <span className={`kind-pill letter kind-${f.kind}`}>{KIND_LETTER[f.kind]}</span>
              <span className="change-path">
                <span className="path-name">{name}</span>
                {dir && (
                  // Isolated so the right-to-left ellipsis trick keeps the slashes in place.
                  <span className="path-dir">
                    <bdi>{dir.slice(0, -1)}</bdi>
                  </span>
                )}
              </span>
              <DiffStat added={f.added} removed={f.removed} />
            </button>
            {f.kind !== 'deleted' && projectId && (
              <>
                <button
                  className="change-file-action"
                  title="Open in editor"
                  aria-label={`Open ${name} in editor`}
                  onClick={() =>
                    void openInEditor({ path: f.path }, { projectId, task: originTask, worktree })
                  }
                >
                  ↗
                </button>
                <button
                  className="change-file-action"
                  title={revealLabel}
                  aria-label={`${revealLabel}: ${name}`}
                  onClick={() =>
                    void revealPath(f.path, worktree, projectId, originTask).catch(navigationError)
                  }
                >
                  ⌖
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
