import { create } from 'zustand'
import { appendToMap, projectOf, projectStateOf, useStore, type ProjectEntry } from '../store'
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
import { mapBlocked, onMapCreated } from './mapSave'
import { revealTerminal } from './attention'
import { planTerminals } from './plan'
import { launching, mapPresetId, startMapAgent } from './sessions'

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
  /**
   * One dialog per project, queued until its tab is active: only the active project's shows, and a
   * dialog never blocks another project's.
   */
  dialogs: Record<string, DependencyDialog>
  /** Projects scanning or clearing a submission, whose dialog waits: how many such jobs run. */
  busy: Record<string, number>
}
export const useDependencies = create<DependencyState>(() => ({ dialogs: {}, busy: {} }))

/** Dependency reviews must wait until either kind of saved-map conflict is resolved. */
export const dependencyMapBlocked = (entry: ProjectEntry | undefined) =>
  mapBlocked(entry) || entry?.mapSave?.status === 'conflict'

function canDetect(projectId: string) {
  return (
    !!projectStateOf(projectId) && !dependencyMapBlocked(useStore.getState().projects[projectId])
  )
}

const dialogOf = (projectId: string) => useDependencies.getState().dialogs[projectId]

function setDialog(projectId: string, dialog: DependencyDialog | null) {
  if (dialog && !canDetect(projectId)) return
  useDependencies.setState(({ dialogs }) => {
    const next = { ...dialogs }
    if (dialog) next[projectId] = dialog
    else delete next[projectId]
    return { dialogs: next }
  })
}

/** Count a job for `projectId` in (`busy`) or out, so overlapping jobs keep it busy. */
function setBusy(projectId: string, busy: boolean) {
  useDependencies.setState((s) => {
    const next = { ...s.busy }
    const count = (next[projectId] ?? 0) + (busy ? 1 : -1)
    if (count > 0) next[projectId] = count
    else delete next[projectId]
    return { busy: next }
  })
}

const isBusy = (projectId: string) => !!useDependencies.getState().busy[projectId]

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
  if (!canDetect(projectId)) return 0
  const added = appendToMap(projectId, (current) => {
    const links = newLinks(current, found)
    return links.length ? { links } : null
  })
  return added?.links.length ?? 0
}

function message(projectId: string, text: string, transient = false) {
  if (useStore.getState().project?.id === projectId) useStore.getState().setMessage(text, transient)
}

/** Agent submissions the user closed undecided, per project; the menu shows them again. */
const deferred = new Map<string, string>()
/** Submissions cleared (or being cleared), per project, which a stale read must not reopen. */
const cleared = new Map<string, string>()

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
  if (!canDetect(projectId) || isBusy(projectId)) return
  setBusy(projectId, true)
  try {
    const found = await scan(projectId)
    // The project may have closed meanwhile.
    if (!projectStateOf(projectId)) return
    setDialog(
      projectId,
      found.length
        ? { mode: 'review', projectId, links: found }
        : { mode: 'offer', projectId, scanned: true },
    )
  } catch (e) {
    message(projectId, String(e))
  } finally {
    setBusy(projectId, false)
  }
}

/** From a menu: review the agent's waiting submission, else offer detection. */
export function offerDependencies(projectId: string) {
  if (!canDetect(projectId)) return
  void reviewPending(projectId, true).then((shown) => {
    if (!shown && !dialogOf(projectId) && projectStateOf(projectId))
      setDialog(projectId, { mode: 'offer', projectId, scanned: false })
  })
}

/**
 * Close `projectId`'s dialog. An agent's submission closed undecided stays for the menu to show
 * again; one that arrived while the dialog was open shows now.
 */
export function closeDependencies(projectId: string) {
  const dialog = dialogOf(projectId)
  setDialog(projectId, null)
  if (dialog?.mode === 'review' && dialog.pending) deferred.set(projectId, dialog.pending.id)
  void reviewPending(projectId)
}

/** "Not now": stop offering detection for this project after its map is created. */
export function dismissDependencies(projectId: string) {
  useStore.getState().patchProject(projectId, { dependencyPromptDismissed: true })
  closeDependencies(projectId)
}

/**
 * Start the detection agent with `preset`. One already running or on its way is shown instead, and
 * the user is told when it runs another preset; an exited one restarts with `preset`. Only a
 * session that started is revealed.
 */
export async function startDependencyAgent(projectId: string, preset: TerminalSpec) {
  if (!canDetect(projectId)) return
  closeDependencies(projectId)
  const sid = sessionId(MAP_SCOPE, MAP_AGENT_TERMINAL, null, projectId)
  const s = useStore.getState()
  // A launch on its way keeps the preset and tab it started with.
  if (s.sessions[sid]?.running || launching(sid)) {
    const running = mapPresetId(sid)
    if (running && running !== preset.id) {
      const name = planTerminals(s.devices).find((t) => t.id === running)?.name ?? running
      message(
        projectId,
        `Dependency detection is already running with ${name}. Stop it to detect with ${preset.name}.`,
      )
    }
    if (s.project?.id === projectId) revealTerminal({ sid, componentId: MAP_SCOPE })
    return
  }
  // The tab names the preset this launch runs, also when an earlier one ran another.
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
  const started = await startMapAgent(projectId, preset)
  if (started && useStore.getState().project?.id === projectId)
    revealTerminal({ sid, componentId: MAP_SCOPE })
}

/**
 * Review a submission waiting for `projectId`. A dialog in use is never replaced, a submission
 * already cleared never shows again, and one the user closed undecided only shows again when
 * `explicit`. Returns whether it is shown.
 */
async function reviewPending(projectId: string, explicit = false): Promise<boolean> {
  if (!canDetect(projectId)) return false
  const pending = await mapLinksRead(projectId).catch(() => null)
  if (!pending || !canDetect(projectId) || cleared.get(projectId) === pending.id) return false
  if (!explicit && deferred.get(projectId) === pending.id) return false
  const open = dialogOf(projectId)
  if (open && open.mode !== 'offer') return false
  deferred.delete(projectId)
  const links: FoundLink[] = pending.links.map((l) => ({ ...l, detector: 'agent' }))
  setDialog(projectId, { mode: 'review', projectId, links, pending })
  return true
}

/** Add the chosen links and forget the submission they came from. */
export async function acceptDependencies(projectId: string, chosen: FoundLink[]) {
  if (!canDetect(projectId) || dialogOf(projectId)?.mode !== 'review') return
  const added = appendLinks(projectId, chosen)
  message(
    projectId,
    added ? `Added ${added} dependenc${added === 1 ? 'y' : 'ies'}` : 'Nothing new to add',
    true,
  )
  await discardDependencies(projectId)
}

/**
 * Close the review, first forgetting the agent's submission unless a newer one replaced it, then
 * showing any newer one.
 */
export async function discardDependencies(projectId: string) {
  const dialog = dialogOf(projectId)
  if (dialog?.mode === 'review' && dialog.pending) {
    const { id } = dialog.pending
    // Reads still on their way must not bring it back.
    cleared.set(projectId, id)
    setBusy(projectId, true)
    try {
      await mapLinksClear(projectId, id)
      if (deferred.get(projectId) === id) deferred.delete(projectId)
    } catch (e) {
      // Still on disk: the menu can show it again.
      cleared.delete(projectId)
      deferred.set(projectId, id)
      message(projectId, String(e))
    } finally {
      setBusy(projectId, false)
    }
  }
  // Only the dialog this call handled; another may have replaced it meanwhile.
  if (dialogOf(projectId) === dialog) setDialog(projectId, null)
  // A newer submission arrived while this one was open.
  await reviewPending(projectId)
}

/**
 * After the first save of a map without links, scan manifests and offer what they name. The
 * project is busy meanwhile, so a manual scan waits; an unscanned offer opened meanwhile from a
 * menu receives the result.
 */
async function afterCreated(projectId: string) {
  const state = projectStateOf(projectId)
  const project = projectOf(projectId)
  if (
    !canDetect(projectId) ||
    !state ||
    !project ||
    !shouldOfferDetection(project, state.dependencyPromptDismissed)
  )
    return
  if (dialogOf(projectId) || isBusy(projectId)) return
  let found: FoundLink[] | null = null
  setBusy(projectId, true)
  try {
    found = await scan(projectId)
  } catch (e) {
    // Offer detection anyway, without claiming the manifests named nothing.
    message(projectId, `Couldn’t scan for dependencies: ${String(e)}`)
  } finally {
    setBusy(projectId, false)
  }
  if (!projectStateOf(projectId)) return
  // A review, or an offer that already knows the scan's result, stays.
  const open = dialogOf(projectId)
  if (open && (open.mode !== 'offer' || open.scanned)) return
  setDialog(
    projectId,
    found?.length
      ? { mode: 'review', projectId, links: found }
      : { mode: 'offer', projectId, scanned: !!found },
  )
}

/** Forget everything about projects no longer open. */
function forgetClosed(open: Record<string, unknown>) {
  for (const map of [deferred, cleared]) for (const id of map.keys()) if (!open[id]) map.delete(id)
  const { dialogs, busy } = useDependencies.getState()
  const closed = [...Object.keys(dialogs), ...Object.keys(busy)].filter((id) => !open[id])
  if (closed.length)
    useDependencies.setState({
      dialogs: Object.fromEntries(Object.entries(dialogs).filter(([id]) => open[id])),
      busy: Object.fromEntries(Object.entries(busy).filter(([id]) => open[id])),
    })
}

let stop: (() => void) | undefined
/** Main window: offer detection on first save and surface agent submissions. */
export function initializeDependencyDetection(): () => void {
  if (stop) return stop
  const unlisten = onMapLinks(({ projectId }) => void reviewPending(projectId))
  const unsubscribe = onMapCreated((id) => void afterCreated(id))
  // A submission made while the app was closed waits for its project's tab, once the backend has
  // the project open: never while restoring or while its folder is unavailable. Only project and
  // restore changes are looked at.
  const checked = new Set<string>()
  const opened = useStore.subscribe((s, prev) => {
    if (s.projects === prev.projects && s.restoring === prev.restoring) return
    for (const id of checked)
      if (!s.projects[id] || dependencyMapBlocked(s.projects[id])) checked.delete(id)
    forgetClosed(s.projects)
    if (s.restoring) return
    for (const [id, entry] of Object.entries(s.projects))
      if (!dependencyMapBlocked(entry) && !checked.has(id)) {
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
