import { requireProviderAuth, ProviderSetupRequired } from './providerAuth'
import { waitForSetup } from './worktreeSetup'
import { invoke } from '@tauri-apps/api/core'
import { projectOf, projectStateOf, useStore } from '../store'
import type { DeviceManifest, Project, TerminalSpec } from '../types'
import { autoRuns } from './autoState'
import { listenForTerminals, reconcileFreshSessions } from './sessions'

export type JobState =
  'pending' | 'launching' | 'running' | 'complete' | 'failed' | 'integrating' | 'integrated'
export interface ScanReport {
  references: string[]
  findings: string
  uncertainties: string
  suggestedWork: string
}
export interface ProviderJob {
  id: string
  preset: string
  terminal: TerminalSpec
  state: JobState
  requestId: string
  sessionId: string | null
  error: string | null
  report: ScanReport | null
  instructions: string
  components: string[]
  dependencies: string[]
  task: string | null
  base: string | null
  commit: string | null
  summary: string | null
  integratedHead: string | null
}
export interface ProviderRun {
  id: string
  projectId: string
  task: string | null
  kind: 'scan' | 'implementation'
  state: 'running' | 'paused' | 'stopped' | 'complete'
  goal: string
  components: string[]
  target: string
  branch: string
  sourceRevision: string
  integratedHead: string
  jobs: ProviderJob[]
  coordinator: ProviderJob | null
  workers: TerminalSpec[]
  sealed: boolean
  acceptedPartial: boolean
  error: string | null
}
export type ProviderControl =
  { kind: 'pause' | 'resume' | 'stop' | 'continueScan' } | { kind: 'retry'; job: string }
const terminal = (d: DeviceManifest): TerminalSpec => ({
  id: d.id,
  name: d.name,
  kind: 'agent',
  command: d.command,
  adapter: d.adapter,
})
export const providerRuns = (projectId: string) =>
  invoke<ProviderRun[]>('provider_runs', { projectId })
export const controlProviderRun = (projectId: string, id: string, control: ProviderControl) =>
  invoke<ProviderRun>('provider_run_control', { projectId, id, control })
export const startProviderJob = async (project: Project, id: string, job: string) => {
  const run = (await providerRuns(project.projectId!)).find((r) => r.id === id)
  const target = [run?.coordinator, ...(run?.jobs ?? [])].find((j) => j?.id === job)
  if (target) {
    try {
      await requireProviderAuth({ terminal: target.terminal, project, task: run?.task })
    } catch (e) {
      if (e instanceof ProviderSetupRequired)
        await controlProviderRun(project.projectId!, id, { kind: 'pause' })
      throw e
    }
  }
  return invoke<ProviderRun>('provider_job_start', {
    projectId: project.projectId,
    project,
    id,
    job,
  })
}
export async function createProviderRun(
  project: Project,
  kind: ProviderRun['kind'],
  goal: string,
  components: string[],
  task: string | null,
  devices: DeviceManifest[],
  coordinator?: DeviceManifest,
  id: string = crypto.randomUUID(),
) {
  for (const device of [...devices, ...(coordinator ? [coordinator] : [])])
    await requireProviderAuth({ terminal: device, project, task })
  if (kind === 'implementation') await waitForSetup(project.projectId!, task)
  await listenForTerminals()
  return invoke<ProviderRun>('provider_run_create', {
    projectId: project.projectId,
    project,
    draft: {
      id,
      kind,
      goal,
      components,
      task,
      presets: devices.map(terminal),
      coordinator: coordinator ? terminal(coordinator) : null,
    },
  })
}
/** Only jobs whose prerequisites were integrated can start from the latest target revision. */
export function readyJobs(run: ProviderRun) {
  if (run.state !== 'running') return []
  return [run.coordinator, ...run.jobs].filter(
    (job): job is ProviderJob =>
      !!job &&
      job.state === 'pending' &&
      job.dependencies.every((id) =>
        run.jobs.some((dependency) => dependency.id === id && dependency.state === 'integrated'),
      ),
  )
}
/** One scheduler per project; the backend reserves each launch before spawning it. */
const driving = new Set<string>()
export async function driveProviderRuns(projectId: string): Promise<ProviderRun[]> {
  if (driving.has(projectId)) return providerRuns(projectId)
  driving.add(projectId)
  try {
    const runs = await providerRuns(projectId)
    const project = projectOf(projectId)
    if (!project) return runs
    for (const run of runs) {
      const state = projectStateOf(projectId)
      const owner =
        state &&
        autoRuns(state).find(
          ({ run: auto }) => auto.scanRound === run.id || auto.implementationRun === run.id,
        )
      if (owner) {
        const active = useStore.getState()
        const foreground = active.project?.id === projectId && active.activeTask === owner.task
        if (
          !['running', 'waitingOnYou'].includes(owner.run.status) ||
          (!foreground && owner.run.background !== true)
        )
          continue
      }
      // Start all independent jobs even if one fails; successful findings/work survive.
      await Promise.allSettled(
        readyJobs(run).map((job) => startProviderJob(project, run.id, job.id)),
      )
    }
    if (runs.some((run) => readyJobs(run).length)) await reconcileFreshSessions().catch(() => {})
    return await providerRuns(projectId)
  } finally {
    driving.delete(projectId)
  }
}
/** Scheduler outlives individual views, so manual builds progress while another view is open. */
export function watchProviderRuns() {
  let stopped = false
  let busy = false
  const tick = async () => {
    if (stopped || busy || !useStore.getState().serviceConnected) return
    busy = true
    try {
      for (const id of useStore.getState().projectOrder) {
        await driveProviderRuns(id).catch(() => {})
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), 1500)
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
