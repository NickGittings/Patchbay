import { projectOf, projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  COORDINATOR_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  TASK_ROOT_SCOPE,
  type SessionRecord,
  plannerSessionId,
  type AutoRun,
  type AutoStage,
  type Story,
  type StoryPatch,
  type StoryStatus,
  type Task,
} from '../types'
import { roleDevice } from './agentRoles'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from './autoDrafts'
import { autoRuns, autoWorkspace } from './autoState'
import { finished, unfinished } from './autoSettings'
import { storyCompleteAuto, storyList, storyReorder, storyUpdate, terminalSnapshot } from './ipc'
import { stopAndWait } from './stopAndWait'
import { startTerminal } from './sessions'
import { recordPlannerStart } from './stageRecord'
import { seedNewTask } from './tasks'
import { confirmAction } from './confirm'

const ordered = (items: Story[]) =>
  [...items].sort(
    (a, b) => a.order - b.order || a.createdMs - b.createdMs || a.id.localeCompare(b.id),
  )

/** Hierarchy, in display order. Parentless and orphan stories remain reachable. */
export function tree(stories: Story[]) {
  const epics = ordered(stories.filter((s) => s.kind === 'epic')).map((epic) => ({
    item: epic,
    features: ordered(stories.filter((s) => s.kind === 'feature' && s.parent === epic.id)).map(
      (feature) => ({
        item: feature,
        stories: ordered(stories.filter((s) => s.kind === 'story' && s.parent === feature.id)),
      }),
    ),
  }))
  const features = new Set(epics.flatMap((e) => e.features.map((f) => f.item.id)))
  return {
    epics,
    unassigned: ordered(
      stories.filter((s) => s.kind === 'story' && (!s.parent || !features.has(s.parent))),
    ),
  }
}

/**
 * The board's top-to-bottom priority, mirrored by core `stories::board_order`: each epic, then its
 * features, each followed by its stories, and finally unassigned stories.
 */
export function boardOrder(stories: Story[]): Story[] {
  const { epics, unassigned } = tree(stories)
  return [
    ...epics.flatMap((e) => [e.item, ...e.features.flatMap((f) => [f.item, ...f.stories])]),
    ...unassigned,
  ]
}

/**
 * The items `item` is prioritized among, as a column shows them together (core
 * `stories::sibling_group`): a feature's stories, an epic's features, else the unassigned.
 */
export function siblings(stories: Story[], item: Story): Story[] {
  const byId = new Map(stories.map((s) => [s.id, s]))
  const group = (s: Story) => {
    const parent = s.parent ? byId.get(s.parent) : undefined
    const shown =
      (s.kind === 'feature' && parent?.kind === 'epic') ||
      // A story sits under its feature only while that feature sits under an epic.
      (s.kind === 'story' &&
        parent?.kind === 'feature' &&
        byId.get(parent.parent ?? '')?.kind === 'epic')
    return shown ? s.parent : null
  }
  return ordered(stories.filter((s) => s.kind === item.kind && group(s) === group(item)))
}

/**
 * The sibling ids, top to bottom, after moving `id` before `before` (`null`: to the end of its
 * group). Undefined when `before` isn't a sibling or nothing would move.
 */
export function reorder(stories: Story[], id: string, before: string | null) {
  const item = stories.find((s) => s.id === id)
  if (!item || before === id) return
  const group = siblings(stories, item).map((s) => s.id)
  if (before !== null && !group.includes(before)) return
  const rest = group.filter((s) => s !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  const ids = [...rest.slice(0, at), id, ...rest.slice(at)]
  return ids.every((s, i) => s === group[i]) ? undefined : ids
}

/** Save a new priority for one sibling group, shown at once and restored if the save fails. */
export async function moveStory(projectId: string, id: string, before: string | null) {
  const state = projectStateOf(projectId)
  const ids = state && reorder(state.stories, id, before)
  if (!ids) return
  const order = new Map(ids.map((s, i) => [s, i]))
  requests.set(projectId, (requests.get(projectId) ?? 0) + 1)
  useStore.getState().patchProject(projectId, {
    stories: state.stories.map((s) => (order.has(s.id) ? { ...s, order: order.get(s.id)! } : s)),
  })
  // Saves run one at a time per project, so quick moves are stored in the order they were made.
  const save = (reorders.get(projectId) ?? Promise.resolve()).then(async () => {
    try {
      await storyReorder(projectId, ids)
      // A refresh that read the board before this save would restore the old order.
      requests.set(projectId, (requests.get(projectId) ?? 0) + 1)
    } catch (e) {
      useStore.getState().setMessage(String(e), undefined, undefined, 'error')
      await refreshStories(projectId)
    }
  })
  reorders.set(projectId, save)
  await save
  if (reorders.get(projectId) === save) reorders.delete(projectId)
}
const reorders = new Map<string, Promise<void>>()

type ParentStatus = 'active' | 'closed'
type LiveStoryStatus = Exclude<StoryStatus, 'backlog' | 'done'>

export function progressLabel(progress: ResolvedStoryStatus['value']) {
  return progress === 'reviewing' ? 'review' : progress === 'merging' ? 'merge' : progress
}

export const STORY_STATUSES: StoryStatus[] = [
  'backlog',
  'planned',
  'building',
  'reviewing',
  'merging',
  'done',
]

/**
 * Most recently started running role wins; a later fix returns a story to Building. Finished
 * sessions leave the saved status in place, so an old merge or review never reappears as live.
 */
export function worktreeStage(
  task: Task,
  projectId: string,
  records: readonly SessionRecord[],
): LiveStoryStatus | null {
  const record = records
    .filter(
      (r) =>
        r.snapshot?.running &&
        r.metadata.projectId === projectId &&
        ((r.metadata.componentId === REVIEW_SCOPE &&
          !!task.branch &&
          r.metadata.branch === task.branch) ||
          (r.metadata.componentId === MERGE_SCOPE && r.spec.merge_source === task.worktree) ||
          (r.metadata.task === task.id &&
            (r.metadata.componentId === COORDINATOR_SCOPE ||
              (r.metadata.componentId === TASK_ROOT_SCOPE &&
                r.metadata.kind === 'agent' &&
                r.spec.purpose !== 'chat')))),
    )
    .sort((a, b) => (a.snapshot?.startedMs ?? 0) - (b.snapshot?.startedMs ?? 0))
    .at(-1)
  if (!record) return null
  return record.metadata.componentId === REVIEW_SCOPE
    ? 'reviewing'
    : record.metadata.componentId === MERGE_SCOPE
      ? 'merging'
      : 'building'
}

export type ResolvedStoryStatus =
  | { value: StoryStatus | ParentStatus; source: 'saved' | 'auto' | 'children' }
  | { value: LiveStoryStatus; source: 'worktree'; worktree: Task }

export type StoryFilter = 'all' | ParentStatus | StoryStatus

export const STORY_FILTERS: { value: StoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'active', label: 'Active' },
  { value: 'planned', label: 'Planned' },
  { value: 'building', label: 'Building' },
  { value: 'reviewing', label: 'Review' },
  { value: 'merging', label: 'Merge' },
  { value: 'done', label: 'Done' },
]

export const PARENT_FILTERS: { value: StoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
]

/** Filter one column by full-board derived status, preserving its display order. */
export function filterStories(
  items: Story[],
  statuses: ReadonlyMap<string, ResolvedStoryStatus>,
  filter: StoryFilter,
): Story[] {
  if (filter === 'all') return items
  return items.filter((item) => {
    const value = statuses.get(item.id)?.value
    return filter === 'active' && item.kind === 'story'
      ? value === 'planned' || value === 'building' || value === 'reviewing' || value === 'merging'
      : value === filter
  })
}

type StoryRuns = Record<
  string,
  (Pick<AutoRun, 'runId' | 'status'> & Partial<Pick<AutoRun, 'stage'>>) | null | undefined
>

const AUTO_STORY_STATUS: Record<AutoStage, LiveStoryStatus | null> = {
  scan: 'planned',
  plan: 'planned',
  implement: 'building',
  validate: 'building',
  fix: 'building',
  review: 'reviewing',
  mergeGate: 'merging',
  merge: 'merging',
  done: null,
}

/** A worktree's live state takes precedence over a saved intermediate status. */
function ownStatus(
  story: Story,
  tasks: Task[],
  runs: StoryRuns,
  projectId: string,
  records: readonly SessionRecord[],
): ResolvedStoryStatus {
  if (story.status === 'done') return { value: 'done', source: 'saved' }
  const task = story.task && tasks.find((t) => t.id === story.task)
  if (
    story.task &&
    story.autoRunId &&
    runs[story.task]?.runId === story.autoRunId &&
    runs[story.task]?.status === 'done'
  )
    return { value: 'done', source: 'auto' }
  if (task && !task.missing) {
    const run = runs[task.id]
    const autoStatus = run?.stage && unfinished(run.status) ? AUTO_STORY_STATUS[run.stage] : null
    const value = autoStatus ?? worktreeStage(task, projectId, records)
    if (value) return { value, source: 'worktree', worktree: task }
  }
  return { value: story.status, source: 'saved' }
}

/** Mirrors core `stories::parent_status`, using live progress when it is available. */
function parentStatus(item: Story, children: ResolvedStoryStatus['value'][]): ParentStatus {
  return item.status === 'done' ||
    (children.length > 0 && children.every((value) => value === 'done' || value === 'closed'))
    ? 'closed'
    : 'active'
}

/** Resolve each item once, sharing both progress and its source with cards and editors. */
export function storyStatuses(
  stories: Story[],
  tasks: Task[],
  runs: StoryRuns,
  projectId: string,
  records: readonly SessionRecord[] = [],
): Map<string, ResolvedStoryStatus> {
  const statuses = new Map<string, ResolvedStoryStatus>()
  const children = new Map<string, Story[]>()
  for (const story of stories) {
    if (!story.parent || story.kind === 'epic') continue
    const siblings = children.get(story.parent) ?? []
    siblings.push(story)
    children.set(story.parent, siblings)
  }
  const resolve = (story: Story): ResolvedStoryStatus => {
    const cached = statuses.get(story.id)
    if (cached) return cached
    const childKind = story.kind === 'epic' ? 'feature' : 'story'
    const childItems = (children.get(story.id) ?? []).filter((s) => s.kind === childKind)
    const status: ResolvedStoryStatus =
      story.kind === 'story'
        ? ownStatus(story, tasks, runs, projectId, records)
        : {
            value: parentStatus(
              story,
              childItems.map((s) => resolve(s).value),
            ),
            source: story.status === 'done' || !childItems.length ? 'saved' : 'children',
          }
    statuses.set(story.id, status)
    return status
  }
  for (const story of stories) resolve(story)
  return statuses
}

/**
 * Acknowledge old completion while preserving an unfinished run's ability to finish.
 * The backend also drops a run whose merged work completed the story.
 */
export function reopenStoryPatch(story: Story, run?: StoryRuns[string]): StoryPatch {
  return {
    reopen: true,
    ...(run && run.runId === story.autoRunId && unfinished(run.status) ? {} : { autoRunId: '' }),
  }
}

/**
 * A workflow's status write, empty when there is nothing to save. Saved Done stays Done. Core
 * skips the status if completion or relinking landed while a launch or poll was in flight, but
 * still applies any linkage sent with it.
 */
export function startedStatus(story: Story, status?: LiveStoryStatus | null): StoryPatch {
  if (story.status === 'done' || story.kind !== 'story' || !status || story.status === status)
    return {}
  return {
    status,
    expectedProgress: { status: story.status, task: story.task, autoRunId: story.autoRunId },
  }
}

export function descendants(stories: Story[], item: Story): Story[] {
  const children = ordered(stories.filter((s) => s.parent === item.id))
  return item.kind === 'story'
    ? []
    : children.flatMap((s) => [
        s,
        ...(s.kind === 'feature' ? ordered(stories.filter((c) => c.parent === s.id)) : []),
      ])
}

export function storyGoal(story: Story, stories: Story[] = []): string {
  const text = (s: Story) =>
    [
      s.title,
      s.description.trim(),
      s.acceptance.length ? s.acceptance.map((a) => `- [ ] ${a}`).join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  return [text(story), ...descendants(stories, story).map(text)].join('\n\n')
}

const requests = new Map<string, number>()
export async function refreshStories(projectId: string) {
  const seq = (requests.get(projectId) ?? 0) + 1
  requests.set(projectId, seq)
  try {
    const stories = await storyList(projectId)
    const state = projectStateOf(projectId)
    // While moves are saving, the file lags the shown order; the next refresh after them catches up.
    if (requests.get(projectId) === seq && !reorders.has(projectId) && state) {
      const removedPlanner = state.planStory && !stories.some((s) => s.id === state.planStory)
      useStore.getState().patchProject(projectId, {
        stories,
        ...(removedPlanner ? { planStory: null, planStoryTerminal: null } : {}),
      })
      for (const { task, run } of autoRuns(state))
        if (run.status === 'done') await completeAutoStories(projectId, task, run.runId)
    }
  } catch (e) {
    // Projects outside Git have no per-user board store.
    if (projectStateOf(projectId)?.stories.length)
      useStore.getState().setMessage(String(e), undefined, undefined, 'error')
  }
}

export async function updateStory(projectId: string, id: string, patch: StoryPatch) {
  const updated = await storyUpdate(projectId, id, patch)
  requests.set(projectId, (requests.get(projectId) ?? 0) + 1)
  const state = projectStateOf(projectId)
  if (state)
    useStore
      .getState()
      .patchProject(projectId, { stories: state.stories.map((s) => (s.id === id ? updated : s)) })
  return updated
}

export async function planStory(projectId: string, story: Story) {
  let s = useStore.getState()
  if (s.project?.id !== projectId) throw new Error('Select the story’s project first')
  // The chat the story was planned from, whichever worktree is shown once the planner starts.
  const task = s.activeTask
  const chat = s.simpleMode
  const device = roleDevice(s.devices, s.agentRoles, 'plan')
  const sid = plannerSessionId(device.id, projectId, s.activeTask)
  if (autoRuns(s).some(({ run }) => unfinished(run.status) && run.sessionId === sid))
    throw new Error('Stop the Auto run before using its planner for a story')
  if ((await terminalSnapshot(sid, 0))?.running) {
    if (
      !(await confirmAction({
        title: 'Replace planner',
        message: 'Stop the running planner and replace it with this story’s planner?',
        confirmLabel: 'Stop and replace',
      }))
    )
      return
    // The app kept running while the dialog was open: recheck what it was opened for.
    const answered = useStore.getState()
    if (answered.project?.id !== projectId || answered.activeTask !== task)
      throw new Error('The worktree changed. Choose Plan again in the intended worktree.')
    if (autoRuns(answered).some(({ run }) => unfinished(run.status) && run.sessionId === sid))
      throw new Error('Stop the Auto run before using its planner for a story')
    await stopAndWait(sid, 'The previous planner is still stopping. Try Plan again.')
    const now = useStore.getState()
    if (now.project?.id !== projectId || now.activeTask !== task)
      throw new Error('The worktree changed. Choose Plan again in the intended worktree.')
    s = now
  }
  const items = [story, ...descendants(s.stories, story)]
  s.clearHighlights()
  for (const id of new Set(items.flatMap((s) => s.components))) s.toggleHighlight(id)
  if (!s.simpleMode) s.setView('plan')
  // Chat follows the planner, so a hidden chat opens rather than starting it out of sight.
  else s.revealChat({ projectId, task })
  s.setPlanActive(device.id)
  const planningAtMs = Date.now()
  const requestId = await launchStoryPlanner(projectId, s.activeTask, device.id, story)
  // Recorded the same way in Chat and the regular views, in the background, so a run lookup
  // never delays the story's status. Chat also shows the story's title from the click.
  if (requestId)
    void recordPlannerStart(projectId, task, device.id, requestId, {
      origin: chat ? 'chat' : 'manual',
      ...(chat ? { text: story.title, atMs: planningAtMs } : {}),
    })
}

/** Components a story's planner or Auto run covers: its own and its descendants'. */
export function storyComponents(stories: Story[], story: Story) {
  return [...new Set([story, ...descendants(stories, story)].flatMap((s) => s.components))]
}

/**
 * Start `story`'s planner in `task`'s worktree, which receives the Story briefing, and mark the
 * story Planned. Callers own confirmation, view changes and launch logging. `components` replaces
 * the worktree's highlighted ones for this launch.
 */
export async function launchStoryPlanner(
  projectId: string,
  task: string | null,
  device: string,
  story: Story,
  components?: string[],
  request?: string,
) {
  // Saved components may have left the map since; none falls back to the worktree's highlights.
  const known = components?.filter((id) =>
    projectOf(projectId)?.components.some((c) => c.id === id),
  )
  const requestId = await startTerminal(PLAN_SCOPE, device, task, projectId, {
    kickoff: { kind: 'planStory' },
    story: story.id,
    components: known?.length ? known : undefined,
    planRequest: request?.trim() || undefined,
  })
  // The planner is running either way, so its launch is still returned for logging.
  try {
    const patch = startedStatus(await findStory(projectId, story.id), 'planned')
    if (patch.status) await updateStory(projectId, story.id, patch)
  } catch (e) {
    useStore
      .getState()
      .setMessage(
        `Planner started, but its story could not be marked Planned: ${String(e)}`,
        undefined,
        undefined,
        'error',
      )
  }
  return requestId
}

/**
 * A story by id as saved. Agent commands write the file directly, so the shown board can lag it
 * by a poll, and workflow guards must compare against the file. Read it directly rather than
 * through refreshStories, whose result a concurrent refresh or move can discard.
 */
export async function findStory(projectId: string, id: string) {
  const story = (await storyList(projectId)).find((s) => s.id === id)
  if (!story) throw new Error(`Unknown story ${id}. Run \`agent stories\` for the board's ids.`)
  return story
}

export async function linkStory(projectId: string, story: string, task: string) {
  if (projectStateOf(projectId)?.stories.find((s) => s.id === story)?.task === task) return
  try {
    await updateStory(projectId, story, { task })
  } catch (e) {
    useStore
      .getState()
      .setMessage(
        `Worktree created, but its story could not be linked: ${String(e)}`,
        undefined,
        undefined,
        'error',
      )
  }
}

export function newWorktreeForStory(projectId: string, story: Story) {
  const s = useStore.getState()
  if (s.project?.id !== projectId) return
  s.clearHighlights()
  for (const id of new Set([story, ...descendants(s.stories, story)].flatMap((s) => s.components)))
    s.toggleHighlight(id)
  seedNewTask((task, pid) => void linkStory(pid, story.id, task.id), {
    title: story.title,
  })
}

export function autoStory(projectId: string, story: Story) {
  const s = useStore.getState()
  if (s.project?.id !== projectId || !projectOf(projectId)) return
  if (s.auto && !finished(s.auto.status)) {
    s.setMessage(
      'This worktree already has an Auto run. Stop it or choose another worktree first.',
      undefined,
      undefined,
      'warning',
    )
    s.showAutoPanel()
    return
  }
  const key = autoDraftKey(projectId, s.activeTask)
  autoDrafts.set(key, {
    ...(autoDrafts.get(key) ?? emptyAutoDraft()),
    goal: storyGoal(story, s.stories),
    story: story.id,
  })
  useStore.setState({ autoDraftVersion: s.autoDraftVersion + 1 })
  s.showAutoPanel()
}

/** The run has already started; keep linkage errors separate from starting it. */
export async function linkAutoStory(projectId: string, task: string | null, story?: string) {
  if (!story || !task) return
  try {
    const item = await findStory(projectId, story)
    const run = autoWorkspace(projectStateOf(projectId), task)?.auto
    const patch = startedStatus(item, run?.stage && AUTO_STORY_STATUS[run.stage])
    await updateStory(projectId, story, { ...patch, task, autoRunId: run?.runId ?? '' })
    if (run?.status === 'done') await completeAutoStories(projectId, task, run.runId)
  } catch (e) {
    useStore
      .getState()
      .setMessage(
        `Auto started, but its story could not be linked: ${String(e)}`,
        undefined,
        undefined,
        'error',
      )
  }
}

/** Only the run linked to this story can complete it; save before normal worktree cleanup. */
export async function completeAutoStories(projectId: string, task: string | null, runId: string) {
  if (!task) return
  const stories = projectStateOf(projectId)?.stories ?? []
  if (
    !stories.some(
      (s) => s.kind === 'story' && s.task === task && s.autoRunId === runId && s.status !== 'done',
    )
  )
    return
  const completed = await storyCompleteAuto(projectId, task, runId)
  requests.set(projectId, (requests.get(projectId) ?? 0) + 1)
  const state = projectStateOf(projectId)
  if (state)
    useStore.getState().patchProject(projectId, {
      stories: state.stories.map((s) =>
        s.task === task && s.autoRunId === runId
          ? (completed.find((done) => done.id === s.id) ?? s)
          : s,
      ),
    })
}
