import { useState } from 'react'
import { useStore } from '../store'
import { roleTerminal } from '../lib/agentRoles'
import { planTerminals } from '../lib/plan'
import {
  acceptDependencies,
  appendLinks,
  closeDependencies,
  discardDependencies,
  dependencyMapBlocked,
  dismissDependencies,
  newLinks,
  scanDependencies,
  startDependencyAgent,
  unlinked,
  useDependencies,
  type DependencyDialog as Dialog,
  type FoundLink,
} from '../lib/dependencies'

/**
 * Offers dependency detection for the active project, and reviews what it found. Other projects'
 * dialogs wait for their tab.
 */
export default function DependencyDialog() {
  const projectId = useStore((s) => s.project?.id)
  const dialog = useDependencies((s) => (projectId ? s.dialogs[projectId] : undefined))
  if (!dialog) return null
  return dialog.mode === 'offer' ? (
    <Offer dialog={dialog} />
  ) : (
    <Review key={`${dialog.projectId}\n${dialog.pending?.id ?? 'manifests'}`} dialog={dialog} />
  )
}

const useBlocked = (projectId: string) =>
  useStore((s) => dependencyMapBlocked(s.projects[projectId]))

const useBusy = (projectId: string) => useDependencies((s) => !!s.busy[projectId])

function Shell({
  projectId,
  title,
  close,
  children,
}: {
  projectId: string
  title: string
  close: () => void
  children: React.ReactNode
}) {
  const busy = useBusy(projectId)
  return (
    <div className="maintenance-backdrop" onClick={() => !busy && close()}>
      <section
        className="map-maintenance-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) close()
        }}
      >
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  )
}

/** Start the detection agent with a chosen preset, defaulting to the planner's role. */
function AgentLauncher({
  projectId,
  label,
  before,
}: {
  projectId: string
  label: string
  /** Runs first, such as adding the dependencies already chosen. */
  before?: () => void
}) {
  const devices = useStore((s) => s.devices)
  const roles = useStore((s) => s.agentRoles)
  const connected = useStore((s) => s.serviceConnected)
  const busy = useBusy(projectId)
  const blocked = useBlocked(projectId)
  const presets = planTerminals(devices)
  const [picked, setPicked] = useState<string>()
  const preset = presets.find((t) => t.id === picked) ?? roleTerminal(devices, roles, 'plan')
  if (!presets.length)
    return <p className="hint flush">Add an agent preset to detect with an agent.</p>
  return (
    <div className="row">
      <select
        aria-label="Agent"
        value={preset?.id}
        disabled={busy || blocked}
        onChange={(e) => setPicked(e.target.value)}
      >
        {presets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <button
        disabled={busy || blocked || !preset || !connected}
        title={connected ? undefined : 'Reconnect before starting an agent'}
        onClick={() => {
          if (!preset) return
          before?.()
          startDependencyAgent(projectId, preset).catch((e) =>
            useStore.getState().setMessage(String(e)),
          )
        }}
      >
        {label}
      </button>
    </div>
  )
}

function Offer({ dialog }: { dialog: Extract<Dialog, { mode: 'offer' }> }) {
  const busy = useBusy(dialog.projectId)
  const blocked = useBlocked(dialog.projectId)
  const close = () => closeDependencies(dialog.projectId)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const alone = unlinked({ components: nodes, links: edges }).length
  return (
    <Shell projectId={dialog.projectId} title="Detect dependencies" close={close}>
      <p className="hint flush">
        {dialog.scanned &&
          (alone === nodes.length
            ? `The project’s manifests name no dependencies between these ${nodes.length} components. `
            : `${alone} of ${nodes.length} components have no dependencies the project’s manifests name. `)}
        Dependencies show which components may be affected by a change and which ones agents work
        alongside. Patchbay can scan manifests for folder and package references, or an agent can
        read the code for API calls, shared databases and other links. You review every dependency
        before it is added to the map.
      </p>
      <AgentLauncher projectId={dialog.projectId} label="Detect with an agent" />
      <div className="row">
        {!dialog.scanned && (
          <button
            disabled={busy || blocked}
            onClick={() => void scanDependencies(dialog.projectId)}
          >
            {busy ? 'Scanning…' : 'Scan manifests'}
          </button>
        )}
        {dialog.scanned ? (
          <button disabled={busy} onClick={() => dismissDependencies(dialog.projectId)}>
            Not now
          </button>
        ) : (
          <button disabled={busy} onClick={close}>
            Cancel
          </button>
        )}
      </div>
    </Shell>
  )
}

const key = (l: FoundLink) => `${l.source}\n${l.target}`

function Review({ dialog }: { dialog: Extract<Dialog, { mode: 'review' }> }) {
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const busy = useBusy(dialog.projectId)
  const blocked = useBlocked(dialog.projectId)
  // Re-checked against the map as it is now: an end may be gone or the pair linked meanwhile.
  const project = {
    components: nodes.map((n) => ({ id: n.id })),
    links: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
  const addable = new Set(newLinks(project, dialog.links).map((l) => `${l.source}\n${l.target}`))
  const [selected, setSelected] = useState(() => new Set(dialog.links.map(key)))
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  const chosen = dialog.links.filter((l) => selected.has(key(l)) && addable.has(key(l)))
  const agent = !!dialog.pending
  const skipped = dialog.pending?.skipped.length ?? 0
  return (
    <Shell
      projectId={dialog.projectId}
      title={agent ? 'Review proposed dependencies' : 'Review detected dependencies'}
      // Dismissing keeps an agent's proposal for later; only Discard forgets it.
      close={() => closeDependencies(dialog.projectId)}
    >
      <p className="hint flush">
        {agent
          ? 'The detection agent proposed these dependencies. '
          : 'The project’s manifests name these dependencies. '}
        “A → B” means A depends on B. Selected ones are added to the map, which saves automatically.
        {skipped > 0 && ` ${skipped} already on the map were left out.`}
      </p>
      {blocked && (
        <p className="hint file-tree-error" role="alert">
          Resolve the map conflict or project recovery before adding dependencies. The proposal
          stays available for review.
        </p>
      )}
      <div className="maintenance-proposals">
        {dialog.links.map((link) => {
          const k = key(link)
          const ok = addable.has(k)
          return (
            <label className="maintenance-proposal" key={k}>
              <input
                type="checkbox"
                checked={ok && selected.has(k)}
                disabled={busy || blocked || !ok}
                onChange={(e) =>
                  setSelected((s) => {
                    const next = new Set(s)
                    if (e.target.checked) next.add(k)
                    else next.delete(k)
                    return next
                  })
                }
              />
              <span>
                <strong>
                  {name(link.source)} → {name(link.target)}
                </strong>
                {link.label && ` (${link.label})`}
                {!ok && ' — no longer applies to the map'}
                {link.reason && <span className="hint flush"> — {link.reason}</span>}
              </span>
            </label>
          )
        })}
      </div>
      {!agent && (
        <>
          <p className="hint flush">
            Manifests only show code and folder references. An agent can also find API calls and
            other runtime dependencies.
          </p>
          <AgentLauncher
            projectId={dialog.projectId}
            label={chosen.length ? 'Add selected and detect with an agent' : 'Detect with an agent'}
            before={() => appendLinks(dialog.projectId, chosen)}
          />
        </>
      )}
      <div className="row">
        <button disabled={busy} onClick={() => void discardDependencies(dialog.projectId)}>
          {agent ? 'Discard' : 'Cancel'}
        </button>
        <button
          className="primary"
          disabled={busy || blocked || !chosen.length}
          onClick={() => void acceptDependencies(dialog.projectId, chosen)}
        >
          Add selected
        </button>
      </div>
    </Shell>
  )
}
