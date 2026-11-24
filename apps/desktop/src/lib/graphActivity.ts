import { useStore } from '../store'

/** Whether a validation or environment start is running, which Apply and run waits for. */
export function useGraphActionRunning() {
  return useStore(
    (s) =>
      s.graphActionBusy ||
      Object.values(s.taskActivities).some(
        (a) =>
          a.state === 'running' &&
          ['validate', 'validateChanged', 'validateSelected', 'environmentStart'].includes(
            a.action.kind,
          ),
      ),
  )
}
