import type { ChatStepperItem } from '../lib/simpleFlow'
import './auto/auto.css'

const STAGE_LABELS = {
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  merge: 'Merge',
} as const

/**
 * Plan → Build → Review → Merge, as Chat, the Auto panel and the Plan and Review views all show
 * it (`stageModel`). `restore` turns the stage waiting on you into a link back to its actions.
 */
export default function StageStrip({
  items,
  className,
  label = 'Workflow stages',
  restore,
}: {
  items: ChatStepperItem[]
  className?: string
  label?: string
  restore?: { label: string; onRestore: () => void }
}) {
  return (
    <ol className={['auto-stepper', className].filter(Boolean).join(' ')} aria-label={label}>
      {items.map((item) => (
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
          {restore && ['ready', 'attention'].includes(item.state) ? (
            // A dismissed card comes back from the stage it was about.
            <button
              className="chat-stepper-restore"
              aria-label={restore.label}
              title={restore.label}
              onClick={restore.onRestore}
            >
              {STAGE_LABELS[item.stage]}
              {item.note && <small> · {item.note}</small>}
            </button>
          ) : (
            <span>
              {STAGE_LABELS[item.stage]}
              {item.note && <small> · {item.note}</small>}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}
