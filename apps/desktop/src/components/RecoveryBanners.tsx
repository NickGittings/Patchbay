import { useStore } from '../store'
import { acceptOpened, restoredLayout } from '../lib/workspace'
import { projectRelink } from '../lib/ipc'
import { reloadSavedMap } from '../lib/mapSave'
import { closeProjectTab } from '../lib/project'

/** Recovery banners for the active project: a missing folder or a changed saved map. */
export default function RecoveryBanners() {
  const active = useStore((s) => s.projects[s.activeProjectId ?? ''])
  return (
    <>
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
                    useStore.getState().closeProject(active.id)
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
                .catch((e) => useStore.getState().setMessage(String(e)))
            }
          >
            Locate folder
          </button>
          <button onClick={() => void closeProjectTab(active.id)}>Remove</button>
        </div>
      )}
      {active?.conflict && !active.unavailable && (
        <div className="recovery-banner" role="alert">
          <span>The saved map changed while Patchbay was closed. Choose which map to recover.</span>
          <button
            onClick={() => {
              useStore
                .getState()
                .syncProject({ ...active.conflict!, root: active.root, projectId: active.id })
              useStore.setState({
                dirty: true,
                projects: {
                  ...useStore.getState().projects,
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
