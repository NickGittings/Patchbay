import { useContext } from 'react'
import { openInEditor } from '../../lib/navigation'
import { useStore } from '../../store'
import Popover from '../Popover'
import { CloseMenu } from '../menuContext'
import ChangeList from './ChangeList'
import { useComponentChanges } from './useComponentChanges'

function Changes({ componentId }: { componentId: string }) {
  const { files, error, base, task } = useComponentChanges(componentId)
  const close = useContext(CloseMenu)
  return (
    <>
      {error ? (
        <div className="hint file-tree-error">{error}</div>
      ) : !files ? (
        <div className="hint">Loading…</div>
      ) : !files.length ? (
        <div className="hint">No uncommitted changes.</div>
      ) : (
        <ChangeList
          files={files}
          base={base}
          selected={undefined}
          // Closing first unmounts the list, so the rest of a double-click (which ChangeList also
          // handles) can't launch the editor again; a deleted file has nothing to open.
          onSelect={(path) => {
            if (files.find((f) => f.path === path)?.kind === 'deleted') return
            close()
            void openInEditor({ path })
          }}
          task={task}
        />
      )}
      <button
        className="changes-popover-footer"
        onClick={() => {
          close()
          useStore.setState({ reviewFocus: componentId })
          useStore.getState().setView('review')
        }}
      >
        Open in Review
      </button>
    </>
  )
}

export default function ChangesPopover({ componentId }: { componentId: string }) {
  const count = useStore((s) => s.gitChanges[componentId] ?? 0)
  return (
    <div
      className="changes-badge nodrag"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      // The popup is portaled, but React still bubbles its events here; a right-click inside it
      // must not open (and select) the row's or node's component menu over it.
      onContextMenu={(e) => {
        if (e.currentTarget.contains(e.target as Node)) return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <Popover
        label={`±${count}`}
        title={`${count} uncommitted change(s)`}
        triggerClassName="git-badge count nodrag"
        listClassName="changes-popover"
        portal
        caret={false}
        keepMounted={false}
      >
        <Changes componentId={componentId} />
      </Popover>
    </div>
  )
}
