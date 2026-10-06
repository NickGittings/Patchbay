import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { ContextSection, Project } from '../types'

type Collector = (project: Project, ids: string[], caller?: string) => Promise<ContextSection[]>
const REQUEST_EVENT = 'patchbay://context-request'
const REPLY_EVENT = 'patchbay://context-reply'
/** Covers eager activation plus the providers' 2s budget, with room to spare. */
const BRIDGE_TIMEOUT = 15000
let collector: Collector | undefined
let next = 0

export function setContextCollector(fn: Collector | undefined) {
  collector = fn
}

/**
 * Extension sections for a briefing. Extension hosts run only in the main window,
 * so a pop-out asks it, and the same agent gets the same briefing everywhere.
 * `caller` is the extension starting the terminal, if any.
 */
export function extraContext(
  project: Project,
  ids: string[],
  caller?: string,
): Promise<ContextSection[]> {
  if (collector) return collector(project, ids, caller)
  const { label } = getCurrentWebviewWindow()
  return label === 'main' ? Promise.resolve([]) : askMain(label, project.projectId ?? '', ids)
}

function askMain(label: string, projectId: string, ids: string[]): Promise<ContextSection[]> {
  const id = `${label}:${++next}`
  return new Promise((resolve) => {
    let settled = false
    let unlisten: (() => void) | undefined
    const done = (sections: ContextSection[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unlisten?.()
      resolve(sections)
    }
    const timer = setTimeout(() => done([]), BRIDGE_TIMEOUT)
    listen<{ id: string; sections: ContextSection[] }>(REPLY_EVENT, (e) => {
      if (e.payload.id === id) done(e.payload.sections)
    })
      .then((stop) => {
        unlisten = stop
        if (settled) stop()
        else return emitTo('main', REQUEST_EVENT, { id, label, projectId, ids })
      })
      .catch(() => done([]))
  })
}

/** Main window: answer pop-outs' context requests with `collect`. Returns the unsubscribe. */
export function serveContextRequests(
  collect: (projectId: string, ids: string[]) => Promise<ContextSection[]>,
) {
  const stop = listen<{ id: string; label: string; projectId: string; ids: string[] }>(
    REQUEST_EVENT,
    (e) => {
      const { id, label, projectId, ids } = e.payload
      void collect(projectId, Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : [])
        .catch(() => [])
        .then((sections) => emitTo(label, REPLY_EVENT, { id, sections }))
        .catch(() => {})
    },
  )
  return () => void stop.then((unlisten) => unlisten())
}
