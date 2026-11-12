import RailIcon from './RailIcon'
import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { ensureMainWorktree, useMainWorktree } from '../lib/mainWorktree'
import { closePanel, togglePanel } from '../lib/rail'
import WorkspacePopover from './WorkspacePopover'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'

/** Persistent context with project and worktree popovers above the footer. */
export default function WorkspaceContext({ actions }: { actions: WorkspaceAction[] }) {
  const project = useStore((s) => s.project)
  const hasProjects = useStore((s) => s.projectOrder.length > 0)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.activeTask))
  const panel = useStore((s) => s.utilityPanel)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const main = useMainWorktree((s) => s[project?.id ?? ''])
  useEffect(() => ensureMainWorktree(project?.id), [project?.id])
  const root = useRef<HTMLElement>(null)
  const open = panel === 'project' || (panel === 'worktree' && project) ? panel : null
  const close = () => {
    if (!open) return
    closePanel(open)
    root.current
      ?.querySelector<HTMLButtonElement>(
        `[aria-label="${open === 'project' ? 'Project' : 'Worktree'}"]`,
      )
      ?.focus()
  }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Element
      // Worktree action menus render in a portal outside the footer.
      if (!root.current?.contains(target) && !target.closest('.menu-list')) closePanel(open)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const popup = open && <WorkspacePopover panel={open} actions={actions} onClose={close} />
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && open && !event.defaultPrevented) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  if (!project) {
    const openAction = actions.find((a) => a.id === 'open')
    return (
      <nav
        className="workspace-context"
        aria-label="Workspace context"
        ref={root}
        onKeyDown={onKeyDown}
      >
        {hasProjects ? (
          <button
            className="workspace-context-project"
            aria-label="Project"
            aria-expanded={open === 'project'}
            aria-controls="workspace-project-popover"
            aria-haspopup="dialog"
            onClick={() => togglePanel('project')}
          >
            Projects
            <span className="workspace-context-caret" aria-hidden="true">
              ▾
            </span>
          </button>
        ) : (
          <button
            aria-label="Project"
            disabled={!openAction?.enabled}
            onClick={() => openAction && runWorkspaceAction(openAction)}
          >
            Open project…
          </button>
        )}
        {popup}
      </nav>
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
    <nav
      className="workspace-context"
      aria-label="Workspace context"
      ref={root}
      onKeyDown={onKeyDown}
    >
      <button
        className="workspace-context-project"
        aria-label="Project"
        aria-description={`${project.name}, ${project.root}${warning ? `, ${status}` : ''}`}
        aria-expanded={open === 'project'}
        aria-controls="workspace-project-popover"
        aria-haspopup="dialog"
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
        aria-expanded={open === 'worktree'}
        aria-controls="workspace-worktree-popover"
        aria-haspopup="dialog"
        title={`${project.name} / ${name}\n${task?.worktree ?? project.root}${branch ? `\nBranch: ${branch}` : ''}`}
        onClick={() => togglePanel('worktree')}
      >
        <span className="workspace-context-name">{name}</span>
        {branch && (
          <span className="workspace-context-branch" title={`Branch: ${branch}`}>
            <RailIcon name="branch" />
            <span>{branch}</span>
          </span>
        )}
        <span className="workspace-context-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {popup}
    </nav>
  )
}
