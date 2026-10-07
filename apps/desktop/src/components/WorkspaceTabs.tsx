import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import { closeComponentWindows } from '../lib/windows'
import { acceptOpened, flushWorkspace, restoredLayout } from '../lib/workspace'
import { projectRelink } from '../lib/ipc'
import { flushMapSaves, reloadSavedMap } from '../lib/mapSave'

export default function WorkspaceTabs() {
  const s = useStore()
  const active = s.projects[s.activeProjectId ?? '']
  const close = async (id: string) => {
    if (!(await flushMapSaves(id))) {
      await flushWorkspace()
      useStore
        .getState()
        .setMessage(
          'Map could not be saved. Retry or resolve the map conflict before closing this project.',
        )
      return
    }
    await closeComponentWindows(id)
    s.closeProject(id)
    await invoke('project_close', { projectId: id })
    await flushWorkspace()
  }
  return (
    <>
      <nav className="project-tabs" aria-label="Projects">
        {s.projectOrder.map((id) => {
          const entry = s.projects[id]
          const count = s.sessionRecords.filter(
            (r) => r.metadata.projectId === id && r.snapshot?.running,
          ).length
          return (
            <div
              className={s.activeProjectId === id ? 'project-tab active' : 'project-tab'}
              key={id}
            >
              <button
                role="tab"
                aria-selected={s.activeProjectId === id}
                onClick={() => s.activateProject(id)}
                title={entry.root}
              >
                {entry.name}
                {entry.unavailable ? ' · unavailable' : ''}
                {count ? ` · ${count} running` : ''}
              </button>
              <button aria-label={`Close ${entry.name}`} onClick={() => void close(id)}>
                ×
              </button>
            </div>
          )
        })}
        <span className="spacer" />
        <button onClick={() => useStore.setState({ sessionsPanelOpen: true })}>Sessions</button>
      </nav>
      {active?.unavailable && (
        <div className="recovery-banner" role="status">
          <span>
            {active.root}: {active.unavailable}
          </span>
          <button
            onClick={() =>
              void projectRelink(active.id)
                .then((opened) => {
                  if (opened) {
                    s.closeProject(active.id)
                    acceptOpened(opened)
                    useStore.setState(restoredLayout(active.unavailableLayout ?? {}))
                    if (active.conflict) {
                      const fingerprint = active.draftFingerprint ?? active.fingerprint
                      if (fingerprint === opened.fingerprint) {
                        useStore.getState().syncProject({
                          ...active.conflict,
                          root: opened.project.root,
                          projectId: opened.id,
                        })
                        useStore.setState({ dirty: true })
                      } else {
                        useStore.setState((state) => ({
                          projects: {
                            ...state.projects,
                            [opened.id]: {
                              ...state.projects[opened.id],
                              conflict: active.conflict,
                              draftFingerprint: fingerprint,
                            },
                          },
                        }))
                      }
                    }
                  }
                })
                .catch((e) => s.setMessage(String(e)))
            }
          >
            Locate folder…
          </button>
          <button onClick={() => void close(active.id)}>Remove</button>
        </div>
      )}
      {active?.conflict && !active.unavailable && (
        <div className="recovery-banner" role="alert">
          <span>The saved map changed while Patchbay was closed. Choose which map to recover.</span>
          <button
            onClick={() => {
              s.syncProject({ ...active.conflict!, root: active.root, projectId: active.id })
              useStore.setState({
                dirty: true,
                projects: {
                  ...s.projects,
                  [active.id]: { ...active, conflict: undefined, draftFingerprint: undefined },
                },
              })
            }}
          >
            Recover draft
          </button>
          <button onClick={() => void reloadSavedMap(active.id)}>Use saved map</button>
        </div>
      )}
    </>
  )
}
