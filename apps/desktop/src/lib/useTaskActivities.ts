import { useEffect } from 'react'
import { useStore } from '../store'
import { taskActivities } from './ipc'
import { applyTaskActivity } from './tasks'

/** Keep activity counts current even while the utility panel is closed. */
export function useTaskActivities() {
  const projectId = useStore((s) => s.project?.id)
  useEffect(() => {
    if (!projectId) return
    let live = true
    void taskActivities(projectId)
      .then((list) => {
        if (live) for (const activity of list) applyTaskActivity(activity)
      })
      .catch((e) => {
        if (live) useStore.getState().setMessage(String(e))
      })
    return () => {
      live = false
    }
  }, [projectId])
}
