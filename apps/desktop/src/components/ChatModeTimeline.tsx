import WorkFeedback from './WorkFeedback'
import { useEffect } from 'react'
import { useStore } from '../store'
import { useChatFollow } from '../lib/useChatFollow'
import { chatReplyId } from '../lib/chatNavigation'
import { sections, type thread, type TimelineItem, type SimpleState } from '../lib/simple'
import type { SimpleFlow } from '../lib/simpleFlow'
import type { useSimpleData } from '../lib/useSimpleData'
import type { SimpleDiff, SimpleUi } from '../lib/simpleUi'
import type { SessionRecord } from '../types'
import { reviewState, useRunningReviewLanes } from '../lib/reviewAgents'
import Markdown from './findings/Markdown'
import FindingsPanel, { VerdictBadge, SeverityCounts } from './findings/FindingsPanel'
import SimpleAgent from './SimpleAgent'
import ChatQuestion from './ChatQuestion'
import type { chatInputRequests } from '../lib/chat'

type Reader = ReturnType<typeof useSimpleData>
interface TimelineProps {
  scopeKey: string
  model: ReturnType<typeof thread>
  items: TimelineItem[]
  state: SimpleFlow
  questions: ReturnType<typeof chatInputRequests>
  /** The sessions whose input requests Chat shows: the conversation's agents and running workers. */
  askers: SessionRecord[]
  simple: SimpleState | null | undefined
  revealed: ReturnType<typeof useStore.getState>['revealed']
  terminal: SimpleUi['terminal']
  data: Reader['data']
  mergeStatus?: string
  retryMergeStatus?: () => void
  source: Reader['source']
  findings: Reader['findings']
  failure?: Error
  openFile: (path: string, line?: number) => void
  openDiff: (file: SimpleDiff) => void
}
export default function ChatModeTimeline({
  scopeKey: key,
  model,
  items,
  state,
  questions,
  askers,
  simple,
  revealed,
  terminal,
  data,
  mergeStatus,
  retryMergeStatus,
  source,
  findings,
  failure,
  openFile,
  openDiff,
}: TimelineProps) {
  const inputKey = JSON.stringify(questions)
  const runningReview = useRunningReviewLanes(source?.branch)
  const grouped = sections(items, model.records)
  const latestMergeResult = items.findLast(
    (item) => item.kind === 'result' && item.result === 'merge',
  )
  // What can grow the thread, without serializing its records or reply texts on every render.
  const replies = model.items.flatMap((item) =>
    item.kind === 'agent'
      ? item.entries.flatMap((entry) =>
          entry.kind === 'reply'
            ? [
                {
                  id: chatReplyId(entry),
                  atMs: entry.atMs,
                },
              ]
            : [],
        )
      : [],
  )
  const contentKey = JSON.stringify([
    model.items.map((i) =>
      i.kind === 'agent'
        ? `${i.id}:${i.entries.length}`
        : i.kind === 'plan'
          ? `${i.id}:${i.text.length}:${i.stale}`
          : `${i.id}:${i.atMs}`,
    ),
    state.step,
    state.prompt,
    inputKey,
    data?.outcome,
    mergeStatus,
  ])
  const { threadRef, following, unread, jump, onScroll } = useChatFollow(
    key,
    JSON.stringify([simple?.startedMs, simple?.clearBoundary?.atMs, simple?.coordinationHandoff]),
    replies,
    contentKey + terminal,
  )
  useEffect(() => {
    if (!revealed) return
    const blocks = threadRef.current?.querySelectorAll<HTMLElement>('[data-session]')
    const block = [...(blocks ?? [])].filter((el) => el.dataset.session === revealed?.sid).at(-1)
    if (block) {
      const section = block.closest<HTMLDetailsElement>('details.simple-section')
      if (section) section.open = true
      block.scrollIntoView({ block: 'nearest' })
      useStore.getState().setRevealed(null)
    }
  }, [revealed, key, contentKey, threadRef])
  return (
    <>
      <div className="simple-thread" ref={threadRef} onScroll={onScroll}>
        {!items.length && (
          <p className="simple-narration">
            Describe what you want to build or change. Your chat agent starts with your first
            message.
          </p>
        )}
        {grouped.map((section, sectionIndex) => {
          const content = section.items.map((item) => {
            if (item.kind === 'agent') {
              const latest = !items
                .slice(items.indexOf(item) + 1)
                .some((i) => i.kind === 'agent' && i.sessionId === item.sessionId)
              return (
                <SimpleAgent
                  key={item.id}
                  record={item.record}
                  sessionId={item.sessionId}
                  entries={item.entries}
                  latest={latest}
                  working={state.busyAgent?.id === item.sessionId}
                  openFile={(file) => openDiff(file)}
                />
              )
            }
            if (item.kind === 'line')
              return (
                <p className="simple-narration" key={item.id}>
                  {item.text}
                </p>
              )
            if (item.kind === 'plan')
              return item.stale ? (
                <details className="simple-earlier-plan" key={item.id}>
                  <summary>
                    An earlier worktree plan exists
                    {item.atMs ? ` (saved ${new Date(item.atMs).toLocaleString()})` : ''} · Show
                  </summary>
                  <Markdown text={item.text} />
                </details>
              ) : (
                <article className="simple-result" key={item.id}>
                  <h3>Plan</h3>
                  <time dateTime={new Date(item.atMs).toISOString()}>
                    {new Date(item.atMs).toLocaleString()}
                  </time>
                  <Markdown text={item.text} />
                </article>
              )
            if (item.result === 'review')
              return (
                findings?.findings && (
                  <article className="simple-result" key={item.id}>
                    <h3>
                      Review <VerdictBadge findings={findings.findings} running={runningReview} />
                      <SeverityCounts findings={findings.findings} />
                    </h3>
                    <FindingsPanel
                      loaded={findings}
                      branch={source?.branch}
                      status={reviewState(findings.findings, source)}
                      onOpenFile={(ref) => openFile(ref.path, ref.line)}
                      canOpen={() => true}
                    />
                  </article>
                )
              )
            if (item !== latestMergeResult) return null
            if (state.step === 'merged')
              return state.prompt ? (
                <p className="simple-narration" key={item.id}>
                  {state.prompt.text}
                </p>
              ) : null
            return (
              <p className="simple-narration" key={item.id}>
                {mergeStatus ??
                  data?.outcomeError ??
                  (data?.outcome === 'inProgress'
                    ? 'Merge in progress…'
                    : 'Waiting for the merge outcome…')}
                {retryMergeStatus && (
                  <>
                    {' '}
                    <button onClick={retryMergeStatus}>Retry status</button>
                  </>
                )}
              </p>
            )
          })
          return sectionIndex === grouped.length - 1 ? (
            <div key={section.id}>{content}</div>
          ) : (
            <details className="simple-section" key={section.id}>
              <summary>
                {[
                  section.title,
                  section.summary,
                  new Date(section.atMs).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </summary>
              {content}
            </details>
          )
        })}
        {questions.map((request) => {
          const record = askers.find((r) => r.id === request.sessionId)
          if (!record) return null
          return (
            <ChatQuestion
              key={`${request.sessionId}:${request.generation}:${request.sinceMs}`}
              record={record}
              request={request}
            />
          )
        })}
        {failure && <WorkFeedback error={failure} />}
      </div>
      {!following && (
        <div className="simple-jump">
          <button onClick={jump}>
            Jump to latest
            {unread > 0 ? ` (${unread} new ${unread === 1 ? 'reply' : 'replies'})` : ''}
          </button>
        </div>
      )}
    </>
  )
}
