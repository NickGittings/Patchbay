import { moveComponents, projectOf, useStore, type MessageAction } from '../store'
import { dependencyMapBlocked } from './dependencies'
import { arrange, type Position } from './layout'

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

/**
 * Lay out `projectId`'s whole map by its dependencies (`layout.ts`), as an ordinary edit. Returns
 * the positions it replaced, or null when the map is blocked or nothing moved.
 */
export function arrangeMap(projectId: string): Record<string, Position> | null {
  const project = projectOf(projectId)
  if (!project || dependencyMapBlocked(useStore.getState().projects[projectId])) return null
  return moved(projectId, arrange(project.components, project.links))
}

/** Undo for an arrangement: puts the components still on the map back where they were. */
export function undoArrange(projectId: string, previous: Record<string, Position>): MessageAction {
  return {
    label: 'Undo',
    run: () => {
      moved(projectId, previous)
      useStore.getState().setMessage('Restored the previous layout', true)
    },
  }
}

/** Project → Arrange map. */
export function arrangeNow(projectId: string) {
  const previous = arrangeMap(projectId)
  const s = useStore.getState()
  if (previous)
    s.setMessage('Arranged the map by dependencies', true, undoArrange(projectId, previous))
  else s.setMessage('The map is already arranged', true)
}
