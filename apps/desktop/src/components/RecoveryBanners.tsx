import { useStore } from '../store'
import { acceptOpened, restoredLayout } from '../lib/workspace'
import { projectRelink } from '../lib/ipc'
import { reloadSavedMap } from '../lib/mapSave'
import { closeProjectTab } from '../lib/project'
import { forgetMainWorktree, refreshMainWorktree } from '../lib/mainWorktree'

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
                    forgetMainWorktree(active.id)
                    acceptOpened(opened)
                    refreshMainWorktree(opened.id)
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
              // Read the entry now: syncing and other updates since render must not be undone.
              useStore.setState((state) => {
                const current = state.projects[active.id]
                if (!current) return { dirty: true }
                return {
                  dirty: true,
                  projects: {
                    ...state.projects,
                    [active.id]: { ...current, conflict: undefined, draftFingerprint: undefined },
                  },
                }
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
