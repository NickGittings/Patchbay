import { SIMPLE_STAGES, type SimpleStage } from '../lib/simple'
import { useSimpleUi } from '../lib/simpleUi'

const tabs = ['all', ...SIMPLE_STAGES] as const

/** Chat mode's stage filter, at the top of the worktree chat. */
export default function SimpleStageTabs({
  scopeKey,
  current,
}: {
  scopeKey: string
  current: SimpleStage
}) {
  const filter = useSimpleUi((s) => s.worktrees[scopeKey]?.stageFilter ?? 'all')
  return (
    <div className="view-tabs simple-stage-tabs" role="group" aria-label="Chat stage">
      {tabs.map((tab) => (
        <button
          key={tab}
          aria-pressed={filter === tab}
          className={filter === tab ? 'active' : ''}
          title={tab === 'all' ? 'Show every stage' : `Show only ${tab}`}
          onClick={() => useSimpleUi.getState().patch(scopeKey, { stageFilter: tab })}
        >
          {tab[0].toUpperCase() + tab.slice(1)}
          {tab === current && (
            <span className="simple-stage-current" title="Current stage">
              ●
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
