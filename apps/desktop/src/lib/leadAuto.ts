import { projectStateOf, workspaceOf } from '../store'
import type { AutoRun, Story } from '../types'
import { autoOverrides, defaultAutoEffort } from './autoSettings'
import { controlTeam, requestTeam, type ChatTeam } from './chatTeams'
import { gitBranches, gitWorktrees } from './ipc'

type Workflow = NonNullable<ChatTeam['requests']>[number]

/** A running lead Auto request's saved result: the run whose outcome settles it. */
export interface LeadAutoRun {
  /** For a request that creates a worktree, null until the worktree exists. */
  task: string | null
  /** Missing while Auto starts in a worktree the request created, or until it is read back. */
  runId?: string
  story?: string
  /** The branch of a worktree the request created, which the lead names to the user. */
  branch?: string
}

export function savedAutoRun(result: string | null | undefined): LeadAutoRun | null {
  try {
    const run = JSON.parse(result ?? '') as Partial<LeadAutoRun> | null
    return run &&
      (run.runId === undefined || typeof run.runId === 'string') &&
      (typeof run.task === 'string' || run.task === null)
      ? (run as LeadAutoRun)
      : null
  } catch {
    return null
  }
}

/** `newWorktree: true` or `{ branch?, base? }`; anything else asks for no new worktree. */
export function newWorktreeSettings(value: unknown): { branch?: string; base?: string } | null {
  if (value === true) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { branch, base } = value as Record<string, unknown>
  return {
    ...(typeof branch === 'string' && branch.trim() ? { branch: branch.trim() } : {}),
    ...(typeof base === 'string' && base.trim() ? { base: base.trim() } : {}),
  }
}

/** `wanted`, or the first `wanted-N` no existing branch uses. */
export function freeBranch(wanted: string, branches: readonly string[]) {
  const taken = new Set(branches)
  if (!taken.has(wanted)) return wanted
  for (let i = 2; ; i++) if (!taken.has(`${wanted}-${i}`)) return `${wanted}-${i}`
}

/** Ends a story result whose run goes on after it settles; `followLeadAuto` reports how it ends. */
export const FOLLOWED = 'Patchbay will note how its run ends.'

/** A pause Auto resumes without the user: a usage reset, a schedule or an autonomous restart. */
const resumesByItself = (run: AutoRun) =>
  !!run.resumeTrigger || (run.pauseKind === 'restored' && !!run.autonomous && !!run.restartPending)

/**
 * What settles a lead's Auto request, or null while the run still works or waits on something
 * that resumes by itself.
 */
export function autoOutcome(
  run: AutoRun | null | undefined,
  saved: LeadAutoRun,
  request: string,
): { state: 'completed' | 'failed'; text: string } | null {
  const label = saved.story ? `Story ${saved.story}` : 'The Auto run'
  const where = saved.branch ? ` (worktree branch ${saved.branch})` : ''
  // Only a story's run is followed after it settles (`followLeadAuto`).
  const followed = saved.story ? ` ${FOLLOWED}` : ''
  const reason = (fallback: string) => run?.reason?.trim() || fallback
  if (!run || run.runId !== saved.runId)
    return {
      state: 'failed',
      text: `${label}${where}: its Auto run was replaced or removed. Inspect the worktree.`,
    }
  if (run.status === 'done') return { state: 'completed', text: `${label}${where} is done.` }
  if (run.status === 'stopped')
    return {
      state: 'failed',
      text: `${label}${where} was stopped: ${reason('no reason recorded')}.`,
    }
  if (run.status === 'failed')
    return { state: 'failed', text: `${label}${where} failed: ${reason('no reason recorded')}.` }
  if (run.status === 'waitingOnYou' && run.stage === 'mergeGate')
    return {
      state: 'completed',
      text: `${label}${where} is reviewed and waiting for the user's merge approval. Don't merge it: the user approves merges.`,
    }
  if (run.status === 'paused' && (run.pauseKind === 'user' || !run.pauseKind))
    return {
      state: 'failed',
      text: `${label}${where} was paused by the user. Use resumeAuto with {"request": "${request}"} only if they ask.${followed}`,
    }
  // Every other pause that won't resume by itself (interrupted, inactive, a blocked restart, a
  // usage wait without resume) waits on the user like a question does.
  if (run.status === 'waitingOnYou' || (run.status === 'paused' && !resumesByItself(run)))
    return {
      state: 'failed',
      text: `${label}${where} needs the user: ${reason('it is waiting for input')}. Its run continues once they act; don't retry it or answer for them.${followed}`,
    }
  return null
}

/** The worktree a `startAuto` request runs in, for pauseAuto, resumeAuto and stopAuto. */
export function leadAutoTask(team: ChatTeam, id: string): string | null {
  const started = team.requests?.find((r) => r.id === id && r.action === 'startAuto')
  if (!started) throw new Error(`Unknown startAuto request ${id}`)
  const fresh = newWorktreeSettings(started.settings.newWorktree)
  const saved = savedAutoRun(started.result)
  if (saved && (saved.task || !fresh)) return saved.task
  if (!fresh) return requestTeam(team, started, { started: true }).task
  // A settled request's result is its outcome text; its story still names the worktree.
  const story = projectStateOf(team.projectId)?.stories.find((s) => s.id === started.settings.story)
  if (!story?.task) throw new Error(`Workflow ${id}'s story is no longer linked to its worktree`)
  return story.task
}

const storyComponents = (
  story: Story,
  all: Story[],
  descendants: (s: Story[], i: Story) => Story[],
) => [...new Set([story, ...descendants(all, story)].flatMap((s) => s.components))]

const ASK_MERGE = { mode: 'ask', destinationBranch: '' } as const

/** The request's Auto settings, its story and whether it creates a worktree. */
async function prepare(team: ChatTeam, request: Workflow) {
  const state = projectStateOf(team.projectId)
  if (!state) throw new Error('Project is unavailable')
  // `worktree` chose where the run works (`requestTeam`); it is no Auto setting.
  const { story: storyId, newWorktree, worktree: _worktree, ...requested } = request.settings
  const fresh = newWorktreeSettings(newWorktree)
  if (fresh && typeof storyId !== 'string') throw new Error('newWorktree needs a story')
  // Loaded only for a story, the board's code and its imports aren't needed otherwise.
  const stories = typeof storyId === 'string' ? await import('./stories') : undefined
  const story =
    stories && typeof storyId === 'string'
      ? await stories.findStory(team.projectId, storyId)
      : undefined
  const previous = workspaceOf(state, team.task).auto
  const device =
    typeof request.settings.device === 'string' ? request.settings.device : team.lead.preset.id
  const settings = {
    goal: team.checkpoint.goal,
    effort: defaultAutoEffort(state.simpleMode),
    // The lead's own run says nothing about where a new story worktree merges.
    merge: fresh ? ASK_MERGE : (previous?.merge ?? ASK_MERGE),
    overrides: previous?.overrides,
    agents: previous?.agents,
    reviewers: previous?.reviewers,
    scanners: previous?.scanners,
    workers: previous?.workers,
    autonomous: previous?.autonomous,
    background: previous?.background,
    resumeOnUsageReset: previous?.resumeOnUsageReset,
    // A new worktree's run works unattended, beside whatever the user has on screen.
    ...(fresh ? { autonomous: true, resumeOnUsageReset: true } : {}),
    ...requested,
    ...(fresh ? { background: true } : {}),
    // A story's own text is the goal, as in the Auto panel, even beside a requested goal.
    ...(story ? { goal: stories!.storyGoal(story, state.stories) } : {}),
    device,
  } as import('./auto').AutoSettings
  if (settings.merge.mode !== 'ask') throw new Error('Lead-started Auto requires merge approval')
  settings.overrides = autoOverrides(state.simpleMode, settings.overrides)
  return { state, fresh, story, stories, settings }
}

// Branches chosen for worktrees still being created, so concurrent starts never pick the same one.
const reserved = new Map<string, Set<string>>()
async function reserveBranch(projectId: string, wanted: string) {
  const branches = await gitBranches(projectId)
  const taken = reserved.get(projectId) ?? new Set<string>()
  reserved.set(projectId, taken)
  const branch = freeBranch(wanted, [...branches, ...taken])
  taken.add(branch)
  return branch
}
const releaseBranch = (projectId: string, branch: string | undefined) =>
  branch && reserved.get(projectId)?.delete(branch)

const save = (team: ChatTeam, request: Workflow, run: LeadAutoRun) =>
  controlTeam(team, {
    kind: 'requestState',
    id: request.id,
    state: 'running',
    result: JSON.stringify(run),
  })

/**
 * Start the lead's Auto request, optionally in a new worktree for its story. It stays running
 * until `settleLeadAuto` sees the run finish, reach the merge gate or need the user, and that
 * result wakes the lead.
 */
export async function startLeadAuto(team: ChatTeam, request: Workflow) {
  const { state, fresh, story, stories, settings } = await prepare(team, request)
  if (!fresh || !story || !stories) {
    const auto = await import('./auto')
    await auto.startAuto(team.projectId, team.task, settings)
    // Linked once the run started, as the Auto panel does.
    if (story) await stories!.linkAutoStory(team.projectId, team.task, story.id)
    const runId = workspaceOf(projectStateOf(team.projectId) ?? state, team.task).auto?.runId
    // A run in another worktree is named by its branch, so the lead can tell the user where.
    const branch = team.task ? state.tasks.find((t) => t.id === team.task)?.branch : undefined
    // Without a runId, `settleLeadAuto` adopts the worktree's run on its next look.
    await save(team, request, {
      task: team.task,
      ...(runId ? { runId } : {}),
      ...(story ? { story: story.id } : {}),
      ...(branch ? { branch } : {}),
    })
    return
  }
  const { branchFor } = await import('./tasks')
  const branch = await reserveBranch(
    team.projectId,
    fresh.branch ?? (branchFor(story.title) || `story-${story.id}`),
  )
  const run: LeadAutoRun = { task: null, story: story.id, branch }
  try {
    // Saved before anything is created, so a restart finds this branch's worktree or makes it.
    await save(team, request, run)
  } catch (error) {
    releaseBranch(team.projectId, branch)
    throw error
  }
  launch(team, request, run)
}

/** Where a story worktree starts: as asked, else where its Auto run will merge. */
async function storyBase(
  projectId: string,
  request: Workflow,
  merge: { destinationBranch: string },
) {
  const asked = newWorktreeSettings(request.settings.newWorktree)?.base
  if (asked || merge.destinationBranch) return asked || merge.destinationBranch
  const [worktrees, branches] = await Promise.all([gitWorktrees(projectId), gitBranches(projectId)])
  const { defaultMergeDestination } = await import('./reviewAgents')
  // An explicit base also makes git create the branch, never check out a remote one of that name.
  return defaultMergeDestination(undefined, worktrees, branches) || undefined
}

/** The worktree a restart left behind for this branch, or a new one. */
async function storyWorktree(team: ChatTeam, request: Workflow, run: LeadAutoRun) {
  const existing = projectStateOf(team.projectId)?.tasks.find((t) => t.branch === run.branch)
  if (existing) return existing.id
  const { settings, story, stories, state } = await prepare(team, request)
  const { createBackgroundTask } = await import('./tasks')
  try {
    const created = await createBackgroundTask(team.projectId, {
      title: story!.title,
      branch: run.branch!,
      base: await storyBase(team.projectId, request, settings.merge),
      components: storyComponents(story!, state.stories, stories!.descendants),
    })
    return created.id
  } finally {
    releaseBranch(team.projectId, run.branch)
  }
}

const launching = new Set<string>()
const launchKey = (team: ChatTeam, request: Workflow) =>
  `${team.projectId}\n${team.id}\n${request.id}`

/**
 * Create the story's worktree and start Auto there. It runs detached: creating the worktree and
 * Auto's wait for its setup must not hold up the provider-run tick that drives every project.
 */
function launch(team: ChatTeam, request: Workflow, saved: LeadAutoRun) {
  const key = launchKey(team, request)
  if (launching.has(key)) return
  launching.add(key)
  void (async () => {
    let run = saved
    const stories = await import('./stories')
    const fail = async (what: string, error: unknown) => {
      // Back in the backlog, so the user can start it again once its cause is fixed.
      const story = projectStateOf(team.projectId)?.stories.find((s) => s.id === run.story)
      if (run.task && run.story && story?.task === run.task)
        await stories.updateStory(team.projectId, run.story, { task: '' }).catch(() => {})
      const where = run.task
        ? `Worktree branch ${run.branch} was created for story ${run.story}, but ${what}`
        : `Story ${run.story}'s worktree could not be created`
      const after = run.task ? ' The worktree stays for the user to inspect or delete.' : ''
      await controlTeam(team, {
        kind: 'requestState',
        id: request.id,
        state: 'failed',
        result: `${where}: ${String(error)}. The story is in the backlog again: don't start it again in this backlog run unless the user asks.${after}`,
      }).catch(() => {})
    }
    try {
      if (!run.task) {
        try {
          run = { ...run, task: await storyWorktree(team, request, run) }
        } catch (error) {
          return await fail('', error)
        }
        try {
          await save(team, request, run)
        } catch (error) {
          return await fail('its request could not be saved', error)
        }
      }
      try {
        // Linked at once, so `agent stories` no longer offers it as next while Auto starts.
        if (run.story) await stories.updateStory(team.projectId, run.story, { task: run.task! })
      } catch (error) {
        return await fail('the story could not be linked to it', error)
      }
      try {
        const { settings } = await prepare(team, request)
        const auto = await import('./auto')
        await auto.startAuto(team.projectId, run.task, settings)
      } catch (error) {
        return await fail('Auto did not start', error)
      }
      if (run.story) await stories.linkAutoStory(team.projectId, run.task, run.story)
      const state = projectStateOf(team.projectId)
      const runId = state ? workspaceOf(state, run.task).auto?.runId : undefined
      // A missed save leaves the runId out, and `settleLeadAuto` adopts the run later.
      if (runId) await save(team, request, { ...run, runId }).catch(() => {})
    } finally {
      // Only now, so no settle starts Auto again while this one still saves its run.
      launching.delete(key)
    }
  })()
}

/** Report a running Auto request once its run settles; a closed project waits for reopening. */
export async function settleLeadAuto(team: ChatTeam, request: Workflow) {
  const saved = savedAutoRun(request.result)
  const finish = (state: 'completed' | 'failed', result: string) =>
    controlTeam(team, { kind: 'requestState', id: request.id, state, result })
  if (!saved)
    return finish('failed', 'The Auto run can no longer be tracked. Inspect the worktree.')
  const state = projectStateOf(team.projectId)
  if (!state) return
  if (!saved.runId) {
    if (launching.has(launchKey(team, request))) return
    const fresh = !!newWorktreeSettings(request.settings.newWorktree)
    // A restart interrupted creating the worktree: find or create it, then start Auto.
    if (fresh && !saved.task) return launch(team, request, saved)
    const current = workspaceOf(state, saved.task).auto
    // Auto started but its run was not saved: the worktree's run is this request's.
    if (current?.runId) return save(team, request, { ...saved, runId: current.runId })
    // A restart interrupted the start in the worktree the request created: start it again.
    if (fresh) return launch(team, request, saved)
    return finish('failed', 'The Auto run can no longer be tracked. Inspect the worktree.')
  }
  const outcome = autoOutcome(workspaceOf(state, saved.task).auto, saved, request.id)
  if (outcome) await finish(outcome.state, outcome.text)
}

/**
 * A story request settled because its run needed or was paused by the user, and that run went
 * on: once it ends, tell the lead with its next delivery, so its summary stays current.
 */
export async function followLeadAuto(team: ChatTeam, request: Workflow) {
  if (!request.result?.endsWith(FOLLOWED) || typeof request.settings.story !== 'string') return
  const id = `auto-${request.id}`
  if (team.messages.some((m) => m.id === `note-${id}`)) return
  const state = projectStateOf(team.projectId)
  const story = state?.stories.find((s) => s.id === request.settings.story)
  if (!state || !story?.autoRunId) return
  const run = workspaceOf(state, story.task).auto
  if (run?.runId !== story.autoRunId) return
  // A worktree the request created is named by its branch, as in the request's result.
  const branch = newWorktreeSettings(request.settings.newWorktree)
    ? state.tasks.find((t) => t.id === story.task)?.branch
    : undefined
  const outcome = autoOutcome(
    run,
    { task: story.task, runId: run.runId, story: story.id, ...(branch ? { branch } : {}) },
    request.id,
  )
  if (!outcome || outcome.text.endsWith(FOLLOWED)) return
  await controlTeam(team, {
    kind: 'note',
    id,
    text: `Update on workflow ${request.id}: ${outcome.text}`,
    sessions: [],
  })
}
