import { create } from 'zustand'
import { projectOf, projectStateOf, useStore } from '../store'
import {
  MAP_AGENT_TERMINAL,
  MAP_SCOPE,
  sessionId,
  type Link,
  type PendingLinks,
  type Project,
  type TerminalSpec,
} from '../types'
import { detectLinks, mapLinksClear, mapLinksRead, onMapLinks } from './ipc'
import { onMapCreated } from './mapSave'
import { revealTerminal } from './attention'
import { startMapAgent } from './sessions'

/** A dependency to review: found in manifests, or proposed by the detection agent. */
export interface FoundLink {
  source: string
  target: string
  label?: string | null
  reason?: string
  detector: 'builtin' | 'agent'
}

export type DependencyDialog =
  | {
      mode: 'offer'
      projectId: string
      /** Manifests were just scanned and named no new dependency. */
      scanned: boolean
    }
  | {
      mode: 'review'
      projectId: string
      links: FoundLink[]
      /** The agent submission under review, cleared once handled. */
      pending?: PendingLinks
    }

interface DependencyState {
  dialog: DependencyDialog | null
  busy: boolean
}
export const useDependencies = create<DependencyState>(() => ({ dialog: null, busy: false }))

/** Components no link touches. */
export function unlinked(project: {
  components: { id: string }[]
  links: Pick<Link, 'source' | 'target'>[]
}) {
  const linked = new Set(project.links.flatMap((l) => [l.source, l.target]))
  return project.components.filter((c) => !linked.has(c.id))
}

/**
 * Whether to offer detection: two or more components, some of them without any dependency (as
 * when manifests only name the ones packages share), and not declined.
 */
export function shouldOfferDetection(
  project: Pick<Project, 'components' | 'links'>,
  dismissed: boolean,
) {
  return !dismissed && project.components.length >= 2 && unlinked(project).length > 0
}

/**
 * The links of `found` the map can take now: both ends still on it, not a self link, and a pair
 * not linked yet in either label. Ids follow detection's `source->target`, suffixed when taken.
 */
export function newLinks(
  project: { components: { id: string }[]; links: Pick<Link, 'id' | 'source' | 'target'>[] },
  found: FoundLink[],
) {
  const ids = new Set(project.components.map((c) => c.id))
  const pairs = new Set(project.links.map((l) => `${l.source}\n${l.target}`))
  const taken = new Set(project.links.map((l) => l.id))
  const out: Link[] = []
  for (const link of found) {
    const pair = `${link.source}\n${link.target}`
    if (!ids.has(link.source) || !ids.has(link.target) || link.source === link.target) continue
    if (pairs.has(pair)) continue
    pairs.add(pair)
    const base = `${link.source}->${link.target}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    out.push({
      detection: { detector: link.detector },
      id,
      source: link.source,
      target: link.target,
      label: link.label?.trim() || null,
    })
  }
  return out
}

/** Add `found` to the map as it is now, as an ordinary edit that autosaves. Returns how many. */
export function appendLinks(projectId: string, found: FoundLink[]): number {
  const current = projectOf(projectId)
  if (!current) return 0
  const links = newLinks(current, found)
  if (!links.length) return 0
  const s = useStore.getState()
  s.syncProject({ ...current, projectId, links: [...current.links, ...links] })
  s.patchProject(projectId, { dirty: true })
  return links.length
}

function message(projectId: string, text: string, transient = false) {
  if (useStore.getState().project?.id === projectId) useStore.getState().setMessage(text, transient)
}

/** Agent submissions the user closed undecided, per project; the menu shows them again. */
const deferred = new Map<string, number>()

/**
 * Scan manifests for links the map lacks. The review and `appendLinks` check each one against the
 * map as it is then, so edits made meanwhile don't spoil the result.
 */
async function scan(projectId: string): Promise<FoundLink[]> {
  const project = projectOf(projectId)
  if (!project) throw new Error('Open the project first')
  const found = await detectLinks({ ...project, projectId })
  return found.map((l) => ({
    source: l.source,
    target: l.target,
    label: l.label,
    detector: 'builtin',
  }))
}

/** Scan manifests and review what they name, or say that they name nothing. */
export async function scanDependencies(projectId: string) {
  if (useDependencies.getState().busy) return
  useDependencies.setState({ busy: true })
  try {
    const found = await scan(projectId)
    useDependencies.setState({
      dialog: found.length
        ? { mode: 'review', projectId, links: found }
        : { mode: 'offer', projectId, scanned: true },
    })
  } catch (e) {
    message(projectId, String(e))
  } finally {
    useDependencies.setState({ busy: false })
  }
}

/** From a menu: review the agent's waiting submission, else offer detection. */
export function offerDependencies(projectId: string) {
  void reviewPending(projectId, true).then((shown) => {
    if (!shown && !useDependencies.getState().dialog)
      useDependencies.setState({ dialog: { mode: 'offer', projectId, scanned: false } })
  })
}

/** Close the dialog. An agent's submission closed undecided stays for the menu to show again. */
export function closeDependencies() {
  const dialog = useDependencies.getState().dialog
  useDependencies.setState({ dialog: null })
  if (dialog?.mode === 'review' && dialog.pending)
    deferred.set(dialog.projectId, dialog.pending.submittedMs)
  // Submissions that arrived while the dialog was open.
  for (const id of Object.keys(useStore.getState().projects)) void reviewPending(id)
}

/** "Not now": stop offering detection for this project after its map is created. */
export function dismissDependencies(projectId: string) {
  useStore.getState().patchProject(projectId, { dependencyPromptDismissed: true })
  closeDependencies()
}

/** Start the detection agent with `preset`, or show the one already running. */
export async function startDependencyAgent(projectId: string, preset: TerminalSpec) {
  closeDependencies()
  const sid = sessionId(MAP_SCOPE, MAP_AGENT_TERMINAL, null, projectId)
  const s = useStore.getState()
  if (s.sessions[sid]?.running) {
    revealTerminal({ sid, componentId: MAP_SCOPE })
    return
  }
  if (!s.runtimeTerminals[sid])
    s.addRuntimeTerminal(sid, {
      projectId,
      taskId: null,
      componentId: MAP_SCOPE,
      terminal: {
        id: MAP_AGENT_TERMINAL,
        name: `Detect dependencies · ${preset.name}`,
        kind: 'agent',
        command: preset.command,
      },
    })
  await startMapAgent(projectId, preset)
  if (useStore.getState().project?.id === projectId) revealTerminal({ sid, componentId: MAP_SCOPE })
}

/**
 * Review a submission waiting for `projectId`. A dialog in use is never replaced, and one the user
 * closed undecided only shows again when `explicit`. Returns whether it is shown.
 */
async function reviewPending(projectId: string, explicit = false): Promise<boolean> {
  const pending = await mapLinksRead(projectId).catch(() => null)
  if (!pending || (!explicit && deferred.get(projectId) === pending.submittedMs)) return false
  const open = useDependencies.getState().dialog
  if (open && !(open.mode === 'offer' && open.projectId === projectId)) return false
  deferred.delete(projectId)
  const links: FoundLink[] = pending.links.map((l) => ({ ...l, detector: 'agent' }))
  useDependencies.setState({ dialog: { mode: 'review', projectId, links, pending } })
  return true
}

/** Add the chosen links and forget the submission they came from. */
export async function acceptDependencies(chosen: FoundLink[]) {
  const dialog = useDependencies.getState().dialog
  if (dialog?.mode !== 'review') return
  const added = appendLinks(dialog.projectId, chosen)
  message(
    dialog.projectId,
    added ? `Added ${added} dependenc${added === 1 ? 'y' : 'ies'}` : 'Nothing new to add',
    true,
  )
  await discardDependencies()
}

/** Close the review, forgetting the agent's submission unless a newer one replaced it. */
export async function discardDependencies() {
  const dialog = useDependencies.getState().dialog
  closeDependencies()
  if (dialog?.mode !== 'review' || !dialog.pending) return
  try {
    await mapLinksClear(dialog.projectId, dialog.pending.submittedMs)
    if (deferred.get(dialog.projectId) === dialog.pending.submittedMs)
      deferred.delete(dialog.projectId)
  } catch (e) {
    message(dialog.projectId, String(e))
  }
  // A newer submission arrived while this one was open.
  await reviewPending(dialog.projectId)
}

/** After the first save of a map without links, scan manifests and offer what they name. */
async function afterCreated(projectId: string) {
  const state = projectStateOf(projectId)
  const project = projectOf(projectId)
  if (!state || !project || !shouldOfferDetection(project, state.dependencyPromptDismissed)) return
  if (useDependencies.getState().dialog) return
  let found: FoundLink[] | null = null
  try {
    found = await scan(projectId)
  } catch (e) {
    // Offer detection anyway, without claiming the manifests named nothing.
    message(projectId, `Couldn’t scan for dependencies: ${String(e)}`)
  }
  if (useDependencies.getState().dialog) return
  useDependencies.setState({
    dialog: found?.length
      ? { mode: 'review', projectId, links: found }
      : { mode: 'offer', projectId, scanned: !!found },
  })
}

let stop: (() => void) | undefined
/** Main window: offer detection on first save and surface agent submissions. */
export function initializeDependencyDetection(): () => void {
  if (stop) return stop
  const unlisten = onMapLinks(({ projectId }) => void reviewPending(projectId))
  const unsubscribe = onMapCreated((id) => void afterCreated(id))
  // A submission made while the app was closed waits for its project's tab, once the backend has
  // the project open: never while restoring or while its folder is unavailable.
  const checked = new Set<string>()
  const opened = useStore.subscribe((s) => {
    for (const id of checked) if (!s.projects[id]) checked.delete(id)
    if (s.restoring) return
    for (const [id, entry] of Object.entries(s.projects))
      if (!entry.unavailable && !checked.has(id)) {
        checked.add(id)
        void reviewPending(id)
      }
  })
  stop = () => {
    unsubscribe()
    opened()
    void unlisten.then((f) => f())
    stop = undefined
  }
  return stop
}
