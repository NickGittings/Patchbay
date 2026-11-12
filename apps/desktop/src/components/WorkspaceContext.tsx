import { useEffect } from 'react'
import { useStore } from '../store'
import { ensureMainWorktree, useMainWorktree } from '../lib/mainWorktree'
import { togglePanel } from '../lib/rail'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'

/** Persistent context and entry points for the project and worktree panels. */
export default function WorkspaceContext({ actions }: { actions: WorkspaceAction[] }) {
  const project = useStore((s) => s.project)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.activeTask))
  const panel = useStore((s) => s.utilityPanel)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const main = useMainWorktree((s) => s[project?.id ?? ''])
  useEffect(() => ensureMainWorktree(project?.id), [project?.id])

  if (!project) {
    const open = actions.find((a) => a.id === 'open')
    return (
      <div className="workspace-context">
        <button
          aria-label="Project"
          disabled={!open?.enabled}
          onClick={() => open && runWorkspaceAction(open)}
        >
          Open project…
        </button>
      </div>
    )
  }

  const name = task?.title ?? 'Main worktree'
  const branch = task ? task.branch : main?.branch
  const warning =
    entry?.fingerprint === 'absent' ||
    entry?.unavailable ||
    entry?.conflict ||
    ['error', 'conflict'].includes(entry?.mapSave?.status ?? '')
  const status = entry?.mapSave?.status === 'error' ? 'Map save failed' : 'Map needs attention'
  return (
    <nav className="workspace-context" aria-label="Workspace context">
      <button
        className="workspace-context-project"
        aria-label="Project"
        aria-description={`${project.name}, ${project.root}${warning ? `, ${status}` : ''}`}
        aria-expanded={panel === 'project'}
        title={`${project.name}\n${project.root}${warning ? `\n${status}` : ''}`}
        onClick={() => togglePanel('project')}
      >
        <span className="workspace-context-name">{project.name}</span>
        {warning && <sup aria-label={status}>!</sup>}
        <span className="workspace-context-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <span className="workspace-context-separator" aria-hidden="true">
        /
      </span>
      <button
        className="workspace-context-worktree"
        aria-label="Worktree"
        aria-description={`${name}${branch ? `, branch ${branch}` : ''}`}
        aria-expanded={panel === 'worktree'}
        title={`${project.name} / ${name}\n${task?.worktree ?? project.root}${branch ? `\nBranch: ${branch}` : ''}`}
        onClick={() => togglePanel('worktree')}
      >
        <span className="workspace-context-name">{name}</span>
        <span className="workspace-context-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    </nav>
  )
}
