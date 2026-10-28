import { useEffect } from 'react'
import { stepKey } from '../../lib/changeNav'

/** WebKit leaves focus on body when a view first opens. Never steal another control's keys. */
export function useStepKeys(step: (delta: -1 | 1) => void) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (document.activeElement && document.activeElement !== document.body)
      )
        return
      const delta = stepKey(event, 'list')
      if (delta) {
        event.preventDefault()
        step(delta)
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [step])
}
