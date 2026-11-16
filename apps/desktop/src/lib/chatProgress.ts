import type { ProviderJob, ProviderRun } from './orchestration'
import type { SessionRecord, SessionState } from '../types'

export function teamJobs(runs: ProviderRun[], teamId: string): ProviderJob[] {
  return runs.filter((run) => run.chatTeam === teamId).flatMap((run) => run.jobs)
}
export function workerStatus(job: ProviderJob, sessions: Record<string, SessionState>) {
  if (
    ['pending', 'launching', 'running', 'integrating'].includes(job.state) &&
    job.sessionId &&
    sessions[job.sessionId]?.running &&
    sessions[job.sessionId]?.status?.agent?.state === 'needsInput'
  )
    return 'awaiting input'
  switch (job.state) {
    case 'pending':
      return 'queued'
    case 'launching':
      return 'starting'
    case 'running':
      return 'working'
    case 'integrating':
      return 'integrating'
    case 'failed':
      return 'failed'
    case 'complete':
      return job.resultKind === 'code' && !job.sharedWorktree ? 'integrating' : 'complete'
    case 'integrated':
      return 'complete'
  }
}
export function workerCounts(jobs: ProviderJob[], sessions: Record<string, SessionState>) {
  const counts = { queued: 0, starting: 0, working: 0, integrating: 0, 'awaiting input': 0 }
  for (const job of jobs) {
    const status = workerStatus(job, sessions)
    if (status in counts) counts[status as keyof typeof counts]++
  }
  return counts
}
export function workerSession(job: ProviderJob, records: SessionRecord[], projectId: string) {
  return records.find(
    (record) => record.id === job.sessionId && record.metadata.projectId === projectId,
  )
}
