import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { enableWorktreeSetup, worktreeSetup } from '../../lib/ipc'
import { TASK_ROOT_SCOPE, type WorktreeSetup } from '../../types'
import TerminalPane from '../TerminalPane'
import { selectPanel } from '../../lib/rail'

export default function WorktreeSetupStatus({ notice = false }: { notice?: boolean }) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const [setup, setSetup] = useState<WorktreeSetup | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!projectId || !task) return
    let disposed = false
    const refresh = () =>
      void worktreeSetup(projectId, task)
        .then((s) => {
          if (!disposed) setSetup(s)
        })
        .catch((e) => {
          if (!disposed) setError(String(e))
        })
    refresh()
    const timer = setInterval(refresh, 750)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [projectId, task])
  if (!task || !projectId) return null
  const action = (name: string, enable = false) => {
    setBusy(true)
    setError('')
    void (async () => {
      if (enable && setup) await enableWorktreeSetup(projectId, setup.command)
      setSetup(await worktreeSetup(projectId, task, name))
    })()
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false))
  }
  const running = setup?.status === 'preparing' && !!setup.session
  if (notice) {
    if (!setup || running || setup.status === 'ready' || setup.status === 'skipped') return null
    return (
      <section className="worktree-setup" aria-label="Preparation needs attention">
        Worktree preparation{' '}
        {setup.status === 'preparing' ? 'needs enablement or a run' : setup.status}.
        <button onClick={() => selectPanel('stack')}>Open Stack</button>
      </section>
    )
  }
  return (
    <section className="worktree-setup" aria-label="Task preparation">
      <strong>
        Task preparation:{' '}
        {setup
          ? setup.status[0].toUpperCase() + setup.status.slice(1)
          : 'No preparation captured for this task'}
      </strong>
      {setup && (
        <>
          <pre>{setup.command}</pre>
          {running ? (
            <button disabled={busy} onClick={() => action('stop')}>
              Stop
            </button>
          ) : (
            <button disabled={busy} onClick={() => action('start')}>
              {setup.status === 'ready' ? 'Run setup again' : 'Retry setup'}
            </button>
          )}
          {!running && (
            <button disabled={busy} onClick={() => action('start', true)}>
              Enable exact command locally and run
            </button>
          )}
          {setup.status !== 'ready' && setup.status !== 'skipped' && (
            <button disabled={busy} onClick={() => action('skip')}>
              Continue without setup
            </button>
          )}
          {setup.session && (
            <div style={{ height: 240 }}>
              <TerminalPane
                componentId={TASK_ROOT_SCOPE}
                terminal={{
                  id: 'worktree-setup',
                  name: 'Worktree setup',
                  command: setup.command,
                  kind: 'task',
                }}
                task={task}
                existingSessionId={setup.session}
                focus={false}
              />
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
