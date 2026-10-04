import { revealPath } from '../../lib/ipc'
import { pathWithin } from '../../lib/review'
import { useStore } from '../../store'
import type { ChangedFile, ChangeKind } from '../../types'

const LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  typeChanged: 'T',
  conflicted: 'U',
  untracked: '?',
}

/** A component's changed files; `base` is its folder, so paths show relative to it. */
export default function ChangeList({
  files,
  base,
  selected,
  onSelect,
}: {
  files: ChangedFile[]
  base: string
  selected: string | undefined
  onSelect: (path: string) => void
}) {
  return (
    <div className="change-list" role="listbox">
      {files.map((f) => (
        <button
          key={f.path}
          role="option"
          aria-selected={f.path === selected}
          className={`change-row kind-${f.kind} ${f.path === selected ? 'active' : ''}`}
          title={`${f.kind}: ${f.path}`}
          onClick={() => onSelect(f.path)}
          // Reveal rather than open, as in the file tree; a deleted file has nothing to reveal.
          onDoubleClick={() => {
            if (f.kind !== 'deleted') {
              void revealPath(f.path).catch((e) => useStore.getState().setMessage(String(e)))
            }
          }}
        >
          <span className="change-letter">{LETTER[f.kind]}</span>
          <span className="change-path">
            {f.oldPath && <span className="change-old">{pathWithin(f.oldPath, base)} → </span>}
            {pathWithin(f.path, base)}
          </span>
        </button>
      ))}
    </div>
  )
}
