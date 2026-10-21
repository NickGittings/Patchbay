import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { PLAN_SCOPE, REVIEW_SCOPE, isReservedScope, type SessionRecord } from '../types'
import { thread, type SimpleStage } from '../lib/simple'
import { logSimple } from '../lib/simpleActions'
import type { useSimpleData } from '../lib/useSimpleData'
import Markdown from './findings/Markdown'
import { changeGroups } from '../lib/changeGroups'
import { simpleKey, useSimpleUi } from '../lib/simpleUi'
import { revealTerminal } from '../lib/attention'
import { openComponentWindow } from '../lib/windows'
import { implementPlannerPlan } from '../lib/planHandoff'
import { fixReviewFindings } from '../lib/reviewHandoff'
import { roleDevice } from '../lib/agentRoles'
import { reviewState, reviewWorktreeBusy, useRunningReviewLanes } from '../lib/reviewAgents'
import { graphActionIn } from '../lib/actions'
import FindingsPanel, { VerdictBadge, SeverityCounts } from './findings/FindingsPanel'
import ValidationChips from './changes/ValidationChips'
import { latestChangeOf } from '../lib/review'
import ReviewAgentDialog from './ReviewAgentDialog'
import MergeAgentDialog from './MergeAgentDialog'
import SimpleComposer from './SimpleComposer'
import SimpleAgent from './SimpleAgent'
import './simple.css'

const pendingActions = new Set<string>()
export default function SimpleChat({ reader }: { reader: ReturnType<typeof useSimpleData> }) {
  const s = useStore()
  const { data, source, error, findings } = reader
  const key = simpleKey(s.project?.id, s.activeTask)
  const [pending, setPending] = useState(''),
    [failure, setFailure] = useState<{ action: string; text: string }>()
  const [dialog, setDialog] = useState<'review' | 'merge'>()
  const runningReview = useRunningReviewLanes(source?.branch)
  useEffect(() => {
    const current = useStore.getState()
    if (current.project && !current.simple)
      current.patchTask(current.project.id, current.activeTask, {
        simple: { startedMs: Date.now(), log: [] },
      })
  }, [s.project, s.activeTask, s.simple])
  if (!s.project) return null
  const projectId = s.project.id,
    task = s.activeTask
  const worktree = {
    projectId,
    task,
    path: source?.path ?? s.tasks.find((t) => t.id === task)?.worktree ?? s.project.root,
    branch: source?.branch,
  }
  const model = thread(
    { records: s.sessionRecords, sessions: s.sessions, simple: s.simple, auto: s.auto, ...data },
    worktree,
  )
  const groups = changeGroups(s.nodes, data?.review)
  const reviewer = model.records.filter((r) => r.metadata.componentId === REVIEW_SCOPE).at(-1)
  const busy = reviewWorktreeBusy(model.records, s.sessions, worktree.path)
  const status = reviewState(findings?.findings, source)
  const planner =
    model.records.filter((r) => r.metadata.componentId === PLAN_SCOPE).at(-1)?.metadata
      .terminalId ?? roleDevice(s.devices, s.agentRoles, 'plan').id
  const run = async (
    action: 'implement' | 'fix' | 'validate',
    stage: SimpleStage,
    fn: () => Promise<string | void>,
  ) => {
    const actionKey = `${key}:${action}`
    if (pendingActions.has(actionKey)) return
    pendingActions.add(actionKey)
    setPending(action)
    setFailure(undefined)
    try {
      const sid = await fn()
      logSimple(projectId, task, {
        kind: 'action',
        action,
        stage,
        sessionId: sid ?? undefined,
        generation: sid ? useStore.getState().sessions[sid]?.generation : undefined,
      })
    } catch (e) {
      setFailure({ action, text: String(e) })
    } finally {
      pendingActions.delete(actionKey)
      setPending('')
    }
  }
  const openTerminal = (record: SessionRecord) => {
    if (!isReservedScope(record.metadata.componentId)) {
      s.setActiveSession(record.id)
      void openComponentWindow(
        record.metadata.componentId,
        s.nodes.find((n) => n.id === record.metadata.componentId)?.data.name ??
          record.metadata.name,
        projectId,
      ).catch((e) => setFailure({ action: 'terminal', text: String(e) }))
    } else revealTerminal({ sid: record.id, componentId: record.metadata.componentId })
  }
  const openFile = (path: string, line?: number) => {
    const files = groups.flatMap((g) => g.files.map((f) => ({ componentId: g.id, path: f.path })))
    const exact = files.find((f) => f.path === path)
    const suffix = files.filter((f) => f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`))
    const match = exact ?? (suffix.length === 1 ? suffix[0] : undefined)
    useSimpleUi.getState().patch(key, {
      diff: { componentId: match?.componentId ?? '@project', path: match?.path ?? path, line },
    })
  }
  const errorFor = (action: string) =>
    failure?.action === action && <p role="alert">{failure.text}</p>
  return (
    <div className="simple-chat">
      <header>
        <strong>Worktree chat</strong>
        <span>{source?.branch ?? 'Project folder'}</span>
      </header>
      {error && <p role="alert">{error}</p>}
      {source && dialog === 'review' && (
        <ReviewAgentDialog
          source={source}
          worktrees={data?.worktrees ?? []}
          close={() => setDialog(undefined)}
          launched={(sid) => {
            logSimple(projectId, task, {
              kind: 'action',
              action: 'review',
              stage: 'review',
              sessionId: sid,
              generation: useStore.getState().sessions[sid]?.generation,
            })
            setDialog(undefined)
          }}
        />
      )}
      {source && dialog === 'merge' && (
        <MergeAgentDialog
          source={source}
          worktrees={data?.worktrees ?? []}
          findings={findings}
          close={() => setDialog(undefined)}
          onRequest={(request, sid) =>
            logSimple(projectId, task, {
              kind: 'action',
              action: 'merge',
              stage: 'merge',
              request,
              sessionId: sid,
              generation: useStore.getState().sessions[sid]?.generation,
            })
          }
          launched={() => setDialog(undefined)}
        />
      )}
      <div className="simple-thread">
        {model.sections.map((section) => (
          <section
            className="simple-stage"
            key={section.id}
            aria-current={model.stage === section.id ? 'step' : undefined}
          >
            <h2>{section.id[0].toUpperCase() + section.id.slice(1)}</h2>
            {section.id === 'plan' && (
              <article>
                <h3>Project plan · shared across worktree chats</h3>
                <Markdown text={data?.plan.text || 'No saved plan yet.'} />
                {data?.proposal && <Markdown text={data.proposal.plan} />}
                <button
                  disabled={!model.planReady || !!pending}
                  onClick={() =>
                    void run('implement', 'build', () =>
                      implementPlannerPlan(planner, undefined, undefined, 'stay'),
                    )
                  }
                >
                  Implement
                </button>
                {errorFor('implement')}
              </article>
            )}
            {section.id === 'build' && (
              <>
                <article>
                  <h3>Accepted worktree plan</h3>
                  <Markdown
                    text={
                      task
                        ? data?.acceptedPlan.text || 'No accepted plan yet.'
                        : data?.acceptedPlan.text || 'No saved plan yet.'
                    }
                  />
                </article>
                <article>
                  <h3>Changes</h3>
                  {groups.length ? (
                    groups.map((g) => (
                      <div key={g.id}>
                        <strong>{g.name}</strong>
                        {g.files.map((f) => (
                          <button
                            className="simple-file"
                            key={f.path}
                            onClick={() => openFile(f.path)}
                          >
                            {f.path}
                          </button>
                        ))}
                      </div>
                    ))
                  ) : (
                    <p>No uncommitted changes.</p>
                  )}
                  <button
                    disabled={!source?.branch || busy || !!pending}
                    onClick={() => setDialog('review')}
                  >
                    Review…
                  </button>
                </article>
                {!!data?.review.affected.length && (
                  <article>
                    <h3>May affect</h3>
                    {data.review.affected.map((a) => (
                      <div key={a.id}>
                        <button onClick={() => s.select(a.id)}>
                          {s.nodes.find((n) => n.id === a.id)?.data.name ?? a.id}
                        </button>
                        <ValidationChips
                          componentId={a.id}
                          changedAt={latestChangeOf(data.review.changes, a.via)}
                          task={task}
                        />
                      </div>
                    ))}
                    <button
                      disabled={s.graphActionBusy || !!pending}
                      onClick={() =>
                        void run('validate', 'build', async () => {
                          await graphActionIn(projectId, task, s.toProject(), {
                            kind: 'validateChanged',
                            componentIds: groups
                              .filter((g) => g.id !== '@project')
                              .map((g) => g.id),
                          })
                        })
                      }
                    >
                      Run validation
                    </button>
                    {errorFor('validate')}
                  </article>
                )}
              </>
            )}
            {section.id === 'review' && (
              <article>
                <h3>
                  Findings{' '}
                  {findings?.findings && (
                    <>
                      <VerdictBadge findings={findings.findings} running={runningReview} />
                      <SeverityCounts findings={findings.findings} />
                    </>
                  )}
                </h3>
                <FindingsPanel
                  loaded={findings}
                  branch={source?.branch}
                  status={status}
                  onOpenFile={(ref) => openFile(ref.path, ref.line)}
                  canOpen={() => true}
                />
                {!!findings?.findings?.text.trim() && reviewer && (
                  <button
                    disabled={busy || !!pending}
                    onClick={() =>
                      void run('fix', 'build', () =>
                        fixReviewFindings(reviewer, undefined, undefined, 'stay'),
                      )
                    }
                  >
                    Fix findings
                  </button>
                )}
                {errorFor('fix')}
                <button
                  disabled={
                    busy ||
                    !!pending ||
                    status !== 'current' ||
                    !findings?.findings?.verdict?.clean ||
                    !source?.branch
                  }
                  onClick={() => setDialog('merge')}
                >
                  Merge…
                </button>
              </article>
            )}
            {section.id === 'merge' && (
              <article>{data?.outcome ?? 'Choose a merge destination after review.'}</article>
            )}
            {section.entries.map((entry) => (
              <article className="simple-entry" key={entry.id}>
                <time>{new Date(entry.atMs).toLocaleTimeString()}</time>
                {entry.kind === 'prompt' ? (
                  <>
                    <strong>You</strong>
                    <pre>{entry.text}</pre>
                    {entry.mentions.map((id) => (
                      <span className="simple-scope-chip" key={id}>
                        {s.nodes.find((n) => n.id === id)?.data.name ?? id}
                      </span>
                    ))}
                  </>
                ) : (
                  entry.action
                )}
              </article>
            ))}
            {section.sessions.map((r) => (
              <SimpleAgent key={r.id} record={r} scopeKey={key} openTerminal={openTerminal} />
            ))}
          </section>
        ))}
      </div>
      {errorFor('terminal')}
      <SimpleComposer
        scopeKey={key}
        stage={model.stage}
        records={model.records}
        openTerminal={openTerminal}
      />
    </div>
  )
}
