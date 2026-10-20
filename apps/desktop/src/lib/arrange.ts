import { moveComponents, projectOf, projectStateOf, useStore, type MessageAction } from '../store'
import { mapEditsBlocked } from './mapSave'
import { arrange, type Position } from './layout'

interface Arrangement {
  before: Record<string, Position>
  after: Record<string, Position>
}

type Listener = (projectId: string, from: Record<string, Position>) => void
const listeners = new Set<Listener>()

/**
 * Hear when a project's components were moved together, with where the moved ones were, so the
 * canvas can follow them.
 */
export function onArranged(listener: Listener) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function moved(projectId: string, positions: Record<string, Position>) {
  const previous = moveComponents(projectId, positions)
  if (previous) for (const listener of listeners) listener(projectId, previous)
  return previous
}

/** Lay out the map as an ordinary edit, recording both ends of the move for conditional Undo. */
export function arrangeMap(projectId: string): Arrangement | null {
  const project = projectOf(projectId)
  if (
    !project ||
    project.components.length < 2 ||
    mapEditsBlocked(useStore.getState().projects[projectId])
  )
    return null
  const after = arrange(project.components, project.links)
  const before = moved(projectId, after)
  return before ? { before, after } : null
}

/** Restore only nodes still at the arranged position, preserving later drags and other edits. */
export function undoArrange(projectId: string, { before, after }: Arrangement): MessageAction {
  return {
    label: 'Undo layout',
    projectId,
    run: () => {
      const s = useStore.getState()
      if (s.project?.id !== projectId) return
      if (mapEditsBlocked(s.projects[projectId])) {
        s.setMessage('Resolve the map conflict or project recovery before undoing the layout')
        return
      }
      const positions: Record<string, Position> = {}
      for (const node of projectStateOf(projectId)?.nodes ?? []) {
        const expected = after[node.id]
        if (
          before[node.id] &&
          expected &&
          !node.dragging &&
          node.position.x === expected.x &&
          node.position.y === expected.y
        )
          positions[node.id] = before[node.id]
      }
      const restored = moved(projectId, positions)
      const count = Object.keys(restored ?? {}).length
      s.setMessage(
        count === Object.keys(before).length
          ? 'Restored the previous layout'
          : count
            ? 'Restored previous positions; kept later layout edits'
            : 'No layout positions to restore; kept later edits',
        true,
      )
    },
  }
}

/** Project → Arrange map. */
export function arrangeNow(projectId: string) {
  const s = useStore.getState()
  if (s.project?.id !== projectId) return
  if (mapEditsBlocked(s.projects[projectId])) {
    s.setMessage('Resolve the map conflict or project recovery before arranging the map')
    return
  }
  if (s.nodes.length < 2) {
    s.setMessage('Add at least two components before arranging the map', true)
    return
  }
  const arrangement = arrangeMap(projectId)
  if (arrangement)
    s.setMessage('Arranged the map by dependencies', true, undoArrange(projectId, arrangement))
  else s.setMessage('The map is already arranged', true)
}
