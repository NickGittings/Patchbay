import { useState } from 'react'
import { projectStateOf, useStore } from '../../store'
import { autoWorkspace } from '../../lib/autoState'
import type { Story, StoryDraft, StoryStatus, StoryPatch } from '../../types'
import {
  autoStory,
  planStory,
  newWorktreeForStory,
  progressLabel,
  refreshStories,
  reopenStoryPatch,
  sourceName,
  STORY_STATUSES,
  updateStory,
  type ResolvedStoryStatus,
} from '../../lib/stories'
import { storyCreate, storyRemove, storySourceOpen } from '../../lib/ipc'
import ExtensionMenu from '../../extensions/ExtensionMenu'
import { shortTitle } from '../../lib/shortTitle'

export default function StoryEditor({
  projectId,
  item,
  progress,
  draft,
  onClose,
  onSaved,
}: {
  projectId: string
  item?: Story
  progress?: ResolvedStoryStatus
  draft?: StoryDraft
  onClose: () => void
  onSaved: (item: Story) => void
}) {
  const stories = useStore((s) => s.stories)
  const nodes = useStore((s) => s.nodes)
  const extensions = useStore((s) => s.extensions)
  const seed = item ?? draft!
  const kind = seed.kind
  const [title, setTitle] = useState(seed.title)
  const [description, setDescription] = useState(seed.description ?? '')
  const [parent, setParent] = useState(seed.parent ?? '')
  const [acceptance, setAcceptance] = useState(seed.acceptance ?? [])
  const [components, setComponents] = useState(seed.components ?? [])
  // An untouched status follows Plan/Auto and completion updates while the editor stays open.
  const [statusEdit, setStatusEdit] = useState<StoryStatus | null>(null)
  const [parentEdit, setParentEdit] = useState<'active' | 'closed' | null>(null)
  const status = statusEdit ?? item?.status ?? 'backlog'
  const parentState = parentEdit ?? (item?.status === 'done' ? 'closed' : 'active')
  const automatic =
    kind === 'story' && !!progress && (progress.source !== 'saved' || progress.value === 'done')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [cascade, setCascade] = useState(true)
  const parents = stories.filter((s) => s.kind === (kind === 'feature' ? 'epic' : 'feature'))
  const validParent = parents.some((s) => s.id === parent) ? parent : ''
  const ready = !!title.trim() && (kind !== 'feature' || !!validParent)
  const reopen = (item: Story) =>
    reopenStoryPatch(item, autoWorkspace(projectStateOf(projectId), item.task)?.auto)
  const save = async (statusPatch: StoryPatch = {}) => {
    const change: StoryPatch =
      kind === 'story'
        ? automatic || statusEdit === null
          ? {}
          : { status: statusEdit }
        : parentEdit === 'closed'
          ? { status: 'done' }
          : parentEdit === 'active' && item?.status === 'done'
            ? reopen(item)
            : {}
    const patch = { ...change, ...statusPatch }
    const fields = {
      title,
      description,
      parent: validParent,
      acceptance: acceptance.map((a) => a.trim()).filter(Boolean),
      components,
    }
    let saved = item
      ? await updateStory(projectId, item.id, {
          ...fields,
          ...patch,
        })
      : await storyCreate(projectId, { ...fields, kind, parent: validParent || null })
    if (!item) {
      if (patch.status && patch.status !== 'backlog')
        saved = await updateStory(projectId, saved.id, patch)
      await refreshStories(projectId)
    }
    if (!automatic || statusPatch.status !== undefined || statusPatch.reopen) setStatusEdit(null)
    setParentEdit(null)
    onSaved(saved)
    return saved
  }
  const act = async (action?: 'plan' | 'auto' | 'delete' | 'worktree' | 'done' | 'reopen') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (action === 'delete' && item) {
        await storyRemove(projectId, item.id, cascade)
        await refreshStories(projectId)
        onClose()
        return
      }
      const saved = await save(
        action === 'done'
          ? { status: 'done' }
          : action === 'reopen' && item
            ? reopen(item)
            : undefined,
      )
      if (action === 'plan') await planStory(projectId, saved)
      if (action === 'auto') autoStory(projectId, saved)
      if (action === 'worktree') newWorktreeForStory(projectId, saved)
    } catch (e) {
      setError(String(e))
      if (action === 'plan')
        useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <aside className="story-editor" aria-label="Story editor">
      <header>
        <h3>
          {item ? 'Edit' : 'New'} {kind}
        </h3>
        <button disabled={busy} onClick={onClose} aria-label="Close story editor" title="Close">
          ×
        </button>
      </header>
      {item?.source && (
        <div className="story-source" role="group" aria-label="Tracker source">
          <p className="story-hint">
            Imported from {sourceName(item.source, extensions)}. Importing again replaces the title,
            description, criteria and parent; status, components and worktree links stay here.
          </p>
          <div className="row">
            {item.source.url && (
              <button
                type="button"
                onClick={() =>
                  void storySourceOpen(projectId, item.id).catch((e) => setError(String(e)))
                }
              >
                Open in tracker ↗
              </button>
            )}
            <ExtensionMenu slot="stories/item" story={item} args={[item]} />
          </div>
        </div>
      )}
      {item && !item.source && (
        <div className="story-source-actions row">
          <ExtensionMenu slot="stories/item" story={item} args={[item]} />
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void act()
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Title
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What should we build?"
            />
          </label>
          <label>
            Description
            <textarea
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Who is it for, and what should it do?"
            />
          </label>
          {kind !== 'epic' && (
            <label>
              {kind === 'feature' ? 'Epic' : 'Feature'}
              <select value={validParent} onChange={(e) => setParent(e.target.value)}>
                <option value="">{kind === 'feature' ? 'Choose an epic' : 'Unassigned'}</option>
                {parents.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="story-acceptance">
            <span>Acceptance criteria</span>
            {acceptance.map((criterion, index) => (
              <div className="row" key={index}>
                <input
                  aria-label={`Acceptance criterion ${index + 1}`}
                  value={criterion}
                  onChange={(e) =>
                    setAcceptance(acceptance.map((a, i) => (i === index ? e.target.value : a)))
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove criterion ${index + 1}`}
                  onClick={() => setAcceptance(acceptance.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setAcceptance([...acceptance, ''])}>
              + Add criterion
            </button>
          </div>
          <div>
            <span>Components</span>
            <div className="scope-chips">
              {nodes.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  aria-pressed={components.includes(n.id)}
                  className={components.includes(n.id) ? 'active' : ''}
                  onClick={() =>
                    setComponents(
                      components.includes(n.id)
                        ? components.filter((id) => id !== n.id)
                        : [...components, n.id],
                    )
                  }
                >
                  {n.data.name}
                </button>
              ))}
            </div>
          </div>
          {kind !== 'story' ? (
            <label>
              Status
              <select
                value={parentState}
                onChange={(e) => setParentEdit(e.target.value === 'closed' ? 'closed' : 'active')}
              >
                <option value="active">Active</option>
                <option value="closed">Closed</option>
              </select>
            </label>
          ) : automatic && progress !== undefined ? (
            <div className="row">
              <span>Status</span>
              <span className={`chip story-status ${progress.value}`}>
                {progressLabel(progress.value)}
              </span>
              {progress.value !== 'done' ? (
                <button type="button" disabled={!ready} onClick={() => void act('done')}>
                  Mark done
                </button>
              ) : (
                <button type="button" disabled={!ready} onClick={() => void act('reopen')}>
                  Reopen
                </button>
              )}
            </div>
          ) : (
            <label>
              Status
              <select value={status} onChange={(e) => setStatusEdit(e.target.value as StoryStatus)}>
                {STORY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {progressLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {automatic && statusEdit !== null && (
            <p className="story-status-draft">
              Unsaved status: {progressLabel(statusEdit)}. You can save it when automatic progress
              ends.{' '}
              <button type="button" onClick={() => setStatusEdit(null)}>
                Discard status choice
              </button>
            </p>
          )}
          {kind !== 'story' ? (
            progress?.source === 'children' && progress.value === 'closed' ? (
              <p className="story-hint">All children are complete, so the board shows Closed.</p>
            ) : (
              progress?.value !== 'closed' && (
                <p className="story-hint">
                  Merging this {kind}’s own worktree or Auto run doesn’t close it. It closes when
                  all its {kind === 'epic' ? 'features' : 'stories'} are done, or when you set
                  Closed.
                </p>
              )
            )
          ) : (
            <p className="story-hint">
              {progress?.source === 'saved' && progress.value === 'done' ? (
                'Completed work stays Done after cleanup.'
              ) : progress?.source === 'worktree' ? (
                <>
                  Following worktree {shortTitle(progress.worktree.title)}. You can mark this item
                  done at any time.
                </>
              ) : progress?.source === 'auto' ? (
                'The linked Auto run completed this story.'
              ) : (
                'Worktree activity updates the card’s status. Completed work stays Done after cleanup.'
              )}
            </p>
          )}
          <div className="story-editor-actions">
            <button type="submit" disabled={!ready}>
              Save
            </button>
            <button type="button" disabled={!ready} onClick={() => void act('plan')}>
              Plan →
            </button>
            <button type="button" disabled={!ready} onClick={() => void act('worktree')}>
              New worktree
            </button>
            <button type="button" disabled={!ready} onClick={() => void act('auto')}>
              Auto…
            </button>
          </div>
          {item && !deleting && (
            <button type="button" className="danger" onClick={() => setDeleting(true)}>
              Delete…
            </button>
          )}
          {deleting && (
            <div className="story-delete" role="group" aria-label="Confirm deletion">
              <p>Delete “{item?.title}”?</p>
              <label>
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={(e) => setCascade(e.target.checked)}
                />{' '}
                Delete its children too
              </label>
              {!cascade && kind === 'epic' && (
                <p className="story-hint">
                  Move features to another epic before deleting this one.
                </p>
              )}
              <div className="row">
                <button type="button" onClick={() => setDeleting(false)}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={() => void act('delete')}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </fieldset>
      </form>
      {error && (
        <p className="story-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  )
}
