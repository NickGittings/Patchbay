import { useShallow } from 'zustand/react/shallow'
import { useReactFlow } from '@xyflow/react'
import { useStore } from '../store'
import {
  closeProjectTab,
  saveCurrentProject,
  useAddFolder,
  useOpenProject,
  useRescanProject,
} from './project'
import { configureEditor, showFileSearch } from './navigation'
import { mapEditsBlocked } from './mapSave'
import { offerDependencies } from './dependencies'
import { arrangeNow } from './arrange'
import { railViews, selectPanel, selectRailView, useRail } from './rail'

export interface WorkspaceAction {
  id: string
  title: string
  group: 'project' | 'settings' | 'workspace'
  enabled: boolean
  run: () => unknown
}
export function useWorkspaceActions(): WorkspaceAction[] {
  const s = useStore(
    useShallow((state) => ({
      project: state.project,
      simpleMode: state.simpleMode,
      view: state.view,
      nodeCount: state.nodes.length,
      entry: state.projects[state.activeProjectId ?? ''],
    })),
  )
  const open = useOpenProject()
  const rescan = useRescanProject()
  const add = useAddFolder()
  const flow = useReactFlow()
  const entry = s.entry
  const available = !!s.project && !entry?.unavailable
  const editable = available && !mapEditsBlocked(entry)
  const setting = (settings: string) => () => useRail.setState({ settings })
  return [
    { id: 'open', title: 'Open folder…', group: 'project', enabled: true, run: open },
    {
      id: 'save',
      title:
        entry?.fingerprint === 'absent' ? 'Create map configuration' : 'Save map configuration now',
      group: 'project',
      // Saving again mid-write waits for it, then flushes newer edits.
      enabled: editable,
      run: saveCurrentProject,
    },
    { id: 'rescan', title: 'Rescan project', group: 'project', enabled: available, run: rescan },
    {
      id: 'detect-dependencies',
      title: 'Detect dependencies…',
      group: 'project',
      enabled: editable,
      run: () => {
        if (s.project) offerDependencies(s.project.id)
      },
    },
    {
      id: 'arrange-map',
      title: 'Arrange map',
      group: 'project',
      enabled: editable && s.nodeCount > 1,
      run: () => {
        if (s.project) arrangeNow(s.project.id)
      },
    },
    { id: 'add-folder', title: 'Add repo…', group: 'project', enabled: editable, run: add },
    {
      id: 'new-component',
      title: 'New component',
      group: 'project',
      enabled: editable && s.view === 'navigation' && !s.simpleMode,
      run: () =>
        useStore
          .getState()
          .addComponent(
            flow.screenToFlowPosition({ x: window.innerWidth / 2.5, y: window.innerHeight / 3 }),
          ),
    },
    {
      id: 'close',
      title: 'Close project',
      group: 'project',
      enabled: !!s.project,
      run: () => s.project && closeProjectTab(s.project.id),
    },
    {
      id: 'editor',
      title: 'Preferred editor…',
      group: 'settings',
      enabled: true,
      run: () => configureEditor(),
    },
    {
      id: 'extensions',
      title: 'Extensions',
      group: 'settings',
      enabled: true,
      run: () => useStore.getState().setExtensionsPanelOpen(true),
    },
    {
      id: 'integrations',
      title: 'Agent status integration',
      group: 'settings',
      enabled: true,
      run: setting('integrations'),
    },
    {
      id: 'roles',
      title: 'Agent roles',
      group: 'settings',
      enabled: available,
      run: setting('roles'),
    },
    {
      id: 'notifications',
      title: 'Notifications',
      group: 'settings',
      enabled: true,
      run: setting('notifications'),
    },
    {
      id: 'story-board',
      title: 'Toggle story board',
      group: 'workspace',
      enabled: available,
      run: () => useStore.getState().setStoryBoard(!useStore.getState().storyBoard),
    },
    { id: 'files', title: 'Search files…', group: 'workspace', enabled: true, run: showFileSearch },
    ...railViews.map((v): WorkspaceAction => ({
      id: v.id,
      title: `View: ${v.label}`,
      group: 'workspace',
      enabled: available,
      run: () => selectRailView(v.id),
    })),
    {
      id: 'chat',
      title: 'Toggle Chat mode',
      group: 'workspace',
      enabled: available,
      run: () => useStore.getState().setSimpleMode(!useStore.getState().simpleMode),
    },
    ...(['project', 'worktree', 'auto', 'activity', 'stack', 'sessions', 'usage'] as const).map(
      (panel): WorkspaceAction => ({
        id: `panel-${panel}`,
        title: `Open ${panel === 'auto' ? 'Auto mode' : panel} panel`,
        group: 'workspace',
        enabled: available || panel === 'project' || panel === 'sessions' || panel === 'usage',
        run: () => selectPanel(panel),
      }),
    ),
  ]
}
export function runWorkspaceAction(action: WorkspaceAction | undefined) {
  if (action?.enabled)
    void Promise.resolve()
      .then(action.run)
      .catch((e) => useStore.getState().setMessage(String(e)))
}
