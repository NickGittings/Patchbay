import { create } from 'zustand'
import { projectOf, useStore } from '../store'
import {
  sessionId,
  PLAN_SCOPE,
  TASK_ROOT_SCOPE,
  MAP_SCOPE,
  type Project,
  type TerminalSpec,
} from '../types'
import { agentProvider, providerAuthCheck, sessionsList } from './ipc'

export type Provider = 'claude' | 'codex'
export type AuthState = 'signedIn' | 'notRequired' | 'signedOut' | 'cliMissing' | 'unknown'
export interface AuthStatus {
  provider: Provider
  state: AuthState
  message: string
  loginSupported?: boolean
}
export interface AuthRequest {
  provider: Provider
  terminal?: Pick<TerminalSpec, 'command' | 'adapter'>
  project?: Project
  projectId?: string
  componentId?: string
  task?: string
  sessionId?: string
  workingDirectory?: string
}
export interface AuthTarget {
  terminal: Pick<TerminalSpec, 'command' | 'adapter'>
  project?: Project
  componentId?: string
  task?: string | null
  sessionId?: string
  workingDirectory?: string
}
export class ProviderSetupRequired extends Error {
  constructor() {
    super('Complete provider setup, then click Start or Send again. Your work was kept.')
  }
}
interface Setup {
  request: AuthRequest
  result: AuthStatus
}
export const useProviderSetup = create<{ pending: Setup | null }>(() => ({ pending: null }))
const checks = new Map<string, { promise: Promise<AuthStatus>; generation: number }>()
const cached = new Map<string, { at: number; result: AuthStatus }>()
const allowances = new Map<string, number>()
let generation = 0
const keyOf = (request: AuthRequest) =>
  JSON.stringify([
    request.provider,
    request.terminal?.command ?? request.provider,
    request.terminal?.adapter ?? request.provider,
    request.projectId,
    request.project?.root,
    request.project?.components.find((c) => c.id === request.componentId)?.path,
    request.task,
    request.sessionId,
    request.workingDirectory,
  ])
export function invalidateProviderAuth() {
  generation++
  checks.clear()
  cached.clear()
  allowances.clear()
}
export function checkProviderAuth(request: AuthRequest, force = false): Promise<AuthStatus> {
  const key = keyOf(request)
  if (!force) {
    const pending = checks.get(key)
    if (pending) return pending.promise
    const last = cached.get(key)
    if (last && Date.now() - last.at < 30_000) return Promise.resolve(last.result)
  }
  const token = generation
  const promise = providerAuthCheck(request, force || generation > 0)
    .catch((): AuthStatus => ({
      provider: request.provider,
      state: 'unknown',
      message: 'Authentication could not be checked. Retry or continue anyway.',
    }))
    .then((result) => {
      if (token === generation && checks.get(key)?.promise === promise) {
        cached.set(key, { at: Date.now(), result })
        checks.delete(key)
      }
      return result
    })
  checks.set(key, { promise, generation: token })
  return promise
}
export function continueProviderSetup(request: AuthRequest) {
  // One context, in memory only. A later user click is still required.
  allowances.set(keyOf(request), Date.now() + 30_000)
  useProviderSetup.setState({ pending: null })
}
export async function requireProviderAuth(target: AuthTarget): Promise<void> {
  const provider = await agentProvider(target.terminal)
  if (!provider) return
  const request: AuthRequest = {
    provider,
    terminal: target.terminal,
    project: target.project,
    projectId: target.project?.projectId,
    componentId: target.componentId,
    task: target.task ?? undefined,
    sessionId: target.sessionId,
    workingDirectory: target.workingDirectory,
  }
  const key = keyOf(request)
  if ((allowances.get(key) ?? 0) > Date.now()) return
  const token = generation
  const result = await checkProviderAuth(request)
  if (token !== generation) throw new ProviderSetupRequired()
  if (result.state === 'signedIn' || result.state === 'notRequired') return
  // Concurrent launches retain the first blocked provider, rather than switching the dialog.
  if (!useProviderSetup.getState().pending)
    useProviderSetup.setState({ pending: { request, result } })
  throw new ProviderSetupRequired()
}
export async function requireDeviceAuth(
  terminal: AuthTarget['terminal'],
  projectId = useStore.getState().project?.id,
  task = useStore.getState().activeTask,
  componentId?: string,
) {
  const project = projectId ? (projectOf(projectId) ?? undefined) : undefined
  return requireProviderAuth({ terminal, project, task, componentId })
}
/** Final check for every desktop IPC launch, including extensions calling the shared wrappers. */
export async function authenticateInvocation(command: string, args: Record<string, unknown>) {
  if (command === 'session_resume') {
    const sid = args.sessionId as string
    if (useStore.getState().sessions[sid]?.running) return
    const record =
      useStore.getState().sessionRecords.find((r) => r.id === sid) ??
      (await sessionsList()).find((r) => r.id === sid)
    if (record)
      await requireProviderAuth({
        terminal: { command: record.spec.command, adapter: record.metadata.adapter ?? undefined },
        sessionId: sid,
      })
    return
  }
  if (
    ![
      'terminal_start',
      'plan_start',
      'task_root_start',
      'map_agent_start',
      'stack_agent_start',
      'review_agent_start',
      'merge_agent_start',
    ].includes(command)
  )
    return
  const project = args.project as Project
  const componentId = args.componentId as string | undefined
  const terminal =
    (args.terminal as TerminalSpec | undefined) ??
    project.components
      .find((c) => c.id === componentId)
      ?.terminals.find((t) => t.id === args.terminalId)
  if (
    terminal &&
    [
      'terminal_start',
      'task_root_start',
      'plan_start',
      'map_agent_start',
      'stack_agent_start',
    ].includes(command)
  ) {
    const scope =
      componentId ??
      (command === 'plan_start'
        ? PLAN_SCOPE
        : command === 'task_root_start'
          ? TASK_ROOT_SCOPE
          : MAP_SCOPE)
    const sid = sessionId(scope, terminal.id, args.task as string | undefined, project.projectId)
    if (useStore.getState().sessions[sid]?.running && !args.resume) return
  }
  const job = args.request as { worktree?: string; destination?: string } | undefined
  if (terminal)
    await requireProviderAuth({
      terminal,
      project,
      componentId,
      task: args.task as string | undefined,
      workingDirectory: job?.destination ?? job?.worktree,
    })
}
// Focus invalidates cached answers, so the next launch observes external sign-in or expiry.
if (typeof window !== 'undefined') window.addEventListener('focus', invalidateProviderAuth)
