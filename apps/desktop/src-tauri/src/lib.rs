//! Thin Tauri adapter over patchbay-core: commands in, terminal events out.

use patchbay_core::TerminalSpec;
use patchbay_core::access::{Access, AccessSnapshot, external_candidates};
use patchbay_core::actions::{ActionPlan, ActionReport, ActionRequest, GraphActions};
use patchbay_core::context::ContextSection;
use patchbay_core::devices::{self, DeviceManifest};
use patchbay_core::extensions::{self, Registry};
use patchbay_core::files::{self, DirEntry};
use patchbay_core::model;
use patchbay_core::policy::AllowAll;
use patchbay_core::pty::{PtyManager, Snapshot};
use patchbay_core::tasks::{self, Task, TaskDraft, TaskPatch};
use patchbay_core::{EventSink, Project, TerminalEvent, context, detect, git, watch};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(debug_assertions)]
mod smoke;

const TERMINAL_EVENT: &str = "patchbay://terminal";
/// Emitted with a window's label when it closes, so the others can pick a new active window.
const WINDOW_CLOSED_EVENT: &str = "patchbay://window-closed";
const FILE_ACCESS_EVENT: &str = "patchbay://file-access";
const GIT_DIRTY_EVENT: &str = "patchbay://git-dirty";

#[derive(Default)]
struct AppState {
    pty: Arc<PtyManager>,
    actions: Arc<GraphActions>,
    access: Arc<Access>,
    watcher: watch::GitWatcher,
    extensions: Arc<Extensions>,
    /// The active task's worktree, watched besides the open project's roots.
    task_root: Arc<Mutex<Option<PathBuf>>>,
}

/// The extension registry, read from disk on first use. Callers run on blocking
/// workers, so loading never stalls the main thread or app startup.
#[derive(Default)]
struct Extensions(RwLock<Option<Arc<Registry>>>);

impl Extensions {
    fn get(&self) -> Arc<Registry> {
        if let Some(registry) = &*self.0.read().unwrap_or_else(PoisonError::into_inner) {
            return registry.clone();
        }
        self.0
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert_with(|| Arc::new(Registry::load()))
            .clone()
    }

    fn set(&self, registry: Registry) -> Registry {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(registry.clone()));
        registry
    }

    fn set_enabled(&self, id: &str, enabled: bool) -> CmdResult<Registry> {
        let mut slot = self.0.write().unwrap_or_else(PoisonError::into_inner);
        let mut registry = slot
            .get_or_insert_with(|| Arc::new(Registry::load()))
            .as_ref()
            .clone();
        registry.set_enabled(id, enabled).map_err(err)?;
        *slot = Some(Arc::new(registry.clone()));
        Ok(registry)
    }
}

fn main_only(window: &WebviewWindow) -> CmdResult<()> {
    if window.label() != "main" {
        return Err("extensions are owned by the main window".into());
    }
    Ok(())
}

fn rewatch(app: &AppHandle) {
    let state = app.state::<AppState>();
    let access = state.access.clone();
    let task_root = state.task_root.clone();
    let handle = app.clone();
    state.watcher.update(
        move || {
            let mut roots = access.watch_roots();
            let task = task_root.lock().unwrap_or_else(PoisonError::into_inner);
            roots.extend(
                task.iter()
                    .filter(|r| !roots.contains(r))
                    .cloned()
                    .collect::<Vec<_>>(),
            );
            roots
        },
        move || {
            let _ = handle.emit_to("main", GIT_DIRTY_EVENT, ());
        },
    );
}

/// Ask whether the external folders a `patchbay.json` lists may be read. The
/// file may come from a cloned repo, so nothing outside it is trusted unasked.
fn confirm_external(window: &WebviewWindow, root: &Path, dirs: &[PathBuf]) -> bool {
    let list: Vec<String> = dirs
        .iter()
        .map(|d| format!("  {}", model::relative_path(root, d)))
        .collect();
    window
        .dialog()
        .message(format!(
            "This project's map includes folders outside it:\n\n{}\n\nAllow Patchbay to show \
             their files, run git and start terminals there? If not, those components \
             stay locked until you pick their folders with Browse… or Add repo….",
            list.join("\n")
        ))
        .title("Folders outside the project")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".into(),
            "Keep locked".into(),
        ))
        .parent(window)
        .blocking_show()
}

impl AppState {
    fn roots(&self) -> Vec<PathBuf> {
        self.access.roots()
    }

    fn resolve(&self, path: &str) -> CmdResult<PathBuf> {
        files::resolve(&self.roots(), Path::new(path)).map_err(err)
    }
}

/// Run the backend's folder picker, starting in `start`, as a sheet of the
/// window that asked so that window can't be edited while it is open.
fn pick_folder(
    window: &WebviewWindow,
    title: &str,
    start: Option<&Path>,
) -> CmdResult<Option<PathBuf>> {
    let mut dialog = window.dialog().file().set_parent(window).set_title(title);
    if let Some(start) = start {
        dialog = dialog.set_directory(start);
    }
    dialog
        .blocking_pick_folder()
        .map(|p| p.into_path().map_err(err))
        .transpose()
}

/// Must match `componentLabel` in `lib/windows.ts`.
fn component_window_label(component_id: &str) -> String {
    let hex: Vec<String> = component_id
        .chars()
        .map(|c| format!("{:x}", u32::from(c)))
        .collect();
    format!("component-{}", hex.join("-"))
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    /// The main window gets every session's events on `patchbay://terminal`. A pop-out
    /// only listens on `patchbay://terminal/<its label>`, so it never receives (or
    /// parses) output from other components.
    fn emit(&self, event: TerminalEvent) {
        if let Some((component_id, _)) = event.session_id().rsplit_once('/') {
            let label = component_window_label(component_id);
            if self.0.get_webview_window(&label).is_some() {
                let _ = self.0.emit(&format!("{TERMINAL_EVENT}/{label}"), &event);
            }
        }
        let _ = self.0.emit(TERMINAL_EVENT, event);
    }
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    project: Project,
    /// True when no `patchbay.json` existed and the map was auto-detected.
    detected: bool,
    /// Components whose folder is missing or outside the project and not allowed.
    locked: Vec<String>,
}

/// Open a project. If its `patchbay.json` lists folders outside it, the user
/// is asked (in a dialog run here, not in the webview) whether to allow them.
#[tauri::command]
async fn open_project(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Option<Opened>> {
    let access = state.access.clone();
    let extensions = state.extensions.clone();
    let task_root = state.task_root.clone();
    blocking(move || {
        let detectors = extensions.get().detectors();
        // Smoke tests may use only a root configured by the backend's environment.
        #[cfg(debug_assertions)]
        let preset = smoke::project_root();
        #[cfg(not(debug_assertions))]
        let preset: Option<PathBuf> = None;
        let picked = match preset {
            Some(root) => Some(root),
            None => pick_folder(&window, "Open project", None)?,
        };
        let Some(root) = picked else {
            return Ok(None);
        };
        let root = root.canonicalize().map_err(err)?;
        let (project, detected) = match Project::load(&root).map_err(err)? {
            Some(project) => (project, false),
            None => (detect::detect_with(&root, &detectors).map_err(err)?, true),
        };
        let candidates = external_candidates(&project, &root);
        let allowed = !candidates.is_empty() && confirm_external(&window, &root, &candidates);
        access.open(&project).map_err(err)?;
        *task_root.lock().unwrap_or_else(PoisonError::into_inner) = None;
        if allowed {
            for dir in candidates {
                access.grant(&dir).map_err(err)?;
            }
        }
        rewatch(&app);
        let snapshot = access.snapshot();
        let locked = project
            .components
            .iter()
            .filter(|c| snapshot.readable(&c.path).is_none())
            .map(|c| c.id.clone())
            .collect();
        Ok(Some(Opened {
            project,
            detected,
            locked,
        }))
    })
    .await
}

/// Components and links a rescan or an added folder put on the map, with their
/// final ids, for the webview to append to its (possibly since edited) map.
#[derive(Serialize)]
struct Added {
    components: Vec<model::Component>,
    links: Vec<model::Link>,
}

impl Added {
    /// What `project` gained beyond its first `components` and `links`
    /// (`merge_new` appends).
    fn since(project: Project, components: usize, links: usize) -> Self {
        Self {
            components: project.components.into_iter().skip(components).collect(),
            links: project.links.into_iter().skip(links).collect(),
        }
    }
}

/// Rescan the open root plus the external folders on the map the user allowed.
/// The webview's `sync_roots` picks up the new components' folders.
#[tauri::command]
async fn rescan_project(state: State<'_, AppState>, mut project: Project) -> CmdResult<Added> {
    let access = state.access.snapshot();
    let extensions = state.extensions.clone();
    blocking(move || {
        let detectors = extensions.get().detectors();
        access.trust(&mut project).map_err(err)?;
        let externals: Vec<_> = project
            .external_dirs()
            .into_iter()
            .filter(|d| access.is_granted(d))
            .collect();
        let (components, links) = (project.components.len(), project.links.len());
        detect::rescan_with(&mut project, &externals, &detectors).map_err(err)?;
        Ok(Added::since(project, components, links))
    })
    .await
}

/// Ask for a folder (a repo beside the project, or a subfolder detection
/// missed) and add its components. The picker runs here rather than in the
/// webview so only folders the user chose become readable. `None` if cancelled.
#[tauri::command]
async fn add_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<Option<Added>> {
    let access = state.access.clone();
    let extensions = state.extensions.clone();
    blocking(move || {
        let detectors = extensions.get().detectors();
        let root = access.snapshot().trust(&mut project).map_err(err)?;
        let Some(dir) = pick_folder(&window, "Add a repo or folder", root.parent())? else {
            return Ok(None);
        };
        let found = detect::detect_folder_with(&project, &dir, &detectors).map_err(err)?;
        let (components, links) = (project.components.len(), project.links.len());
        detect::merge_new(&mut project, found);
        access.grant(&dir).map_err(err)?;
        rewatch(&app);
        let _ = window.emit(FILE_ACCESS_EVENT, ());
        Ok(Some(Added::since(project, components, links)))
    })
    .await
}

/// Pick a component's folder (inside the project or beside it) and return it
/// relative to the root. `None` if cancelled.
#[tauri::command]
async fn pick_component_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let access = state.access.clone();
    blocking(move || {
        let root = access.snapshot().root().ok_or("No project is open")?;
        let Some(dir) = pick_folder(&window, "Component folder", Some(&root))? else {
            return Ok(None);
        };
        let dir = dir.canonicalize().map_err(err)?;
        access.grant(&dir).map_err(err)?;
        rewatch(&app);
        let _ = window.emit(FILE_ACCESS_EVENT, ());
        Ok(Some(model::relative_path(&root, &dir)))
    })
    .await
}

/// Narrow the readable folders to the component paths now on the map.
#[tauri::command]
async fn sync_roots(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> CmdResult<()> {
    let access = state.access.clone();
    blocking(move || {
        access.sync(paths);
        rewatch(&app);
        let _ = app.emit(FILE_ACCESS_EVENT, ());
        Ok(())
    })
    .await
}

/// Saves to the open project's root, whatever root the webview sent.
#[tauri::command]
fn save_project(state: State<AppState>, mut project: Project) -> CmdResult<String> {
    state.access.snapshot().trust(&mut project).map_err(err)?;
    project.save().map(|p| p.display().to_string()).map_err(err)
}

/// The briefing an agent terminal of this component would get.
#[tauri::command]
async fn component_context(
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
) -> CmdResult<String> {
    let access = state.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = state.roots();
    blocking(move || {
        let ids = std::slice::from_ref(&component_id);
        let project = access.restrict(project, ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), ids, roots)?;
        let sections = extensions.get().sections(
            &project,
            ids,
            &roots,
            with_task_section(section, extra_context),
        );
        Ok(context::component_context(
            &project,
            &component_id,
            &sections,
        ))
    })
    .await
}

/// The briefing a planner terminal over these components would get.
#[tauri::command]
async fn plan_context(
    state: State<'_, AppState>,
    project: Project,
    component_ids: Vec<String>,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
) -> CmdResult<String> {
    let access = state.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = state.roots();
    blocking(move || {
        let project = access.restrict(project, &component_ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), &component_ids, roots)?;
        let sections = extensions.get().sections(
            &project,
            &component_ids,
            &roots,
            with_task_section(section, extra_context),
        );
        Ok(context::plan_context(&project, &component_ids, &sections))
    })
    .await
}

#[tauri::command]
async fn plan_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    component_ids: Vec<String>,
    terminal: TerminalSpec,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
) -> CmdResult<String> {
    let access = state.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = state.roots();
    let pty = state.pty.clone();
    blocking(move || {
        let project = access.restrict(project, &component_ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), &component_ids, roots)?;
        let sections = extensions.get().sections(
            &project,
            &component_ids,
            &roots,
            with_task_section(section, extra_context),
        );
        let spec = context::plan_session_spec_for(
            &project,
            &component_ids,
            &terminal,
            task.as_deref(),
            &AllowAll,
            &sections,
        )
        .map_err(err)?;
        let id = spec.id.clone();
        pty.spawn(spec, Arc::new(TauriSink(app))).map_err(err)?;
        Ok(id)
    })
    .await
}

#[derive(Deserialize)]
struct ComponentPath {
    id: String,
    path: String,
}

/// `(id, canonical folder)` for the components whose folders the backend has
/// granted. The rest are left out, so the webview can't run git anywhere else
/// on disk.
fn readable_components(
    access: &AccessSnapshot,
    components: Vec<ComponentPath>,
) -> Vec<(String, PathBuf)> {
    components
        .into_iter()
        .filter_map(|c| Some((c.id, access.readable(&c.path)?)))
        .collect()
}

/// `project` (trusted and restricted) moved into `task`'s worktree when one is
/// given, with the readable roots there and the briefing section naming the
/// task. The task is looked up in the backend's store, so the webview only
/// names it.
fn for_task(
    project: Project,
    task: Option<&str>,
    required: &[String],
    roots: Vec<PathBuf>,
) -> CmdResult<(Project, Vec<PathBuf>, Option<context::ContextSection>)> {
    let Some(id) = task else {
        return Ok((project, roots, None));
    };
    let task = tasks::stored(Path::new(&project.root), id).map_err(err)?;
    let (moved, dropped) = tasks::project_in(&project, &task, required).map_err(err)?;
    let section = tasks::context_section(&moved, &task, &dropped);
    let roots = vec![PathBuf::from(&moved.root)];
    Ok((moved, roots, Some(section)))
}

/// Extension context with the task's section first.
fn with_task_section(
    section: Option<ContextSection>,
    extra: Option<Vec<ContextSection>>,
) -> Vec<ContextSection> {
    section
        .into_iter()
        .chain(extra.unwrap_or_default())
        .collect()
}

/// `root` and `components` in `task`'s worktree, or unchanged without a task.
fn components_in_task(
    root: PathBuf,
    components: Vec<(String, PathBuf)>,
    task: Option<&str>,
) -> CmdResult<(PathBuf, Vec<(String, PathBuf)>)> {
    let Some(id) = task else {
        return Ok((root, components));
    };
    let task = tasks::stored(&root, id).map_err(err)?;
    git::in_worktree(&root, components, Some(&task.worktree)).map_err(err)
}

/// Takes only ids and folders for event-driven status refreshes.
#[tauri::command]
async fn git_status(
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    task: Option<String>,
) -> CmdResult<git::GitStatus> {
    // Resolve folders on a copy so the lock isn't held for the filesystem calls.
    let access = state.access.snapshot();
    blocking(move || {
        let Some(root) = access.root() else {
            return Ok(git::GitStatus::default());
        };
        let components = readable_components(&access, components);
        let (root, components) = components_in_task(root, components, task.as_deref())?;
        Ok(git::status(&root, &components))
    })
    .await
}

/// One component's uncommitted changes. Takes every component on the map so
/// files are attributed exactly as `git_status` counts them.
#[tauri::command]
async fn git_changes(
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    component_id: String,
    task: Option<String>,
) -> CmdResult<Vec<git::ChangedFile>> {
    let access = state.access.snapshot();
    blocking(move || {
        let Some(root) = access.root() else {
            return Ok(Vec::new());
        };
        let components = readable_components(&access, components);
        let (root, components) = components_in_task(root, components, task.as_deref())?;
        Ok(git::component_changes(&root, &components, &component_id))
    })
    .await
}

/// The worktrees of the project root's repo, for review.
#[tauri::command]
async fn git_worktrees(state: State<'_, AppState>) -> CmdResult<Vec<git::Worktree>> {
    let access = state.access.snapshot();
    blocking(move || {
        Ok(access
            .root()
            .map(|r| git::worktrees(&r))
            .unwrap_or_default())
    })
    .await
}

/// The diff of one of a component's changed files, `path` (and a rename's
/// `old_path`) relative to the root, in `worktree` (one `git_worktrees`
/// listed) or the open one.
#[tauri::command]
async fn git_diff(
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    component_id: String,
    path: String,
    old_path: Option<String>,
    worktree: Option<String>,
) -> CmdResult<git::FileDiff> {
    let access = state.access.snapshot();
    blocking(move || {
        let root = access.root().ok_or("No project is open")?;
        let target = git::DiffTarget {
            component_id: &component_id,
            path: &path,
            old_path: old_path.as_deref(),
        };
        let components = readable_components(&access, components);
        git::diff(&root, components, worktree.as_deref(), target).map_err(err)
    })
    .await
}

/// Changes across the map, in `worktree` or the open one, plus the components
/// that depend on changed ones.
#[tauri::command]
async fn git_review(
    state: State<'_, AppState>,
    mut project: Project,
    worktree: Option<String>,
) -> CmdResult<git::Review> {
    let access = state.access.snapshot();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        let folders = project
            .components
            .iter()
            .map(|c| ComponentPath {
                id: c.id.clone(),
                path: c.path.clone(),
            })
            .collect();
        // Only folders readable in the open worktree are mapped into another.
        let components = readable_components(&access, folders);
        git::review(&project, components, worktree.as_deref()).map_err(err)
    })
    .await
}

/// The open project root, for task commands.
fn task_repo(state: &AppState) -> CmdResult<PathBuf> {
    state
        .access
        .snapshot()
        .root()
        .ok_or_else(|| "No project is open".to_string())
}

/// The tasks of the open project's repo.
#[tauri::command]
async fn task_list(state: State<'_, AppState>) -> CmdResult<Vec<Task>> {
    let root = task_repo(&state)?;
    blocking(move || tasks::list(&root).map_err(err)).await
}

/// Create a branch and worktree beside the repo, and a task for them.
#[tauri::command]
async fn task_create(state: State<'_, AppState>, draft: TaskDraft) -> CmdResult<Task> {
    let root = task_repo(&state)?;
    blocking(move || tasks::create(&root, draft).map_err(err)).await
}

/// Make a task of one of the repo's existing worktrees.
#[tauri::command]
async fn task_attach(
    state: State<'_, AppState>,
    worktree: String,
    title: Option<String>,
    components: Vec<String>,
) -> CmdResult<Task> {
    let root = task_repo(&state)?;
    blocking(move || tasks::attach(&root, &worktree, title, components).map_err(err)).await
}

#[tauri::command]
async fn task_update(state: State<'_, AppState>, id: String, patch: TaskPatch) -> CmdResult<Task> {
    let root = task_repo(&state)?;
    blocking(move || tasks::update(&root, &id, patch).map_err(err)).await
}

/// Fails with the reason a task's worktree can't be removed, so the webview can
/// ask before stopping its terminals.
#[tauri::command]
async fn task_check_removable(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let root = task_repo(&state)?;
    blocking(move || tasks::check_removable(&root, &id).map(|_| ()).map_err(err)).await
}

/// Forget a task and optionally remove its (clean) worktree; the branch stays.
#[tauri::command]
async fn task_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    delete_worktree: bool,
) -> CmdResult<()> {
    let root = task_repo(&state)?;
    let task_root = state.task_root.clone();
    blocking(move || {
        let worktree = tasks::list(&root)
            .map_err(err)?
            .into_iter()
            .find(|t| t.id == id)
            .map(|t| PathBuf::from(t.worktree));
        tasks::remove(&root, &id, delete_worktree).map_err(err)?;
        let mut active = task_root.lock().unwrap_or_else(PoisonError::into_inner);
        if active.is_some() && *active == worktree {
            *active = None;
            drop(active);
            rewatch(&app);
        }
        Ok(())
    })
    .await
}

/// Watch the worktree of the task the user switched to (none for the open one).
#[tauri::command]
async fn task_activate(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
) -> CmdResult<()> {
    let root = task_repo(&state)?;
    let task_root = state.task_root.clone();
    let access = state.access.clone();
    blocking(move || {
        let worktree = match id {
            Some(id) => {
                let task = tasks::find(&root, &id).map_err(err)?;
                (!task.current).then(|| PathBuf::from(task.worktree))
            }
            None => None,
        };
        let mut active = task_root.lock().unwrap_or_else(PoisonError::into_inner);
        // Another project may have opened meanwhile; its reset wins.
        if access.snapshot().root().as_ref() != Some(&root) {
            return Ok(());
        }
        if *active != worktree {
            *active = worktree;
            drop(active);
            rewatch(&app);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn list_devices(state: State<'_, AppState>) -> CmdResult<Vec<DeviceManifest>> {
    let extensions = state.extensions.clone();
    blocking(move || Ok(devices::load_devices(&extensions.get()))).await
}

#[tauri::command]
fn save_device(device: DeviceManifest) -> CmdResult<String> {
    devices::save_device(&device)
        .map(|p| p.display().to_string())
        .map_err(err)
}

#[tauri::command]
async fn terminal_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    terminal_id: String,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
) -> CmdResult<String> {
    let access = state.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = state.roots();
    let pty = state.pty.clone();
    blocking(move || {
        let ids = std::slice::from_ref(&component_id);
        let project = access.restrict(project, ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), ids, roots)?;
        let sections = extensions.get().sections(
            &project,
            ids,
            &roots,
            with_task_section(section, extra_context),
        );
        let spec = context::session_spec_for(
            &project,
            &component_id,
            &terminal_id,
            task.as_deref(),
            &AllowAll,
            &sections,
        )
        .map_err(err)?;
        let id = spec.id.clone();
        pty.spawn(spec, Arc::new(TauriSink(app))).map_err(err)?;
        Ok(id)
    })
    .await
}

#[tauri::command]
async fn graph_action_plan(
    state: State<'_, AppState>,
    mut project: Project,
    request: ActionRequest,
    task: Option<String>,
) -> CmdResult<ActionPlan> {
    let access = state.access.snapshot();
    let roots = state.roots();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        let (project, _, _) = for_task(project, task.as_deref(), &[], roots)?;
        ActionPlan::build(&project, request, task.as_deref()).map_err(err)
    })
    .await
}

#[tauri::command]
async fn graph_action_run(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    mut project: Project,
    request: ActionRequest,
    task: Option<String>,
) -> CmdResult<ActionReport> {
    main_only(&window)?;
    let access = state.access.snapshot();
    let roots = state.roots();
    let actions = state.actions.clone();
    let epoch = actions.epoch();
    let pty = state.pty.clone();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        // Compute affected scope before filtering access or moving into the
        // task's worktree, so locked consumers or ones outside the task's repo
        // produce an error instead of disappearing from validation.
        let plan = ActionPlan::build(&project, request, task.as_deref()).map_err(err)?;
        let ids = plan.component_ids();
        let project = access.restrict(project, &ids).map_err(err)?;
        let (project, _, _) = for_task(project, task.as_deref(), &ids, roots)?;
        actions
            .execute(&project, plan, epoch, &pty, Arc::new(TauriSink(app)))
            .map_err(err)
    })
    .await
}

#[tauri::command]
async fn graph_group_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    group_id: String,
    task: Option<String>,
) -> CmdResult<()> {
    main_only(&window)?;
    let actions = state.actions.clone();
    let epoch = actions.epoch();
    let pty = state.pty.clone();
    blocking(move || {
        actions
            .stop_group(&group_id, task.as_deref(), epoch, &pty)
            .map_err(err)
    })
    .await
}

/// Stop the running validation; it still reports the validators that ran.
#[tauri::command]
fn graph_validation_cancel(window: WebviewWindow, state: State<AppState>) -> CmdResult<bool> {
    main_only(&window)?;
    Ok(state.actions.cancel_validation())
}

#[tauri::command]
fn terminal_write(state: State<AppState>, session_id: String, data: String) -> CmdResult<()> {
    state.pty.write(&session_id, data.as_bytes()).map_err(err)
}

#[tauri::command]
fn terminal_resize(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state.pty.resize(&session_id, cols, rows).map_err(err)
}

#[tauri::command]
fn terminal_stop(state: State<AppState>, session_id: String) {
    state.pty.kill(&session_id);
}

/// A window showed the session to the user; every window hears the new status.
#[tauri::command]
fn terminal_seen(app: AppHandle, state: State<AppState>, session_id: String) {
    if let Some(event) = state.pty.mark_seen(&session_id) {
        TauriSink(app).emit(event);
    }
}

/// Async so copying and encoding a large backlog stays off the main thread.
#[tauri::command]
async fn terminal_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Option<Snapshot>> {
    Ok(state.pty.snapshot(&session_id))
}

/// Lists `path`, relative to the open project's root (`../…` for a sibling repo).
#[tauri::command]
async fn list_dir(state: State<'_, AppState>, path: String) -> CmdResult<Vec<DirEntry>> {
    files::list_dir(&state.roots(), Path::new(&path)).map_err(err)
}

/// Reveals `path`, relative to the open project's root, in the file manager.
#[tauri::command]
async fn reveal_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(state.resolve(&path)?).map_err(err)
}

/// Returns the generation floor: events at or below it belong to the old project.
/// Async because it waits for stubborn processes to die.
#[tauri::command]
async fn terminal_reset(state: State<'_, AppState>) -> CmdResult<u64> {
    let actions = state.actions.clone();
    let pty = state.pty.clone();
    blocking(move || Ok(actions.reset(&pty))).await
}

/// # Panics
/// Panics if the Tauri runtime fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = smoke::install(builder);
    builder
        .register_asynchronous_uri_scheme_protocol("patchbay-ext", extension_protocol)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => {
                let _ = window.app_handle().emit_to("main", GIT_DIRTY_EVENT, ());
            }
            WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                for (label, popout) in window.app_handle().webview_windows() {
                    if label.starts_with("component-") {
                        let _ = popout.close();
                    }
                }
            }
            WindowEvent::Destroyed => {
                let _ = window
                    .app_handle()
                    .emit(WINDOW_CLOSED_EVENT, window.label());
            }
            _ => {}
        })
        .manage(AppState::default())
        .invoke_handler(|invoke| {
            // Extension code runs in sandboxed, opaque-origin frames inside `main`.
            // The boundary is Tauri's per-launch invoke key: every IPC message
            // (custom protocol or postMessage, plugin commands included) must carry
            // it, and the init scripts holding it run in the top frame only, so
            // those frames can't invoke anything (smoke/extensions.js probes both
            // transports). This check is defense in depth for protocol requests,
            // whose Origin the browser sets; postMessage headers are caller-supplied.
            if invoke
                .message
                .headers()
                .get("origin")
                .is_some_and(|origin| origin == "null")
            {
                invoke.resolver.reject("opaque origins cannot invoke Tauri");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                open_project,
                rescan_project,
                add_folder,
                pick_component_folder,
                sync_roots,
                save_project,
                component_context,
                git_status,
                task_list,
                task_create,
                task_attach,
                task_update,
                task_remove,
                task_check_removable,
                task_activate,
                git_changes,
                git_diff,
                git_review,
                git_worktrees,
                plan_context,
                plan_start,
                list_devices,
                save_device,
                terminal_start,
                graph_action_plan,
                graph_action_run,
                graph_group_stop,
                graph_validation_cancel,
                terminal_write,
                terminal_resize,
                terminal_stop,
                terminal_seen,
                terminal_reset,
                terminal_snapshot,
                list_dir,
                reveal_path,
                list_extensions,
                set_extension_enabled,
                reload_extensions,
                install_extension,
                reveal_extensions_dir,
                command_run,
                extension_terminal_run,
                extension_storage_get,
                extension_storage_set,
                extension_file_read,
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building Patchbay")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<AppState>().watcher.stop();
                let state = app.state::<AppState>();
                state.actions.reset(&state.pty);
            }
        });
}

#[tauri::command]
async fn list_extensions(window: WebviewWindow, state: State<'_, AppState>) -> CmdResult<Registry> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || Ok(extensions.get().as_ref().clone())).await
}
#[tauri::command]
async fn set_extension_enabled(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> CmdResult<Registry> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || extensions.set_enabled(&id, enabled)).await
}
#[tauri::command]
async fn reload_extensions(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Registry> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || Ok(extensions.set(Registry::load()))).await
}
#[tauri::command]
async fn install_extension(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Option<Registry>> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || {
        let Some(source) = pick_folder(&window, "Install extension from folder", None)? else {
            return Ok(None);
        };
        let dir = extensions::user_extensions_dir().ok_or("no home directory")?;
        extensions::install(&source, &dir).map_err(err)?;
        Ok(Some(extensions.set(Registry::load())))
    })
    .await
}
#[tauri::command]
async fn reveal_extensions_dir(window: WebviewWindow) -> CmdResult<()> {
    main_only(&window)?;
    blocking(|| {
        let dir = extensions::user_extensions_dir().ok_or("no home directory")?;
        std::fs::create_dir_all(&dir).map_err(err)?;
        tauri_plugin_opener::open_path(dir, None::<&str>).map_err(err)
    })
    .await
}

/// Run a declarative (`run`) command as an ad-hoc terminal of the component.
#[tauri::command]
async fn command_run(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    command_id: String,
) -> CmdResult<String> {
    main_only(&window)?;
    launch_extension_terminal(app, &state, project, component_id, move |registry| {
        extensions::command_terminal(registry, &command_id).map_err(err)
    })
    .await
}

/// Spawn a terminal that isn't on the map, with the component's file context.
async fn launch_extension_terminal(
    app: AppHandle,
    state: &AppState,
    project: Project,
    component_id: String,
    terminal: impl FnOnce(&Registry) -> CmdResult<TerminalSpec> + Send + 'static,
) -> CmdResult<String> {
    let access = state.access.snapshot();
    let roots = state.roots();
    let extensions = state.extensions.clone();
    let pty = state.pty.clone();
    blocking(move || {
        let registry = extensions.get();
        let terminal = terminal(&registry)?;
        let project = access
            .restrict(project, std::slice::from_ref(&component_id))
            .map_err(err)?;
        let ids = std::slice::from_ref(&component_id);
        let sections = registry.sections(&project, ids, &roots, vec![]);
        let spec =
            context::extra_session_spec(project, &component_id, terminal, &AllowAll, &sections)
                .map_err(err)?;
        let id = spec.id.clone();
        pty.spawn(spec, Arc::new(TauriSink(app))).map_err(err)?;
        Ok(id)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionTerminalRequest {
    extension_id: String,
    component_id: String,
    command: String,
    /// Names the terminal, so repeating a run reuses its session.
    key: String,
}

/// An extension's `terminals.run`, which needs its `terminals` permission.
#[tauri::command]
async fn extension_terminal_run(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project: Project,
    request: ExtensionTerminalRequest,
) -> CmdResult<String> {
    main_only(&window)?;
    let ExtensionTerminalRequest {
        extension_id,
        component_id,
        command,
        key,
    } = request;
    launch_extension_terminal(app, &state, project, component_id, move |registry| {
        registry
            .allowed(&extension_id, Some("terminals"))
            .map_err(err)?;
        extensions::run_terminal(&extension_id, command, &key).map_err(err)
    })
    .await
}

#[tauri::command]
async fn extension_storage_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
    extension_id: String,
) -> CmdResult<serde_json::Value> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || {
        extensions.get().allowed(&extension_id, None).map_err(err)?;
        extensions::storage_get(&extension_id).map_err(err)
    })
    .await
}

#[tauri::command]
async fn extension_storage_set(
    window: WebviewWindow,
    state: State<'_, AppState>,
    extension_id: String,
    data: serde_json::Value,
) -> CmdResult<()> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || {
        extensions.get().allowed(&extension_id, None).map_err(err)?;
        extensions::storage_set(&extension_id, &data).map_err(err)
    })
    .await
}

#[tauri::command]
async fn extension_file_read(
    window: WebviewWindow,
    state: State<'_, AppState>,
    extension_id: String,
    path: String,
) -> CmdResult<String> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    let roots = state.roots();
    blocking(move || {
        extensions
            .get()
            .allowed(&extension_id, Some("files:read"))
            .map_err(err)?;
        extensions::read_file(&roots, Path::new(&path)).map_err(err)
    })
    .await
}

const EXTENSION_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' patchbay-ext: http://patchbay-ext.localhost https://patchbay-ext.localhost; style-src 'unsafe-inline'; img-src data:; connect-src patchbay-ext: http://patchbay-ext.localhost https://patchbay-ext.localhost; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// Serves extension hosts and their assets to the main window, on a blocking worker.
fn extension_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let main = ctx.webview_label() == "main";
    let extensions = ctx.app_handle().state::<AppState>().extensions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (status, body, mime) = match extension_asset(main, &extensions, &request) {
            Ok((body, mime)) => (200, body, mime),
            Err(e) => (403, e.into_bytes(), "text/plain"),
        };
        let response = tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "null")
            .header("X-Content-Type-Options", "nosniff")
            .header("Content-Security-Policy", EXTENSION_CSP)
            .body(body);
        if let Ok(response) = response {
            responder.respond(response);
        }
    });
}

fn extension_asset(
    main: bool,
    extensions: &Extensions,
    request: &tauri::http::Request<Vec<u8>>,
) -> CmdResult<(Vec<u8>, &'static str)> {
    if !main || request.method() != tauri::http::Method::GET {
        return Err("extension assets are main-window only".into());
    }
    let path = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8()
        .map_err(err)?;
    let host = request.uri().host().unwrap_or_default();
    let (id, path) = extensions::asset_request(host, &path).ok_or("missing extension path")?;
    let registry = extensions.get();
    let extension = registry.allowed(id, None).map_err(err)?;
    if path != "__bootstrap.html" {
        return extensions::read_asset(&extension.dir, path).map_err(err);
    }
    let main = extension
        .manifest
        .main
        .as_ref()
        .ok_or("extension has no main")?;
    let main = serde_json::to_string(&format!("./{main}")).map_err(err)?;
    let bootstrap = include_str!("../../src/extensions/bootstrap.js");
    let html = format!(
        "<!doctype html><meta charset=utf-8><script>{bootstrap}</script><script type=module>try {{ const m = await import({main}); window.__patchbayDeactivate = m.deactivate; await m.activate?.(patchbay); parent.postMessage({{patchbay:1,method:'ready'}}, '*') }} catch(e) {{ parent.postMessage({{patchbay:1,method:'failed',error:String(e)}}, '*') }}</script>"
    );
    Ok((html.into_bytes(), "text/html"))
}
