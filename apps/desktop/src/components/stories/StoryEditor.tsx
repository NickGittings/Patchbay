import { useState } from 'react'
import { useStore } from '../../store'
import type { Story, StoryDraft, StoryStatus } from '../../types'
import {
  autoStory,
  planStory,
  refreshStories,
  STORY_STATUSES,
  updateStory,
} from '../../lib/stories'
import { storyCreate, storyRemove } from '../../lib/ipc'

export default function StoryEditor({
  projectId,
  item,
  draft,
  onClose,
  onSaved,
}: {
  projectId: string
  item?: Story
  draft?: StoryDraft
  onClose: () => void
  onSaved: (item: Story) => void
}) {
  const stories = useStore((s) => s.stories)
  const nodes = useStore((s) => s.nodes)
  const seed = item ?? draft!
  const kind = seed.kind
  const [title, setTitle] = useState(seed.title)
  const [description, setDescription] = useState(seed.description ?? '')
  const [parent, setParent] = useState(seed.parent ?? '')
  const [acceptance, setAcceptance] = useState(seed.acceptance ?? [])
  const [components, setComponents] = useState(seed.components ?? [])
  // An untouched status follows Plan/Auto and completion updates while the editor stays open.
  const [statusEdit, setStatusEdit] = useState<StoryStatus | null>(null)
  const status = statusEdit ?? item?.status ?? 'backlog'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [cascade, setCascade] = useState(true)
  const parents = stories.filter((s) => s.kind === (kind === 'feature' ? 'epic' : 'feature'))
  const validParent = parents.some((s) => s.id === parent) ? parent : ''
  const ready = !!title.trim() && (kind !== 'feature' || !!validParent)
  const save = async () => {
    const fields = {
      title,
      description,
      parent: validParent,
      acceptance: acceptance.map((a) => a.trim()).filter(Boolean),
      components,
    }
    const saved = item
      ? await updateStory(projectId, item.id, {
          ...fields,
          ...(statusEdit === null ? {} : { status: statusEdit }),
        })
      : await storyCreate(projectId, { ...fields, kind, parent: validParent || null })
    if (!item) {
      if (status !== 'backlog') await updateStory(projectId, saved.id, { status })
      await refreshStories(projectId)
    }
    setStatusEdit(null)
    onSaved(saved)
    return saved
  }
  const act = async (action?: 'plan' | 'auto' | 'delete') => {
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
      const saved = await save()
      if (action === 'plan') await planStory(projectId, saved)
      if (action === 'auto') autoStory(projectId, saved)
    } catch (e) {
      setError(String(e))
      if (action === 'plan') useStore.getState().setMessage(String(e))
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
        <button disabled={busy} onClick={onClose} aria-label="Close story editor">
          ×
        </button>
      </header>
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
          <label>
            Status
            <select value={status} onChange={(e) => setStatusEdit(e.target.value as StoryStatus)}>
              {STORY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <p className="story-hint">
            Worktree activity updates the card’s status. Completed work stays Done after cleanup.
          </p>
          <div className="story-editor-actions">
            <button type="submit" disabled={!ready}>
              Save
            </button>
            <button type="button" disabled={!ready} onClick={() => void act('plan')}>
              Plan →
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
                <button type="button" className="danger" onClick={() => void act('delete')}>
                  Delete
                </button>
                <button type="button" onClick={() => setDeleting(false)}>
                  Cancel
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
