import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../store'
import type { AutoRun, Story, StoryDraft, StoryKind, StoryStatus } from '../../types'
import { derivedStatus, rollup, tree } from '../../lib/stories'
import { shortTitle } from '../../lib/tasks'
import EmptyState from '../EmptyState'
import StoryEditor from './StoryEditor'
import './stories.css'

export function StoryViewTabs() {
  const shown = useStore((s) => s.storyBoard)
  const setShown = useStore((s) => s.setStoryBoard)
  return (
    <div className="view-tabs" role="group" aria-label="Navigation canvas">
      <button
        className={!shown ? 'active' : ''}
        aria-pressed={!shown}
        onClick={() => setShown(false)}
      >
        Map
      </button>
      <button className={shown ? 'active' : ''} aria-pressed={shown} onClick={() => setShown(true)}>
        Stories
      </button>
    </div>
  )
}

export default function StoryBoard() {
  const { project, stories, tasks, taskWorkspaces, activeTask, auto } = useStore(
    useShallow((s) => ({
      project: s.project,
      stories: s.stories,
      tasks: s.tasks,
      taskWorkspaces: s.taskWorkspaces,
      activeTask: s.activeTask,
      auto: s.auto,
    })),
  )
  const [epic, setEpic] = useState<string | null>(null)
  const [feature, setFeature] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<StoryDraft | null>(null)
  const projectId = project?.id
  const hierarchy = tree(stories)
  const selectedEpic = hierarchy.epics.some((e) => e.item.id === epic) ? epic : null
  const selectedFeature =
    feature === 'unassigned' || stories.some((s) => s.kind === 'feature' && s.id === feature)
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
  const runs: Record<string, AutoRun | null> = Object.fromEntries(
    Object.entries(taskWorkspaces).map(([id, w]) => [id, w.auto]),
  )
  if (activeTask) runs[activeTask] = auto
  const status = (item: Story): StoryStatus => {
    const own = derivedStatus(item, tasks, runs)
    return item.status === 'done' || item.kind === 'story'
      ? own
      : rollup(own, stories.filter((s) => s.parent === item.id).map(status))
  }
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
  const column = (kind: StoryKind, title: string, items: Story[], all: () => void) => (
    <section className="story-column" aria-label={title}>
      <header>
        <h3>
          {title} <span>{items.length}</span>
        </h3>
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
          const value = status(item)
          return (
            <button
              key={item.id}
              className={`story-card ${selected === item.id ? 'selected' : ''}`}
              aria-pressed={selected === item.id}
              onClick={() => choose(item)}
            >
              <span className="story-card-title">
                <i className={`story-dot ${kind}`} />
                {item.title}
              </span>
              <span className="story-card-meta">
                <span className={`chip story-status ${value}`}>{value}</span>
                <span>{item.components.length} components</span>
              </span>
              {worktree && (
                <span className="story-worktree" title={worktree.worktree}>
                  {shortTitle(worktree.title)}
                  {worktree.missing ? ' · missing' : ''}
                </span>
              )}
            </button>
          )
        })}
        {!items.length && <p className="story-hint">No {title.toLowerCase()} here yet.</p>}
      </div>
      {kind === 'feature' && (
        <button
          className={feature === 'unassigned' ? 'story-all active' : 'story-all'}
          onClick={() => {
            setEpic(null)
            setFeature('unassigned')
          }}
        >
          Unassigned stories · {hierarchy.unassigned.length}
        </button>
      )}
    </section>
  )
  return (
    <div className="story-board" aria-label="Story board">
      <header className="story-board-header">
        <StoryViewTabs />
        <span className="spacer" />
        <span>Shape the work before you plan it</span>
      </header>
      <div className="story-board-body">
        <div className="story-board-content">
          {!stories.length && !draft && (
            <EmptyState
              icon="▤"
              title="What do you want to build?"
              compact
              actions={<button onClick={() => add('epic')}>+ Add epic</button>}
            >
              Group ideas into epics, features, and stories. Add acceptance criteria, then send one
              to Plan or Auto.
            </EmptyState>
          )}
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
