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
  reveal = true,
}: {
  files: ChangedFile[]
  base: string
  selected: string | undefined
  onSelect: (path: string) => void
  /** Double-click reveals the file; off when the files are in another worktree. */
  reveal?: boolean
}) {
  return (
    <div className="change-list" role="listbox">
      {files.map((f) => {
        const [dir, name] = splitPath(pathWithin(f.path, base))
        return (
          <button
            key={f.path}
            role="option"
            aria-selected={f.path === selected}
            className={`change-row kind-${f.kind} ${f.path === selected ? 'active' : ''}`}
            title={`${KIND_LABEL[f.kind]}: ${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}`}
            onClick={() => onSelect(f.path)}
            // Reveal rather than open, as in the file tree; a deleted file has nothing to reveal.
            onDoubleClick={() => {
              if (reveal && f.kind !== 'deleted') {
                void revealPath(f.path).catch((e) => useStore.getState().setMessage(String(e)))
              }
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
        )
      })}
    </div>
  )
}
