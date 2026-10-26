import { projectOf, projectStateOf, useStore } from '../store'
import {
  PLAN_SCOPE,
  REVIEW_SCOPE,
  MERGE_SCOPE,
  TASK_ROOT_SCOPE,
  type SessionRecord,
  plannerSessionId,
  type AutoRun,
  type Story,
  type StoryPatch,
  type StoryStatus,
  type Task,
} from '../types'
import { roleDevice } from './agentRoles'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from './autoDrafts'
import { autoRuns, autoWorkspace } from './autoState'
import { finished, unfinished } from './autoSettings'
import { storyCompleteAuto, storyList, storyUpdate, terminalSnapshot, terminalStop } from './ipc'
import { startTerminal } from './sessions'
import { seedNewTask } from './tasks'
import { logSimple } from './simpleActions'

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

export type StoryProgress = StoryStatus | 'reviewing' | 'merging'
export const PROGRESS: StoryProgress[] = [
  'backlog',
  'planned',
  'building',
  'reviewing',
  'merging',
  'done',
]

/** Most recently started role wins; a later fix returns a story to Building. */
export function worktreeStage(
  task: Task,
  projectId: string,
  records: readonly SessionRecord[],
): StoryProgress {
  const record = records
    .filter(
      (r) =>
        r.metadata.projectId === projectId &&
        ((r.metadata.componentId === REVIEW_SCOPE && r.metadata.branch === task.branch) ||
          (r.metadata.componentId === MERGE_SCOPE && r.spec.merge_source === task.worktree) ||
          (r.metadata.componentId === TASK_ROOT_SCOPE && r.metadata.task === task.id)),
    )
    .sort((a, b) => (a.snapshot?.startedMs ?? 0) - (b.snapshot?.startedMs ?? 0))
    .at(-1)
  return record?.metadata.componentId === REVIEW_SCOPE
    ? 'reviewing'
    : record?.metadata.componentId === MERGE_SCOPE
      ? 'merging'
      : 'building'
}

/** A worktree's live state takes precedence over a saved intermediate status. */
export function derivedStatus(
  story: Story,
  tasks: Task[],
  autoRuns: Record<
    string,
    (Pick<AutoRun, 'runId' | 'status'> & Partial<Pick<AutoRun, 'stage'>>) | null | undefined
  >,
  records: readonly SessionRecord[] = [],
): StoryProgress {
  if (story.status === 'done') return 'done'
  const task = story.task && tasks.find((t) => t.id === story.task)
  if (
    story.task &&
    story.autoRunId &&
    autoRuns[story.task]?.runId === story.autoRunId &&
    autoRuns[story.task]?.status === 'done'
  )
    return 'done'
  if (task && !task.missing) {
    const run = autoRuns[task.id]
    if (run && unfinished(run.status))
      return run.stage === 'review'
        ? 'reviewing'
        : run.stage === 'mergeGate' || run.stage === 'merge'
          ? 'merging'
          : 'building'
    return worktreeStage(
      task,
      records.find(
        (r) =>
          r.metadata.task === task.id ||
          r.spec.cwd === task.worktree ||
          r.spec.merge_source === task.worktree,
      )?.metadata.projectId ?? '',
      records,
    )
  }
  return story.status === 'planned' ? 'planned' : 'backlog'
}

export const STORY_STATUSES: StoryStatus[] = ['backlog', 'planned', 'building', 'done']

/** Parents progress as far as their least advanced child; empty parents keep their own status. */
export function rollup(parent: StoryProgress, children: StoryProgress[]): StoryProgress {
  return children.length ? PROGRESS[Math.min(...children.map((s) => PROGRESS.indexOf(s)))] : parent
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
    if (requests.get(projectId) === seq && state) {
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
    if (projectStateOf(projectId)?.stories.length) useStore.getState().setMessage(String(e))
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
  const s = useStore.getState()
  if (s.project?.id !== projectId) throw new Error('Select the story’s project first')
  // The chat the story was planned from, whichever worktree is shown once the planner starts.
  const task = s.activeTask
  const chat = s.simpleMode
  const device = roleDevice(s.devices, s.agentRoles, 'plan')
  const sid = plannerSessionId(device.id, projectId)
  if (autoRuns(s).some(({ run }) => unfinished(run.status) && run.sessionId === sid))
    throw new Error('Stop the Auto run before using its planner for a story')
  if ((await terminalSnapshot(sid))?.running) {
    if (!window.confirm('Stop the running planner and replace it with this story’s planner?'))
      return
    await terminalStop(sid)
    const deadline = Date.now() + 10000
    while ((await terminalSnapshot(sid))?.running) {
      if (Date.now() >= deadline)
        throw new Error('The previous planner is still stopping. Try Plan again.')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const now = useStore.getState()
    if (now.project?.id !== projectId || now.activeTask !== task)
      throw new Error('The worktree changed. Choose Plan again in the intended worktree.')
  }
  const items = [story, ...descendants(s.stories, story)]
  s.clearHighlights()
  for (const id of new Set(items.flatMap((s) => s.components))) s.toggleHighlight(id)
  if (!s.simpleMode) s.setView('plan')
  s.setPlanActive(device.id)
  const planningAtMs = Date.now()
  await startTerminal(PLAN_SCOPE, device.id, null, projectId, {
    kickoff: { kind: 'planStory' },
    story: story.id,
  })
  if (chat)
    logSimple(projectId, task, {
      kind: 'action',
      action: 'plan',
      stage: 'plan',
      sessionId: sid,
      // The store may still hold the stopped planner's run until its `started` event arrives;
      // the service already knows the one just launched.
      generation:
        (await terminalSnapshot(sid).catch(() => null))?.generation ??
        useStore.getState().sessions[sid]?.generation,
      text: story.title,
      atMs: planningAtMs,
    })
  await updateStory(projectId, story.id, { status: 'planned' })
}

export async function linkStory(projectId: string, story: string, task: string) {
  if (projectStateOf(projectId)?.stories.find((s) => s.id === story)?.task === task) return
  try {
    await updateStory(projectId, story, { task })
  } catch (e) {
    useStore
      .getState()
      .setMessage(`Worktree created, but its story could not be linked: ${String(e)}`)
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
    copyPlan: true,
  })
}

export function autoStory(projectId: string, story: Story) {
  const s = useStore.getState()
  if (s.project?.id !== projectId || !projectOf(projectId)) return
  if (s.auto && !finished(s.auto.status)) {
    s.setMessage('This worktree already has an Auto run. Stop it or choose another worktree first.')
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
    const run = autoWorkspace(projectStateOf(projectId), task)?.auto
    await updateStory(projectId, story, { task, autoRunId: run?.runId ?? '' })
    if (run?.status === 'done') await completeAutoStories(projectId, task, run.runId)
  } catch (e) {
    useStore.getState().setMessage(`Auto started, but its story could not be linked: ${String(e)}`)
  }
}

/** Only the run linked to this story can complete it; save before normal worktree cleanup. */
export async function completeAutoStories(projectId: string, task: string | null, runId: string) {
  if (!task) return
  const stories = projectStateOf(projectId)?.stories ?? []
  if (!stories.some((s) => s.task === task && s.autoRunId === runId && s.status !== 'done')) return
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
