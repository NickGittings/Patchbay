import { create } from 'zustand'
import { projectOf, useStore, type MessageAction } from '../store'
import {
  MAP_SCOPE,
  STACK_AGENT_TERMINAL,
  sessionId,
  type ComponentGroup,
  type Instances,
  type PendingStack,
  type ProposedCheck,
  type ProposedStackTerminal,
  type TerminalSpec,
} from '../types'
import { startDetectionAgent } from './dependencies'
import {
  autoSetupReport,
  autoSetupSet,
  disableWorktreeSetup,
  enableWorktreeSetup,
  onAutoSetup,
  onStackProposals,
  stackProposalClear,
  stackProposalRead,
  syncAgentProject,
  type AutoSetupOutcome,
} from './ipc'
import { flushMapSaves, mapEditsBlocked } from './mapSave'
import { selectPanel } from './rail'
import { proposedPatch, proposedTerminal, sameStackName } from './stack'
import { graphActionIn } from './actions'
import { planTerminals } from './plan'
import { roleTerminal } from './agentRoles'
import { launching, type StackDetection } from './sessions'

/** A proposal applied without review because an agent asked for it, and how to undo it. */
export interface AutoApplied {
  pending: PendingStack
  /** Where the agent that asked works, for messages. */
  checkout: string
  undo: MessageAction
}

/**
 * Run & test detection's proposals awaiting review in the Stack panel, per open project, and the
 * last one applied automatically (reviewed read-only, with Undo).
 */
export const useStackProposals = create<{
  pending: Record<string, PendingStack>
  busy: Record<string, boolean>
  applied: Record<string, AutoApplied>
}>(() => ({ pending: {}, busy: {}, applied: {} }))

/** Submissions cleared (or being cleared), per project, which a stale read must not bring back. */
const cleared = new Map<string, string>()

const canEdit = (projectId: string) =>
  !!useStore.getState().projects[projectId] &&
  !mapEditsBlocked(useStore.getState().projects[projectId])

function setPending(projectId: string, pending: PendingStack | null) {
  useStackProposals.setState(({ pending: all }) => {
    const next = { ...all }
    if (pending) next[projectId] = pending
    else delete next[projectId]
    return { pending: next }
  })
}

function setBusy(projectId: string, busy: boolean) {
  useStackProposals.setState((s) => ({ busy: { ...s.busy, [projectId]: busy } }))
}

/** Each project's latest read, and the newest one whose result was applied. */
const requested = new Map<string, number>()
const applied = new Map<string, number>()

/**
 * Read `projectId`'s waiting submission; returns whether one is waiting, or `null` when it
 * couldn't be read, leaving whatever is shown. A read older than one already applied may predate
 * a newer submission, so it is ignored.
 */
async function readStackProposal(projectId: string): Promise<boolean | null> {
  const seq = (requested.get(projectId) ?? 0) + 1
  requested.set(projectId, seq)
  let pending: PendingStack | null
  try {
    pending = await stackProposalRead(projectId)
  } catch {
    return null
  }
  if (seq <= (applied.get(projectId) ?? 0)) return !!useStackProposals.getState().pending[projectId]
  applied.set(projectId, seq)
  const shown = !!pending && cleared.get(projectId) !== pending.id
  setPending(projectId, shown ? pending : null)
  return shown
}

/** Read `projectId`'s waiting submission; returns whether one is waiting (or still shown). */
export async function refreshStackProposal(projectId: string): Promise<boolean> {
  return (await readStackProposal(projectId)) ?? !!useStackProposals.getState().pending[projectId]
}

export const stackAgentSession = (projectId: string) =>
  sessionId(MAP_SCOPE, STACK_AGENT_TERMINAL, null, projectId)

/**
 * Start run & test detection with `preset`: a stack to replace, the components whose checks it
 * considers (the whole map when empty), and whether an agent asked for it. One already running is
 * shown instead.
 */
export function startStackAgent(
  projectId: string,
  preset: TerminalSpec,
  detection: StackDetection = {},
) {
  return startDetectionAgent(projectId, preset, {
    terminalId: STACK_AGENT_TERMINAL,
    label: 'Run & test detection',
    tab: 'Detect run & test',
    detection,
  })
}

/** Whether a proposal's version carries checks and isolation. */
const combined = (pending: PendingStack) => (pending.version ?? 1) >= 2

/** What `isolation` says, for agents' briefings (`Project.instances.notes`). */
export function isolationNotes(pending: PendingStack): string {
  const isolation = pending.isolation
  if (!isolation) return ''
  const parts = [
    ...isolation.resources.map((r) => `${r.name} (${r.kind}): ${r.approach}`),
    ...isolation.blockers.map((b) => `Blocker: ${b.name}: ${b.reason}`),
  ]
  return parts.join('; ').slice(0, 2000)
}

/**
 * Make proposed checks Validation terminals: an unassigned task terminal with the same command, or
 * a new one. Checks whose component moved, whose terminal changed role or command, or whose name is
 * taken are skipped and named. Returns how many apply and which component each covers.
 */
export function applyChecks(
  checks: ProposedCheck[],
  componentIds: string[] = [],
): { count: number; components: string[]; skipped: string[] } {
  const s = useStore.getState()
  const skipped: string[] = []
  const components: string[] = []
  for (const t of checks) {
    const node = useStore.getState().nodes.find((n) => n.id === t.component)
    const stale = () =>
      skipped.push(`${t.component} › ${t.name ?? t.terminal}: folder, command or terminal changed`)
    if (
      !node ||
      node.data.path !== t.path ||
      (componentIds.length && !componentIds.includes(t.component))
    ) {
      stale()
      continue
    }
    const terminals = node.data.terminals
    const current = t.terminal
      ? terminals.find((x) => x.id === t.terminal)
      : terminals.find(
          (x) =>
            x.command === t.command &&
            x.kind === 'task' &&
            (x.action === null || x.action === undefined || x.action === 'validation'),
        )
    if (current?.action === 'validation' && current.command === t.command) {
      components.push(t.component)
      continue
    }
    if (t.terminal && !current) {
      stale()
      continue
    }
    if (current && (current.kind !== 'task' || current.action || current.command !== t.command)) {
      stale()
      continue
    }
    if (
      !current &&
      terminals.some((x) => x.name.trim().toLowerCase() === t.name?.trim().toLowerCase())
    ) {
      stale()
      continue
    }
    s.updateTerminal(t.component, current?.id ?? s.addTerminal(t.component, null, false), {
      name: current?.name ?? t.name ?? 'Check',
      command: t.command,
      kind: 'task',
      action: 'validation',
    })
    components.push(t.component)
  }
  return { count: components.length, components: [...new Set(components)], skipped }
}

/** How the review applies a proposal beside its chosen terminals. */
export interface ApplyOptions {
  /** The checks to apply (version 2); every proposed one when omitted. */
  checks?: ProposedCheck[]
  /** Run the applied checks in the active worktree afterwards. */
  run?: boolean
  /** An agent's automatic setup: save at once and report what was applied. */
  auto?: boolean
}

/** What applying changed, to undo it (`undoApplied`). */
export interface Applied {
  before: { nodes: unknown[]; groups: ComponentGroup[]; project: unknown }
  after: { nodes: unknown[]; groups: ComponentGroup[] }
  setup?: string
  /** The preparation command enabled locally before an automatic apply enabled `setup`. */
  previouslyEnabled?: string | null
}

/**
 * Forget the reviewed submission, unless a newer one replaced it, then show any newer one. One
 * already `wasApplied` is hidden at once and stays so even when it can't be forgotten, and the
 * review stays busy until the read after the clear, so it isn't applied twice.
 */
export async function discardStackProposal(projectId: string, id: string, wasApplied = false) {
  cleared.set(projectId, id)
  setBusy(projectId, true)
  if (wasApplied && useStackProposals.getState().pending[projectId]?.id === id)
    setPending(projectId, null)
  try {
    await stackProposalClear(projectId, id).catch((e: unknown) => {
      if (wasApplied)
        useStore
          .getState()
          .setMessage(
            `Applied the stack, but couldn’t forget the proposal: ${e}`,
            undefined,
            undefined,
            'error',
          )
      else {
        cleared.delete(projectId)
        useStore.getState().setMessage(String(e), undefined, undefined, 'error')
      }
    })
    await refreshStackProposal(projectId)
  } finally {
    setBusy(projectId, false)
  }
}

/**
 * Apply reviewed configuration as one ordinary map edit: Development startup (targeted proposals
 * replace by stable id), Validation checks, worktree preparation and the parallel-instance verdict
 * (`Project.instances`). Runs nothing unless `options.run` asks to run the checks. Returns what
 * changed, or null when nothing was applied.
 */
export async function applyStackProposal(
  pending: PendingStack,
  chosen: ProposedStackTerminal[],
  projectId: string,
  includeSetup = false,
  options: ApplyOptions = {},
): Promise<Applied | null> {
  const s = useStore.getState()
  const fail = (text: string) => {
    s.setMessage(text, undefined, undefined, 'warning')
    return null
  }
  if (s.project?.id !== projectId)
    return fail('Switch back to this project to apply its proposed stack.')
  if (!canEdit(projectId))
    return fail('Resolve the map conflict or project recovery before applying the stack.')
  const target = pending.stackId ? s.groups.find((g) => g.id === pending.stackId) : undefined
  if (pending.stackId && !target)
    return fail('The stack to replace was removed. Discard this proposal and detect again.')
  // Each chosen terminal as it is on the map now, which may have changed since the agent looked.
  const edits = chosen.flatMap((t) => {
    const node = s.nodes.find((n) => n.id === t.component)
    if (!node) return []
    const current = proposedTerminal(t, node.data.terminals)
    if (t.terminal && !current) return []
    // The backend refuses these too, but a terminal may have changed since.
    const patch = proposedPatch(t, current, !!target)
    return patch ? [{ t, current, patch }] : []
  })
  if (target && edits.length !== chosen.length)
    return fail(
      'Some proposed terminals were removed or changed roles. Detect again before replacing this stack.',
    )
  // Nothing to apply: keep the proposal, so it can still be read or discarded.
  const setup = includeSetup ? pending.worktreeSetup : undefined
  const checks = combined(pending) ? (options.checks ?? pending.checks ?? []) : []
  const verdict = combined(pending)
  if (!edits.length && !setup && !target && !checks.length && !verdict)
    return fail(
      'None of the chosen terminals can be applied: they were removed, renamed, or are no longer task terminals (or are Validation ones).',
    )
  const before = { nodes: s.nodes, groups: s.groups, project: s.project }
  const wasDirty = s.dirty
  const task = s.activeTask
  if (setup || verdict) {
    const instances: Instances | undefined = verdict
      ? {
          parallelSafe: !!pending.isolation?.parallelSafe && !pending.isolation.blockers.length,
          notes: isolationNotes(pending) || undefined,
          detected: true,
        }
      : s.project?.instances
    useStore.setState({
      project: {
        ...s.project!,
        ...(setup ? { worktreeSetup: { command: setup.command } } : {}),
        ...(instances ? { instances } : {}),
      },
      dirty: true,
    })
  }
  // Development is shared terminal configuration. Keep saved definitions, clearing only startup
  // roles omitted from the complete replacement, including components that leave the stack.
  if (target) {
    const scope = new Set([...target.componentIds, ...edits.map((e) => e.t.component)])
    for (const node of s.nodes) {
      if (!scope.has(node.id)) continue
      for (const terminal of node.data.terminals) {
        if (
          terminal.kind === 'task' &&
          terminal.action === 'development' &&
          !edits.some((e) => e.t.component === node.id && e.current?.id === terminal.id)
        )
          s.updateTerminal(node.id, terminal.id, { action: undefined })
      }
    }
  }
  const members: string[] = []
  for (const { t, current, patch } of edits) {
    s.updateTerminal(t.component, current?.id ?? s.addTerminal(t.component, null, false), patch)
    if (!members.includes(t.component)) members.push(t.component)
  }
  if (target)
    s.updateGroup(target.id, {
      name: pending.name,
      componentIds: members,
      orderedStartup: pending.orderedStartup,
    })
  const existing =
    target ?? useStore.getState().groups.find((g) => sameStackName(g.name, pending.name))
  const added = members.filter((id) => !existing?.componentIds.includes(id))
  if (!target && existing && added.length)
    s.updateGroup(existing.id, { componentIds: [...existing.componentIds, ...added] })
  else if (!target && !existing && added.length)
    s.addGroup(pending.name, added, pending.orderedStartup)
  const applied = applyChecks(checks, pending.componentIds)
  // Some left out: say which, before the clear, whose failure, if any, matters more.
  const skipped = chosen.filter((t) => !edits.some((e) => e.t === t))
  if (skipped.length || applied.skipped.length) {
    const named = skipped.map((t) => {
      const node = s.nodes.find((n) => n.id === t.component)
      const terminal = node?.data.terminals.find((x) => x.id === t.terminal)
      return `${node?.data.name ?? t.component} › ${terminal?.name ?? t.terminal ?? t.name ?? 'Dev'}`
    })
    s.setMessage(
      [
        named.length &&
          `Applied the stack without ${named.join(', ')}: removed, renamed, or no longer a task terminal (or a Validation one).`,
        applied.skipped.length && `Checks left unapplied: ${applied.skipped.join('; ')}.`,
      ]
        .filter(Boolean)
        .join(' '),
      undefined,
      undefined,
      'warning',
    )
  }
  const now = useStore.getState()
  const result: Applied = {
    before,
    after: { nodes: now.nodes, groups: now.groups },
    setup: setup?.command,
  }
  // Capture the updated map and worktree before any asynchronous clearing or project switch.
  const project = options.run ? now.toProject() : null
  if (options.auto || options.run) {
    setBusy(projectId, true)
    try {
      if (!(await flushMapSaves(projectId))) {
        // Unreviewed edits that can't be saved are taken back; the proposal stays for review.
        if (options.auto) {
          if (useStore.getState().project?.id === projectId)
            useStore.setState({
              nodes: before.nodes,
              groups: before.groups,
              project: before.project,
              dirty: wasDirty,
            })
          return null
        }
        if (useStore.getState().project?.id === projectId)
          s.setMessage(
            'The proposal was applied locally. Resolve the map save error or conflict before running its checks.',
            undefined,
            undefined,
            'warning',
          )
        await discardStackProposal(projectId, pending.id, true)
        return result
      }
    } finally {
      setBusy(projectId, false)
    }
  }
  await discardStackProposal(projectId, pending.id, true)
  if (project && applied.components.length)
    try {
      await graphActionIn(projectId, task, project, {
        kind: 'validateSelected',
        componentIds: applied.components,
      })
    } catch (e) {
      if (useStore.getState().project?.id === projectId)
        useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    }
  return result
}

/**
 * Put back what an automatic apply changed, unless it was edited since: terminals of components and
 * stacks still as applied. Worktree preparation is disabled again. Detection stays marked done, so
 * agents don't set it up again; detect manually to retry.
 */
export function undoApplied(projectId: string, applied: Applied): MessageAction {
  return {
    label: 'Undo',
    projectId,
    persist: true,
    run: () => {
      const s = useStore.getState()
      if (s.project?.id !== projectId || mapEditsBlocked(s.projects[projectId])) {
        s.setMessage(
          'Resolve the map conflict or project recovery before undoing the run & test setup',
          undefined,
          undefined,
          'warning',
        )
        return
      }
      type Node = (typeof s.nodes)[number]
      const before = new Map((applied.before.nodes as Node[]).map((n) => [n.id, n]))
      const after = new Map((applied.after.nodes as Node[]).map((n) => [n.id, n]))
      let kept = false
      const nodes = s.nodes.map((n) => {
        const was = before.get(n.id)
        const now = after.get(n.id)
        if (!was || !now || was.data.terminals === now.data.terminals) return n
        if (n.data.terminals !== now.data.terminals) {
          kept = true
          return n
        }
        return { ...n, data: { ...n.data, terminals: was.data.terminals } }
      })
      const groups = s.groups === applied.after.groups ? applied.before.groups : s.groups
      kept ||= s.groups !== applied.after.groups && s.groups !== applied.before.groups
      const previous = applied.before.project as typeof s.project
      useStore.setState({
        nodes,
        groups,
        project: s.project && {
          ...s.project,
          worktreeSetup: previous?.worktreeSetup,
          instances: { parallelSafe: false, detected: true },
        },
        dirty: true,
      })
      if (applied.setup)
        void (
          applied.previouslyEnabled
            ? enableWorktreeSetup(projectId, applied.previouslyEnabled)
            : disableWorktreeSetup(projectId)
        ).catch((e: unknown) =>
          useStore.getState().setMessage(String(e), undefined, undefined, 'error'),
        )
      useStackProposals.setState(({ applied: all }) => {
        const next = { ...all }
        delete next[projectId]
        return { applied: next }
      })
      s.setMessage(
        kept
          ? 'Undid the run & test setup, keeping terminals and stacks edited since'
          : 'Undid the run & test setup',
        true,
      )
    },
  }
}

/** Each project's waiting agents' checkouts, for the message after an automatic setup. */
const askedFrom = new Map<string, string | null>()
/** Automatic submissions already handled, so a repeated read doesn't apply one twice. */
const handled = new Set<string>()

function checkoutName(task: string | null | undefined) {
  if (!task) return 'the main checkout'
  return useStore.getState().tasks.find((t) => t.id === task)?.title ?? task
}

function report(projectId: string, outcome: AutoSetupOutcome) {
  void autoSetupReport(projectId, outcome).catch(() => {})
}

/**
 * An agent asked to set up run & test: start detection with its provider (the planner role's
 * preset otherwise), applied without review when it submits.
 */
export async function startAutoSetup(projectId: string, task: string | null, sessionId: string) {
  askedFrom.set(projectId, task)
  const s = useStore.getState()
  const entry = s.projects[projectId]
  if (!entry) return report(projectId, { kind: 'failed', reason: 'The project is not open' })
  if (mapEditsBlocked(entry))
    return report(projectId, {
      kind: 'review',
      reason: 'the map has a save conflict or is in recovery',
    })
  // A detection already running or waiting for review isn't automatic: say so at once rather
  // than leave the agent waiting for an outcome that never comes.
  const sid = stackAgentSession(projectId)
  if (s.sessions[sid]?.running || launching(sid))
    return report(projectId, {
      kind: 'review',
      reason:
        'run & test detection is already running in Patchbay, and its proposal waits for review',
    })
  if (useStackProposals.getState().pending[projectId])
    return report(projectId, {
      kind: 'review',
      reason: 'a run & test proposal is already waiting for review in the Stack panel',
    })
  const presets = planTerminals(s.devices)
  const adapter = s.sessionRecords.find((r) => r.id === sessionId)?.metadata.adapter
  const preset =
    (adapter && presets.find((t) => t.adapter === adapter)) ??
    roleTerminal(s.devices, s.agentRoles, 'plan') ??
    presets[0]
  if (!preset) return report(projectId, { kind: 'failed', reason: 'No agent preset is available' })
  try {
    if (!(await startStackAgent(projectId, preset, { auto: true })))
      report(projectId, { kind: 'failed', reason: 'Patchbay could not start run & test detection' })
  } catch (e) {
    report(projectId, { kind: 'failed', reason: String(e) })
  }
}

/** Apply an agent-triggered submission with Undo, or leave it for review and say why. */
export async function autoApply(projectId: string, pending: PendingStack) {
  if (handled.has(pending.id)) return
  handled.add(pending.id)
  const s = useStore.getState()
  const name = s.projects[projectId]?.name ?? projectId
  const review = (reason: string) => {
    report(projectId, { kind: 'review', reason })
    useStore
      .getState()
      .setMessage(
        `Run & test detection for ${name} needs review: ${reason}.`,
        false,
        { label: 'Review', projectId, run: () => selectPanel('stack') },
        'warning',
      )
  }
  if (s.project?.id !== projectId) return review(`switch to ${name} in Patchbay to review it`)
  if (!canEdit(projectId)) return review('the map has a save conflict or is in recovery')
  const applied = await applyStackProposal(pending, pending.terminals, projectId, true, {
    auto: true,
  })
  if (!applied) return review('it could not be applied or the map could not be saved')
  const checkout = checkoutName(askedFrom.get(projectId))
  // Undo is available from here on, whatever the remaining steps do.
  const undo = undoApplied(projectId, applied)
  useStackProposals.setState(({ applied: all }) => ({
    applied: { ...all, [projectId]: { pending, checkout, undo } },
  }))
  try {
    if (applied.setup)
      applied.previouslyEnabled = await enableWorktreeSetup(projectId, applied.setup)
    const project = projectOf(projectId)
    if (project) await syncAgentProject(project)
  } catch (e) {
    report(projectId, { kind: 'failed', reason: String(e) })
    useStore
      .getState()
      .setMessage(`Applied run & test for ${name}, but couldn't finish: ${e}`, false, undo, 'error')
    return
  }
  report(projectId, { kind: 'applied', setup: applied.setup ?? null })
  useStore
    .getState()
    .setMessage(
      `Agent in ${checkout} set up run & test for ${name}${applied.setup ? `, including worktree setup \`${applied.setup}\`` : ''}.`,
      false,
      { ...undo, also: { label: 'Review', run: () => selectPanel('stack') } },
      'success',
    )
}

/** Tell the backend each open project's "Let agents set up run & test automatically" choice. */
function followAutoSetupToggle() {
  const sent = new Map<string, boolean>()
  const sync = () => {
    const s = useStore.getState()
    // A reopened project's backend access starts enabled, so it is told again.
    for (const id of sent.keys()) if (!s.projects[id]) sent.delete(id)
    for (const [id, entry] of Object.entries(s.projects)) {
      const off = s.project?.id === id ? s.autoSetupOff : !!entry.state?.autoSetupOff
      if (sent.get(id) === !off) continue
      sent.set(id, !off)
      void autoSetupSet(id, !off).catch(() => sent.delete(id))
    }
  }
  sync()
  return useStore.subscribe((s, prev) => {
    if (s.projects !== prev.projects || s.autoSetupOff !== prev.autoSetupOff) sync()
  })
}

let stop: (() => void) | undefined
/** Main window: load waiting submissions as projects open, and point to new ones. */
export function initializeStackProposals(): () => void {
  if (stop) return stop
  const unlisten = onStackProposals(({ projectId }) => {
    void refreshStackProposal(projectId).then((shown) => {
      const s = useStore.getState()
      const pending = useStackProposals.getState().pending[projectId]
      if (shown && pending?.auto) return void autoApply(projectId, pending)
      if (shown && s.project?.id === projectId && s.utilityPanel !== 'stack')
        s.setMessage('Run & test detection proposed a setup.', false, {
          label: 'Review',
          projectId,
          run: () => selectPanel('stack'),
        })
    })
  })
  const unlistenSetup = onAutoSetup(
    ({ projectId, task, sessionId }) => void startAutoSetup(projectId, task, sessionId),
  )
  const stopToggle = followAutoSetupToggle()
  const checked = new Set<string>()
  const opened = useStore.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.restoring === prev.restoring) return
    for (const id of checked)
      if (!s.projects[id] || mapEditsBlocked(s.projects[id])) checked.delete(id)
    const { pending } = useStackProposals.getState()
    if (Object.keys(pending).some((id) => !s.projects[id]))
      useStackProposals.setState({
        pending: Object.fromEntries(Object.entries(pending).filter(([id]) => s.projects[id])),
      })
    if (s.restoring) return
    // As dependency detection's: once the project's map can be edited, and again after a failed
    // read, at the next project change.
    for (const [id, entry] of Object.entries(s.projects))
      if (!mapEditsBlocked(entry) && !checked.has(id)) {
        checked.add(id)
        void readStackProposal(id).then((shown) => shown === null && checked.delete(id))
      }
  })
  stop = () => {
    opened()
    stopToggle()
    void unlisten.then((f) => f())
    void unlistenSetup.then((f) => f())
    stop = undefined
  }
  return stop
}
