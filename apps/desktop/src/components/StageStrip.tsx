import type { ChatStepperItem } from '../lib/simpleFlow'
import './auto/auto.css'

/** States whose note says why you're needed or why work halted: shown, not left to a hover. */
const NOTE_SHOWN = ['ready', 'attention', 'stopped', 'failed']

const STAGE_LABELS = {
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  merge: 'Merge',
} as const

/**
 * Plan → Build → Review → Merge, as Chat and the Auto panel show it (`stageModel`).
 * A note shows beside its stage when the stage waits on you or halted; otherwise it is a tooltip,
 * still read by screen readers.
 */
export default function StageStrip({
  items,
  className,
  label = 'Workflow stages',
}: {
  items: ChatStepperItem[]
  className?: string
  label?: string
}) {
  return (
    <ol className={['auto-stepper', className].filter(Boolean).join(' ')} aria-label={label}>
      {items.map((item) => {
        const name = STAGE_LABELS[item.stage]
        const note = item.note && (
          <small className={NOTE_SHOWN.includes(item.state) ? undefined : 'stage-note-hidden'}>
            {` · ${item.note}`}
          </small>
        )
        return (
          <li
            key={item.stage}
            aria-current={
              ['current', 'ready', 'attention', 'stopped', 'failed'].includes(item.state)
                ? 'step'
                : undefined
            }
            data-state={item.state}
            title={item.note}
          >
            <span>
              {name}
              {note}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
