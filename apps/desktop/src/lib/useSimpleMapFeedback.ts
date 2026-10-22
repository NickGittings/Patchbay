import { useEffect } from 'react'
import { useStore } from '../store'
import { activeComponents } from './activity'
import { useSimpleMap } from './simpleUi'
export function useSimpleMapFeedback(visible: boolean) {
  useEffect(() => {
    if (!visible) {
      useSimpleMap.setState({ active: [] })
      return
    }
    const update = () => {
      const s = useStore.getState()
      if (!s.project) return
      const worktree = s.tasks.find((t) => t.id === s.activeTask)?.worktree ?? s.project.root
      const active = [
        ...activeComponents(
          s.sessionRecords,
          s.sessions,
          s.project.id,
          s.activeTask,
          worktree,
          s.nodes.map((n) => ({ id: n.id, path: n.data.path })),
          Date.now(),
        ),
      ].sort()
      if (active.join('\0') !== useSimpleMap.getState().active.join('\0'))
        useSimpleMap.setState({ active })
    }
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (
        s.sessions !== prev.sessions ||
        s.activeTask !== prev.activeTask ||
        s.project !== prev.project
      )
        update()
    })
    update()
    const timer = setInterval(update, 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
      useSimpleMap.setState({ active: [] })
    }
  }, [visible])
}
