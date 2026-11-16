import { expect, test } from 'vitest'
import type { ProviderJob, ProviderRun } from './orchestration'
import type { SessionRecord, SessionState } from '../types'
import { teamJobs, workerCounts, workerSession, workerStatus } from './chatProgress'
const job = (state: ProviderJob['state'], extra = {}): ProviderJob =>
  ({ state, ...extra }) as ProviderJob

test('counts team jobs by lifecycle and live input reports; retains code pending integration', () => {
  const jobs = [
    job('pending'),
    job('launching'),
    job('running'),
    job('integrating'),
    job('running', { sessionId: 'asking' }),
    job('complete', { resultKind: 'code' }),
    job('complete', { resultKind: 'report' }),
    job('complete', { resultKind: 'code', sharedWorktree: true }),
    job('integrated'),
    job('failed'),
  ]
  const sessions = {
    asking: { running: true, status: { agent: { state: 'needsInput' } } },
  } as unknown as Record<string, SessionState>
  expect(workerCounts(jobs, sessions)).toEqual({
    queued: 1,
    starting: 1,
    working: 1,
    integrating: 2,
    'awaiting input': 1,
  })
  expect(workerStatus(job('integrated', { sessionId: 'asking' }), sessions)).toBe('complete')
  expect(
    teamJobs(
      [
        { chatTeam: 'ours', jobs },
        { chatTeam: 'other', jobs: [job('pending')] },
      ] as ProviderRun[],
      'ours',
    ),
  ).toEqual(jobs)
})
test('worker terminal resolves only its exact session in this project', () => {
  const records = [
    { id: 'worker', metadata: { projectId: 'p' } },
    { id: 'lead', metadata: { projectId: 'p' } },
  ] as SessionRecord[]
  expect(workerSession(job('running', { sessionId: 'worker' }), records, 'p')).toBe(records[0])
  expect(workerSession(job('pending'), records, 'p')).toBeUndefined()
  expect(workerSession(job('running', { sessionId: 'worker' }), records, 'other')).toBeUndefined()
})
