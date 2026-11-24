import { useEffect, useRef, useState } from 'react'
import {
  INTERRUPTED_SESSION_DETAIL,
  paneAutoStarts,
  serviceBlock,
  sessionRun,
  terminalStatus,
} from '../lib/display'
import { terminalSeen, terminalAttach, terminalDetach } from '../lib/ipc'
import {
  RECONNECTED_EVENT,
  finishForgettingSession,
  hydrateSession,
  releaseTerminal,
  startTerminal,
} from '../lib/sessions'
import {
  attach,
  detachHost,
  fit,
  hostVisible,
  ownsTerminalHost,
  scheduleFit,
  setOnScreen,
} from '../lib/terminals'
import { ACTIVE_CHANGED_EVENT } from '../lib/windows'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'

/**
 * Shared xterm host with snapshot replay, sizing and first-use shell startup. Shows the session of
 * `task` (by default the active task; `null` for the open worktree, as extension terminals are).
 */
export default function TerminalPane({
  componentId,
  terminal,
  focus = true,
  task: taskProp,
  existingSessionId,
  release = false,
}: {
  componentId: string
  terminal: TerminalSpec
  focus?: boolean
  /** The task whose worktree it runs in; defaults to the active task (`null`: the project's). */
  task?: string | null
  /** Show this exact session (e.g. from the Sessions panel) instead of deriving its id. */
  existingSessionId?: string
  /** Dispose the xterm on unmount when no other pane shows it, as a Sessions preview does. */
  release?: boolean
}) {
  const activeTask = useStore((s) => s.activeTask)
  const task = taskProp === undefined ? activeTask : taskProp
  const sid = existingSessionId ?? sessionId(componentId, terminal.id, task)
  const connected = useStore((s) => s.serviceConnected)
  const blocked = useStore(serviceBlock)
  const session = useStore((s) => s.sessions[sid])
  const status = terminalStatus(terminal.kind, session)
  const unseen = status.unseenSince
  const autoStarts = paneAutoStarts(componentId, terminal)
  const overlayCommand = terminal.kind !== 'agent' ? terminal.command : undefined
  const hostRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  // Dismissal lasts for one run; a restart shows its own notice again.
  const noticeRun = sessionRun(sid, session)
  const [dismissed, setDismissed] = useState<string>()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    attach(sid, host, { focus })
    // Becoming visible or active (re)claims the PTY and repaints; resizing only refits, once the
    // size settles, so a drag doesn't signal the program every frame.
    let onScreen = false
    let requestedOutput = false
    const refit = () => {
      attach(sid, host, { focus: false, repaint: true })
      setOnScreen(sid, host, onScreen)
      if (ownsTerminalHost(sid, host) && document.visibilityState === 'visible')
        void terminalAttach(sid, document.hasFocus())
          .then(() => fit(sid, { force: true }))
          .catch(() => {})
      else if (document.visibilityState !== 'visible') void terminalDetach(sid).catch(() => {})
      else if (!hostVisible(host)) detachHost(sid, host, { hidden: true })
      loadWhenVisible()
    }
    let wasVisible = hostVisible(host)
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        const visible = hostVisible(host)
        if (visible !== wasVisible) {
          wasVisible = visible
          refit()
          // IntersectionObserver doesn't report growing from zero size; re-observing does.
          intersection.unobserve(host)
          intersection.observe(host)
        } else scheduleFit(sid, host)
      })
    })
    const intersection = new IntersectionObserver((entries) => {
      onScreen = entries.at(-1)?.isIntersecting ?? false
      refit()
    })
    intersection.observe(host)
    observer.observe(host)
    // Fires when this or another window gains focus, which can move PTY sizing here.
    window.addEventListener(ACTIVE_CHANGED_EVENT, refit)
    document.addEventListener('visibilitychange', refit)
    // Hydration fails while the service is disconnected; reconnecting retries it. A hidden pane
    // hydrates state only, so auto-start still runs, and replays output once it is shown.
    let decided = false
    let checking = false
    const autoStart = (snapshot: unknown) => {
      if (decided) return
      decided = true
      if (
        !existingSessionId &&
        useStore.getState().serviceConnected &&
        !snapshot &&
        autoStarts &&
        !useStore.getState().sessions[sid]
      )
        void startTerminal(componentId, terminal.id, task)
    }
    const failed = (e: unknown) => {
      if (!disposed && useStore.getState().serviceConnected)
        useStore.getState().setMessage(String(e), undefined, undefined, 'error')
    }
    const load = () =>
      hydrateSession(sid, { terminal: true })
        .then((snapshot) => {
          if (disposed) return
          autoStart(snapshot)
          setReady(true)
          refit()
        })
        .catch((e) => {
          requestedOutput = false
          failed(e)
        })
    const loadWhenVisible = () => {
      if (requestedOutput || !hostVisible(host)) return
      requestedOutput = true
      void load()
    }
    const checkWhenHidden = () => {
      if (decided || checking || hostVisible(host)) return
      checking = true
      void hydrateSession(sid)
        .then((snapshot) => {
          if (!disposed) autoStart(snapshot)
        })
        .catch(failed)
        .finally(() => (checking = false))
    }
    const reconnected = () => {
      requestedOutput = false
      refit()
      checkWhenHidden()
    }
    window.addEventListener(RECONNECTED_EVENT, reconnected)
    loadWhenVisible()
    checkWhenHidden()
    return () => {
      disposed = true
      observer.disconnect()
      cancelAnimationFrame(resizeFrame)
      intersection.disconnect()
      if (!detachHost(sid, host)) void terminalDetach(sid).catch(() => {})
      window.removeEventListener(RECONNECTED_EVENT, reconnected)
      document.removeEventListener('visibilitychange', refit)
      window.removeEventListener(ACTIVE_CHANGED_EVENT, refit)
    }
  }, [sid, componentId, terminal.id, autoStarts, focus, existingSessionId, task])
  // Declared after the pane's effect so its cleanup has detached the host first. Only leaving
  // this session releases it, not a re-run for another input such as the active task.
  useEffect(
    () => () => {
      finishForgettingSession(sid)
      if (release) releaseTerminal(sid)
    },
    [sid, release],
  )

  // Showing a session in a focused window acknowledges it in every window. Panes stay mounted in
  // collapsed panels, hidden tabs and scrolled-away tiles, so only one on screen counts. An
  // IntersectionObserver doesn't report a pane growing from or shrinking to zero size (its ratio
  // stays the same), so size changes, focus and visibility re-observe it for a fresh entry.
  useEffect(() => {
    const host = hostRef.current
    if (unseen === undefined || !host) return
    const observer = new IntersectionObserver((entries) => {
      const { isIntersecting, intersectionRect } = entries[entries.length - 1]
      const { width, height } = host.getBoundingClientRect()
      const onScreen =
        isIntersecting &&
        intersectionRect.width > 0 &&
        intersectionRect.height > 0 &&
        width > 0 &&
        height > 0
      if (onScreen && document.visibilityState === 'visible' && document.hasFocus())
        terminalSeen(sid).catch(() => {})
    })
    const recheck = () => {
      observer.unobserve(host)
      observer.observe(host)
    }
    // Its first callback observes the host as well.
    const resizes = new ResizeObserver(recheck)
    resizes.observe(host)
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      resizes.disconnect()
      observer.disconnect()
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [sid, unseen])

  return (
    <div className="terminal-area">
      {!connected && (
        <div className="terminal-notice" role="status">
          {blocked === 'older'
            ? 'Disconnected · older Patchbay sessions are blocking the session service'
            : blocked === 'newer'
              ? 'Disconnected · a newer Patchbay version is running the session service'
              : 'Disconnected · reconnecting to session service…'}
        </div>
      )}
      {session?.interrupted && (
        <div className="terminal-notice" role="status">
          {INTERRUPTED_SESSION_DETAIL}
        </div>
      )}
      {session?.notice && dismissed !== noticeRun && (
        <div className="terminal-notice" role="status">
          <span>{session.notice}</span>
          <button
            title="Dismiss"
            aria-label="Dismiss terminal notice"
            onClick={() => setDismissed(noticeRun)}
          >
            ×
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
      {connected && ready && !session && !autoStarts && overlayCommand && (
        <div className="terminal-overlay">
          <code className="terminal-overlay-command" title={overlayCommand}>
            {overlayCommand}
          </code>
        </div>
      )}
    </div>
  )
}
