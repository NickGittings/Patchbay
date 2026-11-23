import { useContext, useMemo, useState } from 'react'
import { simpleKey, useSimpleUi } from '../../lib/simpleUi'
import { SimpleChangesContext, SimpleWorktreeContext } from './simpleChanges'
import { useChatAgents } from '../../lib/useChatAgents'
import { teamFlags } from '../../lib/useTeamWork'
import type { ChangeRef } from '../../lib/changeNav'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../store'
import type { AutoRun, Story, StoryDraft, StoryKind } from '../../types'
import { STAGE_LABELS, STATUS_LABELS, unfinished } from '../../lib/autoSettings'
import {
  filterStories,
  moveStory,
  PARENT_FILTERS,
  progressLabel,
  reorder,
  siblings,
  sourceName,
  STORY_FILTERS,
  storyStatuses,
  tree,
  type StoryFilter,
} from '../../lib/stories'
import { shortTitle } from '../../lib/shortTitle'
import StoryEditor from './StoryEditor'
import ExtensionMenu from '../../extensions/ExtensionMenu'
import './stories.css'

/** Chat's Agents tab; a component of its own so Full view never follows sessions for it. */
function AgentsTab({ scopeKey, active }: { scopeKey: string; active: boolean }) {
  const { cards, team, work } = useChatAgents(useContext(SimpleWorktreeContext))
  const count = cards.filter((card) => card.row !== 'finished').length
  const { flagged, details } = teamFlags(work, team)
  return (
    <button
      className={active ? 'active' : ''}
      aria-pressed={active}
      aria-label={[`Agents, ${count}`, ...details].join(', ')}
      onClick={() => useSimpleUi.getState().patch(scopeKey, { agents: true, changes: false })}
    >
      Agents {count}
      {flagged > 0 && <span className="chat-workers-flag"> · {flagged} flagged</span>}
    </button>
  )
}

export function StoryViewTabs() {
  const shown = useStore((s) => s.storyBoard)
  const setShown = useStore((s) => s.setStoryBoard)
  const simple = useStore((s) => s.simpleMode)
  const key = useStore((s) => simpleKey(s.project?.id, s.activeTask))
  const ui = useSimpleUi((s) => s.worktrees[key])
  const changes = simple && !!ui?.changes
  const agents = simple && !!ui?.agents && !changes
  const covered = changes || agents
  const { files, newest } = useContext(SimpleChangesContext)
  const listed = (diff: ChangeRef | null | undefined) =>
    !!diff && files.some((f) => f.componentId === diff.componentId && f.path === diff.path)
  const show = (stories: boolean) => {
    useSimpleUi.getState().patch(key, { changes: false, agents: false })
    setShown(stories)
  }
  return (
    <div className="view-tabs" role="group" aria-label="Navigation canvas">
      <button
        className={!shown && !covered ? 'active' : ''}
        aria-pressed={!shown && !covered}
        onClick={() => show(false)}
      >
        Map
      </button>
      <button
        className={shown && !covered ? 'active' : ''}
        aria-pressed={shown && !covered}
        onClick={() => show(true)}
      >
        Stories
      </button>
      {simple && (
        <button
          className={changes ? 'active' : ''}
          aria-pressed={changes}
          onClick={() =>
            useSimpleUi.getState().patch(key, {
              changes: true,
              agents: false,
              // A selection the list no longer shows gives way to the newest listed write.
              diff: (listed(ui?.diff) ? ui?.diff : undefined) ?? newest ?? files[0] ?? null,
            })
          }
        >
          Changes {files.length}
        </button>
      )}
      {simple && <AgentsTab scopeKey={key} active={agents} />}
    </div>
  )
}

export default function StoryBoard() {
  const registry = useStore((s) => s.extensions)
  const { project, stories, tasks, taskWorkspaces, activeTask, auto, sessionRecords } = useStore(
    useShallow((s) => ({
      project: s.project,
      stories: s.stories,
      tasks: s.tasks,
      taskWorkspaces: s.taskWorkspaces,
      activeTask: s.activeTask,
      auto: s.auto,
      sessionRecords: s.sessionRecords,
    })),
  )
  const [epic, setEpic] = useState<string | null>(null)
  const [feature, setFeature] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<StoryDraft | null>(null)
  const [filters, setFilters] = useState<Record<StoryKind, StoryFilter>>({
    epic: 'all',
    feature: 'all',
    story: 'all',
  })
  // The card being dragged, and where it would land: before or after another card.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null)
  const projectId = project?.id
  /** Where a drop beside `target` puts the dragged card, or undefined if it can't land there. */
  const landing = (target: Story, after: boolean) => {
    if (!dragging) return
    const group = siblings(stories, target)
    if (!group.some((s) => s.id === dragging)) return
    const before = after
      ? (group[group.findIndex((s) => s.id === target.id) + 1]?.id ?? null)
      : target.id
    return reorder(stories, dragging, before) ? before : undefined
  }
  const move = (id: string, before: string | null) => {
    if (projectId) void moveStory(projectId, id, before)
  }
  const runs = useMemo(() => {
    const runs: Record<string, AutoRun | null> = Object.fromEntries(
      Object.entries(taskWorkspaces).map(([id, w]) => [id, w.auto]),
    )
    if (activeTask) runs[activeTask] = auto
    return runs
  }, [taskWorkspaces, activeTask, auto])
  const statuses = useMemo(
    () => storyStatuses(stories, tasks, runs, projectId ?? '', sessionRecords),
    [stories, tasks, runs, projectId, sessionRecords],
  )
  const hierarchy = tree(stories)
  const selectedEpic = hierarchy.epics.some((e) => e.item.id === epic) ? epic : null
  const selectedFeature =
    feature === 'unassigned' ||
    hierarchy.epics.some((e) => e.features.some((f) => f.item.id === feature))
      ? feature
      : null
  const visibleFeatures = hierarchy.epics
    .filter((e) => !selectedEpic || e.item.id === selectedEpic)
    .flatMap((e) => e.features)
  const visibleStories =
    selectedFeature === 'unassigned'
      ? hierarchy.unassigned
      : visibleFeatures
          .filter((f) => !selectedFeature || f.item.id === selectedFeature)
          .flatMap((f) => f.stories)
          .concat(!selectedFeature && !selectedEpic ? hierarchy.unassigned : [])
  const add = (kind: StoryKind) => {
    setSelected(null)
    setDraft({
      kind,
      title: '',
      parent:
        kind === 'feature'
          ? (selectedEpic ?? hierarchy.epics[0]?.item.id)
          : kind === 'story' && selectedFeature !== 'unassigned'
            ? selectedFeature
            : null,
    })
  }
  const choose = (item: Story) => {
    setDraft(null)
    setSelected(item.id)
    if (item.kind === 'epic') {
      setEpic(item.id)
      setFeature(null)
    }
    if (item.kind === 'feature') setFeature(item.id)
  }
  const item = stories.find((s) => s.id === selected)
  const column = (kind: StoryKind, title: string, candidates: Story[], all: () => void) => {
    const items = filterStories(candidates, statuses, filters[kind])
    // Hidden cards would make a filtered column's order ambiguous.
    const sortable = filters[kind] === 'all'
    return (
      <section className="story-column" aria-label={title}>
        <header>
          <div className="story-column-heading">
            <h3>
              {title} <span>{items.length}</span>
            </h3>
            <select
              className="story-filter"
              aria-label={`Filter ${title.toLowerCase()} by status`}
              value={filters[kind]}
              onChange={(e) =>
                setFilters((current) => ({ ...current, [kind]: e.target.value as StoryFilter }))
              }
            >
              {(kind === 'story' ? STORY_FILTERS : PARENT_FILTERS).map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => add(kind)}
            disabled={kind === 'feature' && !hierarchy.epics.length}
            aria-label={`Add ${kind}`}
          >
            + Add
          </button>
        </header>
        <button className="story-all" onClick={all}>
          All {title.toLowerCase()}
        </button>
        <div className="story-cards">
          {items.map((item) => {
            const worktree = tasks.find((t) => t.id === item.task)
            const value = statuses.get(item.id)!.value
            // The worktree's Auto run: this item's own, or whatever still runs there.
            const run = worktree && runs[worktree.id]
            const stage = run && (run.runId === item.autoRunId || unfinished(run.status)) && run
            return (
              <button
                key={item.id}
                className={[
                  'story-card',
                  selected === item.id && 'selected',
                  dragging === item.id && 'dragging',
                  dropAt?.id === item.id && (dropAt.after ? 'drop-after' : 'drop-before'),
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={selected === item.id}
                aria-keyshortcuts={sortable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                title={sortable ? 'Drag, or Alt+↑/↓, to change priority' : undefined}
                draggable={sortable}
                onClick={() => choose(item)}
                onKeyDown={(e) => {
                  if (!sortable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown'))
                    return
                  e.preventDefault()
                  const group = siblings(stories, item)
                  const at = group.findIndex((s) => s.id === item.id)
                  // Up lands before the previous sibling; down before the one after next.
                  const before =
                    e.key === 'ArrowUp' ? group[at - 1]?.id : (group[at + 2]?.id ?? null)
                  if (before !== undefined && at >= 0) move(item.id, before)
                }}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', item.title)
                  setDragging(item.id)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDropAt(null)
                }}
                onDragOver={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > box.top + box.height / 2
                  if (landing(item, after) === undefined) {
                    if (dropAt?.id === item.id) setDropAt(null)
                    return
                  }
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (dropAt?.id !== item.id || dropAt.after !== after)
                    setDropAt({ id: item.id, after })
                }}
                onDragLeave={(e) => {
                  // Moving onto the card's own title or chips isn't leaving it.
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                  if (dropAt?.id === item.id) setDropAt(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  // From the event, not the last render's marker, which may not have caught up.
                  const box = e.currentTarget.getBoundingClientRect()
                  const before = landing(item, e.clientY > box.top + box.height / 2)
                  if (dragging && before !== undefined) move(dragging, before)
                  setDragging(null)
                  setDropAt(null)
                }}
              >
                <span className="story-card-title">
                  <i className={`story-dot ${kind}`} />
                  {item.title}
                </span>
                <span className="story-card-meta">
                  <span className={`chip story-status ${value}`}>{progressLabel(value)}</span>
                  <span>{item.components.length} components</span>
                  {item.source && (
                    <span
                      className="chip story-imported"
                      title={`Imported from ${sourceName(item.source, registry)}`}
                    >
                      {/* Tracker ids end in the distinctive part, such as owner/repo#12. */}
                      {item.source.externalId.length > 18
                        ? `…${item.source.externalId.slice(-17)}`
                        : item.source.externalId}
                    </span>
                  )}
                </span>
                {worktree && (
                  <span className="story-worktree" title={worktree.worktree}>
                    {shortTitle(worktree.title)}
                    {worktree.missing ? ' · missing' : ''}
                  </span>
                )}
                {stage && (
                  <span className={`story-stage ${stage.status}`}>
                    {/* The done stage says nothing its status doesn't. */}
                    {stage.stage === 'done'
                      ? STATUS_LABELS[stage.status]
                      : `${STAGE_LABELS[stage.stage]} · ${STATUS_LABELS[stage.status]}`}
                  </span>
                )}
              </button>
            )
          })}
          {!items.length && (
            <p className="story-hint">
              {filters[kind] === 'all'
                ? `No ${title.toLowerCase()} here yet.`
                : 'No matches for this status'}
            </p>
          )}
        </div>
        {kind === 'feature' && (
          <button
            className={feature === 'unassigned' ? 'story-all active' : 'story-all'}
            onClick={() => {
              setEpic(null)
              setFeature('unassigned')
            }}
          >
            Unassigned stories ·{' '}
            {filterStories(hierarchy.unassigned, statuses, filters.story).length}
          </button>
        )}
      </section>
    )
  }
  return (
    <div className="story-board" aria-label="Story board">
      <header className="story-board-header view-tabs-header">
        <StoryViewTabs />
        <div className="story-board-actions" role="group" aria-label="Story board actions">
          <ExtensionMenu slot="stories/toolbar" />
        </div>
      </header>
      <div className="story-board-body">
        <div className="story-board-content">
          <div className="story-columns">
            {column(
              'epic',
              'Epics',
              hierarchy.epics.map((e) => e.item),
              () => {
                setEpic(null)
                setFeature(null)
              },
            )}
            {column(
              'feature',
              'Features',
              visibleFeatures.map((f) => f.item),
              () => {
                setEpic(null)
                setFeature(null)
              },
            )}
            {column('story', 'Stories', visibleStories, () => {
              setEpic(null)
              setFeature(null)
            })}
          </div>
        </div>
        {projectId && (item || draft) && (
          <StoryEditor
            key={`${projectId}/${item?.id ?? `new-${draft?.kind}-${draft?.parent}`}`}
            projectId={projectId}
            item={item}
            progress={item ? statuses.get(item.id) : undefined}
            draft={draft ?? undefined}
            onClose={() => {
              setSelected(null)
              setDraft(null)
            }}
            onSaved={(saved) => {
              setDraft(null)
              setSelected(saved.id)
            }}
          />
        )}
      </div>
    </div>
  )
}
