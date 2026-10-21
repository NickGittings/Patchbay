import { useClockTick } from '../../lib/clock'
import { ago, validations, type Validation } from '../../lib/review'
import { startTerminal } from '../../lib/sessions'
import { useStore } from '../../store'

const LABEL: Record<Validation['state'], string> = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  stale: 'stale',
  notRun: 'not run',
}

function describe({ state, session }: Validation) {
  if (state === 'notRun' || !session) return 'Not run in this session'
  if (state === 'running') return `Started ${ago(session.startedMs ?? Date.now())}`
  const when = session.exitedMs ? ` ${ago(session.exitedMs)}` : ''
  const result = `exited ${session.exitCode}${when}`
  return state === 'stale' ? `Started before the latest change; ${result}` : result
}

/**
 * Which of a component's task terminals ran since `changedAt` (in `task`'s worktree, by default
 * the active task's), with a button to (re)run those that didn't pass after the change.
 */
export default function ValidationChips({
  componentId,
  changedAt,
  task: taskProp,
}: {
  componentId: string
  changedAt: number | undefined
  task?: string | null
}) {
  const activeTask = useStore((s) => s.activeTask)
  const task = taskProp === undefined ? activeTask : taskProp
  const terminals = useStore((s) => s.nodes.find((n) => n.id === componentId)?.data.terminals)
  const sessions = useStore((s) => s.sessions)
  useClockTick()
  const checks = validations(componentId, terminals ?? [], sessions, changedAt, task)
  if (!checks.length) return null
  return (
    <div className="validation-chips">
      {checks.map((v) => (
        <span
          key={v.terminal.id}
          className={`validation-chip ${v.state}`}
          title={`${v.terminal.command}\n${describe(v)}`}
        >
          {v.terminal.name}: {LABEL[v.state]}
          {v.state !== 'running' && v.state !== 'passed' && (
            <button
              title={`Run ${v.terminal.name}`}
              aria-label={`Run ${v.terminal.name}`}
              onClick={() =>
                void startTerminal(componentId, v.terminal.id, task).catch((e) =>
                  useStore.getState().setMessage(String(e)),
                )
              }
            >
              ▶
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
