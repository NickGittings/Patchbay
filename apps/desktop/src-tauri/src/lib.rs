//! Thin Tauri adapter over patchbay-core: commands in, terminal events out.

use patchbay_core::TerminalSpec;
use patchbay_core::access::{Access, AccessSnapshot, external_candidates};
use patchbay_core::actions::{ActionPlan, ActionReport, ActionRequest};
use patchbay_core::context::ContextSection;
use patchbay_core::devices::{self, DeviceManifest};
use patchbay_core::extensions::{self, Registry};
use patchbay_core::files::{self, DirEntry};
use patchbay_core::model;
use patchbay_core::navigation::{
    self, EditorLauncher, EditorPreferences, EditorTarget, FileSearchResult,
};
use patchbay_core::policy::AllowAll;
use patchbay_core::pty::Snapshot;
use patchbay_core::session::{self, PreviewScan, Record, Request};
use patchbay_core::tasks::{self, Task, TaskDraft, TaskPatch};
use patchbay_core::workspace::{self, Workspace};
use std::collections::HashMap;
mod agent_commands;
mod layout;
mod service;
use patchbay_core::{Project, context, detect, git, maintenance, watch};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(debug_assertions)]
mod smoke;

/// Emitted with a window's label when it closes, so the others can pick a new active window.
const WINDOW_CLOSED_EVENT: &str = "patchbay://window-closed";
const FILE_ACCESS_EVENT: &str = "patchbay://file-access";
const GIT_DIRTY_EVENT: &str = "patchbay://git-dirty";

/// A component pop-out's window label. Must match `componentLabel` in `windows.ts`:
/// the code points of `JSON.stringify([projectId, componentId])` in hex.
pub(crate) fn component_window_label(project_id: &str, component_id: &str) -> String {
    let json = serde_json::to_string(&[project_id, component_id]).unwrap_or_default();
    let hex: Vec<String> = json
        .chars()
        .map(|c| format!("{:x}", u32::from(c)))
        .collect();
    format!("component-{}", hex.join("-"))
}

#[derive(Default)]
struct AppState {
    quitting: std::sync::atomic::AtomicBool,
    layout_dirty: std::sync::atomic::AtomicBool,
    service: Arc<service::Bridge>,
    agent_commands: Mutex<Option<Arc<patchbay_core::agent_bridge::Server>>>,
    activities: patchbay_core::agent_commands::ActivityLog,
    projects: RwLock<HashMap<String, Arc<ProjectAccess>>>,
    workspace: Mutex<Workspace>,
    workspace_ready: std::sync::atomic::AtomicBool,
    extensions: Arc<Extensions>,
}
#[derive(Default)]
struct ProjectAccess {
    agent_project: RwLock<Option<Project>>,
    maintenance: Mutex<Option<PendingPreview>>,
    access: Arc<Access>,
    watcher: watch::GitWatcher,
    /// The active task's worktree, watched besides the project's roots.
    task_root: Arc<Mutex<Option<PathBuf>>>,
    /// Recent `navigation_roots` worktree mappings, which otherwise run `git worktree list`.
    worktree_roots: Mutex<Option<Cached<WorktreeKey, Vec<PathBuf>>>>,
    /// The last file search's candidates, reused while the user types.
    search_paths: Mutex<Option<Cached<SearchKey, Arc<Vec<PathBuf>>>>>,
}
/// Project root, worktree and the scanned folders mapped into it.
type WorktreeKey = (PathBuf, String, Vec<PathBuf>);
/// Allowed roots and scanned folders.
type SearchKey = (Vec<PathBuf>, Vec<PathBuf>);
/// A value computed for `key`, reused until it is `ttl` old.
struct Cached<K, V> {
    key: K,
    at: std::time::Instant,
    value: V,
}
impl<K: PartialEq, V: Clone> Cached<K, V> {
    fn get_or<E>(
        slot: &Mutex<Option<Self>>,
        key: K,
        ttl: std::time::Duration,
        compute: impl FnOnce(&K) -> Result<V, E>,
    ) -> Result<V, E> {
        let lock = || {
            slot.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        };
        if let Some(c) = lock().as_ref()
            && c.key == key
            && c.at.elapsed() < ttl
        {
            return Ok(c.value.clone());
        }
        // Computed without the lock, so one slow enumeration doesn't block other calls.
        let value = compute(&key)?;
        *lock() = Some(Self {
            key,
            at: std::time::Instant::now(),
            value: value.clone(),
        });
        Ok(value)
    }
}
const WORKTREE_ROOTS_TTL: std::time::Duration = std::time::Duration::from_secs(10);
const SEARCH_PATHS_TTL: std::time::Duration = std::time::Duration::from_secs(3);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MapEdit {
    project: Project,
    lease: Option<String>,
}

#[derive(Clone)]
struct PendingPreview {
    draft: String,
    detectors: String,
    preview: maintenance::ReconciliationPreview,
}
impl PendingPreview {
    fn check(
        &self,
        project: &Project,
        access: &AccessSnapshot,
        detectors: &[extensions::DetectorContribution],
    ) -> CmdResult<()> {
        if self.draft != serde_json::to_string(project).map_err(err)?
            || self.preview.access_revision != access.revision()
            || self.detectors != serde_json::to_string(detectors).map_err(err)?
        {
            return Err("The draft or folder access changed; refresh the preview".into());
        }
        Ok(())
    }
}
/// The pending preview; a panic elsewhere can't poison it, since it is only ever replaced whole.
fn pending_preview(scoped: &ProjectAccess) -> std::sync::MutexGuard<'_, Option<PendingPreview>> {
    scoped
        .maintenance
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
static PREVIEW_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl AppState {
    fn project(&self, id: &str) -> CmdResult<Arc<ProjectAccess>> {
        self.projects
            .read()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "Project unavailable; locate its folder first".into())
    }
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

fn rewatch(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let Ok(project) = state.project(id) else {
        return;
    };
    let access = project.access.clone();
    let task_root = project.task_root.clone();
    let handle = app.clone();
    let id = id.to_string();
    project.watcher.update(
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
            let _ = handle.emit_to("main", GIT_DIRTY_EVENT, &id);
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

impl ProjectAccess {
    fn roots(&self) -> Vec<PathBuf> {
        self.access.roots()
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

#[tauri::command]
async fn agent_hooks_check(
    window: WebviewWindow,
    state: State<'_, AppState>,
    provider: patchbay_core::adapters::Adapter,
    source_override: Option<PathBuf>,
) -> CmdResult<patchbay_core::agent_hooks::Integration> {
    main_only(&window)?;
    let bridge = state.service.clone();
    blocking(move || {
        let mut result = patchbay_core::agent_hooks::inspect(provider, source_override.as_deref())
            .map_err(err)?;
        result.reporting_sessions = bridge
            .list()
            .unwrap_or_default()
            .iter()
            .filter(|r| {
                r.snapshot.as_ref().is_some_and(|s| {
                    s.running
                        && s.status
                            .agent
                            .as_ref()
                            .is_some_and(|a| a.authoritative && a.provider == Some(provider))
                })
            })
            .count();
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn agent_hooks_configure(
    window: WebviewWindow,
    provider: patchbay_core::adapters::Adapter,
    source_override: Option<PathBuf>,
    install: bool,
) -> CmdResult<patchbay_core::agent_hooks::Integration> {
    main_only(&window)?;
    blocking(move || {
        patchbay_core::agent_hooks::configure(
            provider,
            source_override.as_deref(),
            &service::helper(),
            install,
        )
        .map_err(err)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    id: String,
    fingerprint: String,
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
    second: Option<bool>,
) -> CmdResult<Option<Opened>> {
    let extensions = state.extensions.clone();
    blocking(move || {
        let detectors = extensions.get().detectors();
        // Smoke tests may use only a root configured by the backend's environment.
        #[cfg(debug_assertions)]
        let preset = smoke::project_root(second.unwrap_or(false));
        #[cfg(not(debug_assertions))]
        let preset: Option<PathBuf> = {
            let _ = second;
            None
        };
        let picked = match preset {
            Some(root) => Some(root),
            None => pick_folder(&window, "Open project", None)?,
        };
        let Some(root) = picked else {
            return Ok(None);
        };
        let loaded = workspace::load_project(&root, &detectors).map_err(err)?;
        let scoped = {
            let state = app.state::<AppState>();
            let mut projects = state.projects.write().unwrap();
            projects.entry(loaded.id.clone()).or_default().clone()
        };
        let access = scoped.access.clone();
        if access.snapshot().root().is_none() {
            access.open(&loaded.project).map_err(err)?;
        }
        // Ask about the external folders not yet allowed, also when the project
        // is already open: a restored workspace never carries grants over.
        let granted = access.snapshot();
        let candidates: Vec<_> = external_candidates(&loaded.project, &loaded.root)
            .into_iter()
            .filter(|d| !granted.is_granted(d))
            .collect();
        if !candidates.is_empty() && confirm_external(&window, &loaded.root, &candidates) {
            for dir in candidates {
                access.grant(&dir).map_err(err)?;
            }
            let _ = app.emit(FILE_ACCESS_EVENT, ());
        }
        *scoped.agent_project.write().unwrap() = Some(loaded.project.clone());
        rewatch(&app, &loaded.id);
        Ok(Some(to_opened(loaded, &access.snapshot())))
    })
    .await
}

fn to_opened(loaded: workspace::Loaded, access: &AccessSnapshot) -> Opened {
    let locked = loaded
        .project
        .components
        .iter()
        .filter(|c| access.readable(&c.path).is_none())
        .map(|c| c.id.clone())
        .collect();
    Opened {
        id: loaded.id,
        fingerprint: loaded.fingerprint,
        project: loaded.project,
        detected: loaded.detected,
        locked,
    }
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

/// Rescan proposes changes; only Apply selected changes the in-memory draft.
#[tauri::command]
async fn rescan_project(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<maintenance::ReconciliationPreview> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let extensions = state.extensions.clone();
    blocking(move || {
        let detectors = extensions.get().detectors();
        access.trust(&mut project).map_err(err)?;
        let mut preview = maintenance::preview(&project, &access, &detectors).map_err(err)?;
        preview.id = format!(
            "{}-{}",
            std::process::id(),
            PREVIEW_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        if scoped.access.snapshot().revision() != access.revision() {
            return Err("Folder access changed; refresh the preview".into());
        }
        *pending_preview(&scoped) = Some(PendingPreview {
            draft: serde_json::to_string(&project).map_err(err)?,
            detectors: serde_json::to_string(&detectors).map_err(err)?,
            preview: preview.clone(),
        });
        Ok(preview)
    })
    .await
}

#[tauri::command]
async fn map_issues(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<Vec<maintenance::MapIssue>> {
    let access = state.project(&project_id)?.access.snapshot();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        Ok(maintenance::issues(&project, &access))
    })
    .await
}

#[tauri::command]
async fn apply_reconciliation(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
    preview_id: String,
    selected: Vec<String>,
) -> CmdResult<MapEdit> {
    let scoped = state.project(&project_id)?;
    let bridge = state.service.clone();
    let extensions = state.extensions.clone();
    blocking(move || {
        let access = scoped.access.snapshot();
        access.trust(&mut project).map_err(err)?;
        // Not held across the service call below, which may block until its timeout.
        let pending = pending_preview(&scoped)
            .clone()
            .filter(|p| p.preview.id == preview_id)
            .ok_or("Preview expired; refresh it")?;
        pending.check(&project, &access, &extensions.get().detectors())?;
        let affected = maintenance::affected(&pending.preview, &selected);
        let draft = maintenance::apply(&project, &pending.preview, &selected).map_err(err)?;
        for id in &affected {
            if let Some(component) = draft.component(id)
                && access.readable(&component.path).is_none()
            {
                return Err(
                    "The repaired folder is unavailable or locked; refresh the preview".into(),
                );
            }
        }
        let lease = if affected.is_empty() {
            None
        } else {
            Some(bridge.call::<String>(Request::MaintenanceGuard {
                project_id: project_id.clone(),
                component_ids: affected,
            })?)
        };
        // A newer preview replaced this one while the work was checked.
        let replaced = pending_preview(&scoped)
            .as_ref()
            .is_none_or(|p| p.preview.id != preview_id);
        let recheck = if replaced {
            Err("Preview expired; refresh it".into())
        } else {
            pending.check(
                &project,
                &scoped.access.snapshot(),
                &extensions.get().detectors(),
            )
        };
        if let Err(error) = recheck {
            if let Some(token) = lease {
                let _ = bridge
                    .call::<serde_json::Value>(Request::MaintenanceRelease { project_id, token });
            }
            return Err(error);
        }
        Ok(MapEdit {
            project: draft,
            lease,
        })
    })
    .await
}

/// Direct path edits/deletes use the same stopped-work guard as reconciliation.
#[tauri::command]
async fn edit_map_components(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
    remove: Vec<String>,
    component_id: Option<String>,
    path: Option<String>,
) -> CmdResult<MapEdit> {
    let scoped = state.project(&project_id)?;
    let bridge = state.service.clone();
    blocking(move || {
        let access = scoped.access.snapshot();
        access.trust(&mut project).map_err(err)?;
        let moved = component_id.as_deref().zip(path.as_deref());
        let (draft, affected) =
            maintenance::edit(&project, &access, &remove, moved).map_err(err)?;
        let lease = if affected.is_empty() {
            None
        } else {
            Some(bridge.call::<String>(Request::MaintenanceGuard {
                project_id: project_id.clone(),
                component_ids: affected,
            })?)
        };
        if scoped.access.snapshot().revision() != access.revision() {
            if let Some(token) = lease {
                let _ = bridge
                    .call::<serde_json::Value>(Request::MaintenanceRelease { project_id, token });
            }
            return Err("Folder access changed; retry the edit".into());
        }
        Ok(MapEdit {
            project: draft,
            lease,
        })
    })
    .await
}

#[tauri::command]
async fn release_map_edit(
    project_id: String,
    state: State<'_, AppState>,
    token: String,
) -> CmdResult<()> {
    service(&state, Request::MaintenanceRelease { project_id, token }).await
}

/// Complete scope cleanup only after the frontend accepted the resulting draft.
#[tauri::command]
async fn cleanup_component_scopes(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
    removed: Vec<String>,
) -> CmdResult<()> {
    let access = state.project(&project_id)?.access.snapshot();
    blocking(move || {
        let root = access.trust(&mut project).map_err(err)?;
        if removed.iter().any(|id| project.component(id).is_some()) {
            return Err("A removed component is still present in the draft".into());
        }
        tasks::prune_components(&root, &removed).map_err(err)
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
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<Option<Added>> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.clone();
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
        rewatch(&app, &project_id);
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
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.clone();
    blocking(move || {
        let root = access.snapshot().root().ok_or("No project is open")?;
        let Some(dir) = pick_folder(&window, "Component folder", Some(&root))? else {
            return Ok(None);
        };
        let dir = dir.canonicalize().map_err(err)?;
        access.grant(&dir).map_err(err)?;
        rewatch(&app, &project_id);
        let _ = window.emit(FILE_ACCESS_EVENT, ());
        Ok(Some(model::relative_path(&root, &dir)))
    })
    .await
}

/// Narrow the readable folders to the component paths now on the map.
#[tauri::command]
async fn sync_roots(
    app: AppHandle,
    project_id: String,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> CmdResult<()> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.clone();
    blocking(move || {
        access.sync(paths);
        rewatch(&app, &project_id);
        let _ = app.emit(FILE_ACCESS_EVENT, ());
        Ok(())
    })
    .await
}

/// Saves to the open project's root, whatever root the webview sent.
#[tauri::command]
fn save_project(
    project_id: String,
    state: State<AppState>,
    mut project: Project,
    expected_fingerprint: Option<String>,
) -> CmdResult<model::ProjectSave> {
    let scoped = state.project(&project_id)?;
    scoped.access.snapshot().trust(&mut project).map_err(err)?;
    project
        .save_checked(expected_fingerprint.as_deref())
        .map_err(err)
}

/// Reload the registered root without a folder picker or new access grants.
#[tauri::command]
fn reload_project(state: State<AppState>, project_id: String) -> CmdResult<Opened> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let root = access.root().ok_or("Project unavailable")?;
    let detectors = state.extensions.get().detectors();
    let loaded = workspace::load_project(&root, &detectors).map_err(err)?;
    Ok(to_opened(loaded, &access))
}

/// The briefing an agent terminal of this component would get.
#[tauri::command]
async fn component_context(
    project_id: String,
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
    peers: Option<Vec<String>>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = scoped.roots();
    blocking(move || {
        let ids = std::slice::from_ref(&component_id);
        let project = access.restrict(project, ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), ids, roots)?;
        let (handoff, _) = handoff_sections(&project, &component_id, task.as_deref(), peers);
        let sections = briefing_sections(
            &extensions.get(),
            &project,
            ids,
            &roots,
            section.into_iter().chain(handoff),
            extra_context,
        );
        Ok(context::component_context(
            &project,
            &component_id,
            &sections,
        ))
    })
    .await
}

/// The briefing a planner terminal over these components would get, in the project folder.
#[tauri::command]
async fn plan_context(
    project_id: String,
    state: State<'_, AppState>,
    project: Project,
    component_ids: Vec<String>,
    extra_context: Option<Vec<ContextSection>>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = scoped.roots();
    blocking(move || {
        let project = access.restrict(project, &component_ids).map_err(err)?;
        let sections = briefing_sections(
            &extensions.get(),
            &project,
            &component_ids,
            &roots,
            None,
            extra_context,
        );
        Ok(context::plan_context(&project, &component_ids, &sections))
    })
    .await
}

// Tauri commands take their IPC arguments individually.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn plan_start(
    request_id: String,
    project_id: String,
    state: State<'_, AppState>,
    project: Project,
    component_ids: Vec<String>,
    terminal: TerminalSpec,
    extra_context: Option<Vec<ContextSection>>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = scoped.roots();
    let bridge = state.service.clone();
    let agent_server = state.agent_commands.lock().unwrap().clone();
    // The planner belongs to the project, not a worktree: it always runs in the project folder.
    blocking(move || {
        let project = access.restrict(project, &component_ids).map_err(err)?;
        let sections = briefing_sections(
            &extensions.get(),
            &project,
            &component_ids,
            &roots,
            None,
            extra_context,
        );
        let metadata = service::metadata(&project_id, &project, model::PLAN_SCOPE, &terminal);
        let mut spec =
            context::plan_session_spec(&project, &component_ids, &terminal, &AllowAll, &sections)
                .map_err(err)?;
        if terminal.kind == model::TerminalKind::Agent {
            agent_commands::inject(agent_server, &project_id, None, &mut spec);
        }
        let id = bridge.start(spec, metadata, request_id)?;
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
    patchbay_core::agent_commands::for_task(project, task, required, roots).map_err(err)
}

/// A briefing's sections: the backend's own (`own`: the task, plan and peers),
/// whole and first, since core caps them itself, then the extension context
/// (component files and providers' `extra`) within the registry's budget.
fn briefing_sections(
    registry: &Registry,
    project: &Project,
    ids: &[String],
    roots: &[PathBuf],
    own: impl IntoIterator<Item = ContextSection>,
    extra: Option<Vec<ContextSection>>,
) -> Vec<ContextSection> {
    let mut sections: Vec<_> = own.into_iter().collect();
    sections.extend(registry.sections(project, ids, roots, extra.unwrap_or_default()));
    sections
}

/// What a component agent gets from planning: the saved plan and the other
/// components being changed with it (peers outside the trusted map are dropped).
/// Also returns the folders those sections name, for the agent to reach: the
/// peers' and, with a plan, the plans folder (the whole plan when it was cut).
fn handoff_sections(
    project: &Project,
    component_id: &str,
    task: Option<&str>,
    peers: Option<Vec<String>>,
) -> (Vec<ContextSection>, Vec<PathBuf>) {
    let root = Path::new(&project.root);
    let peers = peers.unwrap_or_default();
    let plan = patchbay_core::plans::section(root, task);
    let mut dirs: Vec<PathBuf> = peers
        .iter()
        .filter(|id| *id != component_id)
        .filter_map(|id| project.component(id))
        .map(|c| project.component_dir(c))
        .collect();
    if plan.is_some() {
        dirs.extend(patchbay_core::plans::existing_dir(root));
    }
    let peers = context::peers_section(project, component_id, &peers);
    let assignments = patchbay_core::proposals::section(project, task, &[component_id.into()]);
    (
        plan.into_iter().chain(assignments).chain(peers).collect(),
        dirs,
    )
}

/// The saved plan of the project (or `task`), empty when there is none.
#[tauri::command]
async fn plan_read(
    project_id: String,
    state: State<'_, AppState>,
    task: Option<String>,
) -> CmdResult<patchbay_core::plans::Plan> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || patchbay_core::plans::read(&root, task.as_deref()).map_err(err)).await
}

/// Replace the saved plan of the project (or `task`) while it still holds
/// `expected` (any content when `None`); `false` when it didn't.
#[tauri::command]
async fn plan_write(
    project_id: String,
    state: State<'_, AppState>,
    task: Option<String>,
    text: String,
    expected: Option<String>,
) -> CmdResult<bool> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || {
        patchbay_core::plans::write_if(&root, task.as_deref(), &text, expected.as_deref())
            .map_err(err)
    })
    .await
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
    project_id: String,
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    task: Option<String>,
) -> CmdResult<git::GitStatus> {
    let scoped = state.project(&project_id)?;
    // Resolve folders on a copy so the lock isn't held for the filesystem calls.
    let access = scoped.access.snapshot();
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
    project_id: String,
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    component_id: String,
    task: Option<String>,
) -> CmdResult<Vec<git::ChangedFile>> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
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
async fn git_worktrees(
    project_id: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<git::Worktree>> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
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
    project_id: String,
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
    component_id: String,
    path: String,
    old_path: Option<String>,
    worktree: Option<String>,
) -> CmdResult<git::FileDiff> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
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
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
    worktree: Option<String>,
) -> CmdResult<git::Review> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
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

/// A project's root and access, for task commands.
fn task_repo(state: &AppState, project_id: &str) -> CmdResult<(PathBuf, Arc<ProjectAccess>)> {
    let scoped = state.project(project_id)?;
    let root = scoped
        .access
        .snapshot()
        .root()
        .ok_or_else(|| "No project is open".to_string())?;
    Ok((root, scoped))
}

/// The tasks of the project's repo.
#[tauri::command]
async fn task_list(project_id: String, state: State<'_, AppState>) -> CmdResult<Vec<Task>> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || tasks::list(&root).map_err(err)).await
}

/// Create a branch and worktree beside the repo, and a task for them.
#[tauri::command]
async fn task_create(
    project_id: String,
    state: State<'_, AppState>,
    draft: TaskDraft,
) -> CmdResult<Task> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || tasks::create(&root, draft).map_err(err)).await
}

/// Make a task of one of the repo's existing worktrees.
#[tauri::command]
async fn task_attach(
    project_id: String,
    state: State<'_, AppState>,
    worktree: String,
    title: Option<String>,
    components: Vec<String>,
) -> CmdResult<Task> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || tasks::attach(&root, &worktree, title, components).map_err(err)).await
}

#[tauri::command]
async fn task_update(
    project_id: String,
    state: State<'_, AppState>,
    id: String,
    patch: TaskPatch,
) -> CmdResult<Task> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || tasks::update(&root, &id, patch).map_err(err)).await
}

/// Fails with the reason a task's worktree can't be removed, so the webview can
/// ask before stopping its terminals.
#[tauri::command]
async fn task_check_removable(
    project_id: String,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<()> {
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || tasks::check_removable(&root, &id).map(|_| ()).map_err(err)).await
}

/// Forget a task and optionally remove its (clean) worktree; the branch stays.
#[tauri::command]
async fn task_remove(
    app: AppHandle,
    project_id: String,
    state: State<'_, AppState>,
    id: String,
    delete_worktree: bool,
) -> CmdResult<()> {
    let (root, scoped) = task_repo(&state, &project_id)?;
    blocking(move || {
        let worktree = tasks::list(&root)
            .map_err(err)?
            .into_iter()
            .find(|t| t.id == id)
            .map(|t| PathBuf::from(t.worktree));
        tasks::remove(&root, &id, delete_worktree).map_err(err)?;
        let mut active = scoped
            .task_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if active.is_some() && *active == worktree {
            *active = None;
            drop(active);
            rewatch(&app, &project_id);
        }
        Ok(())
    })
    .await
}

/// Watch the worktree of the task the user switched to in this project (none
/// for the project's own).
#[tauri::command]
async fn task_activate(
    app: AppHandle,
    project_id: String,
    state: State<'_, AppState>,
    id: Option<String>,
) -> CmdResult<()> {
    let (root, scoped) = task_repo(&state, &project_id)?;
    blocking(move || {
        let worktree = match id {
            Some(id) => {
                let task = tasks::find(&root, &id).map_err(err)?;
                (!task.current).then(|| PathBuf::from(task.worktree))
            }
            None => None,
        };
        let mut active = scoped
            .task_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *active != worktree {
            *active = worktree;
            drop(active);
            rewatch(&app, &project_id);
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

// Tauri commands take their IPC arguments individually.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn terminal_start(
    request_id: String,
    project_id: String,
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    terminal_id: String,
    extra_context: Option<Vec<ContextSection>>,
    task: Option<String>,
    peers: Option<Vec<String>>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let extensions = state.extensions.clone();
    let roots = scoped.roots();
    let bridge = state.service.clone();
    let agent_server = state.agent_commands.lock().unwrap().clone();
    blocking(move || {
        let ids = std::slice::from_ref(&component_id);
        let project = access.restrict(project, ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), ids, roots)?;
        let terminal = project
            .component(&component_id)
            .and_then(|c| c.terminals.iter().find(|t| t.id == terminal_id))
            .ok_or("Unknown terminal")?;
        // Only agents read a briefing, so skip the plan lookup for the rest.
        let (handoff, dirs) = if terminal.kind == model::TerminalKind::Agent {
            handoff_sections(&project, &component_id, task.as_deref(), peers)
        } else {
            Default::default()
        };
        let sections = briefing_sections(
            &extensions.get(),
            &project,
            ids,
            &roots,
            section.into_iter().chain(handoff),
            extra_context,
        );
        let mut metadata = service::metadata(&project_id, &project, &component_id, terminal);
        metadata.task.clone_from(&task);
        let mut spec = context::session_spec_with(
            &project,
            &component_id,
            &terminal_id,
            task.as_deref(),
            &AllowAll,
            &sections,
            &dirs,
        )
        .map_err(err)?;
        if terminal.kind == model::TerminalKind::Agent {
            agent_commands::inject(agent_server, &project_id, task.as_deref(), &mut spec);
        }
        let id = bridge.start(spec, metadata, request_id)?;
        Ok(id)
    })
    .await
}

/// Start a configured root session with implementation instructions only.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn task_root_start(
    request_id: String,
    project_id: String,
    state: State<'_, AppState>,
    project: Project,
    component_ids: Vec<String>,
    terminal: TerminalSpec,
    task: Option<String>,
    extra_context: Option<Vec<ContextSection>>,
    implement_plan: Option<bool>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let roots = scoped.roots();
    let extensions = state.extensions.clone();
    let bridge = state.service.clone();
    let agent_server = state.agent_commands.lock().unwrap().clone();
    blocking(move || {
        let project = access.restrict(project, &component_ids).map_err(err)?;
        let (project, roots, section) = for_task(project, task.as_deref(), &component_ids, roots)?;
        let selected = if component_ids.is_empty() {
            project.components.iter().map(|c| c.id.clone()).collect()
        } else {
            component_ids
        };
        let root = Path::new(&project.root);
        let own = section
            .into_iter()
            .chain(patchbay_core::plans::section(root, task.as_deref()))
            .chain(patchbay_core::proposals::section(
                &project,
                task.as_deref(),
                &selected,
            ));
        let sections = briefing_sections(
            &extensions.get(),
            &project,
            &selected,
            &roots,
            own,
            extra_context,
        );
        let mut metadata =
            service::metadata(&project_id, &project, model::TASK_ROOT_SCOPE, &terminal);
        metadata.task.clone_from(&task);
        let build = if implement_plan.unwrap_or(false) {
            context::task_root_implementation_spec
        } else {
            context::task_root_session_spec
        };
        let mut spec = build(
            &project,
            &selected,
            &terminal,
            task.as_deref(),
            &AllowAll,
            &sections,
        )
        .map_err(err)?;
        if terminal.kind == model::TerminalKind::Agent {
            agent_commands::inject(agent_server, &project_id, task.as_deref(), &mut spec);
        }
        bridge.start(spec, metadata, request_id)
    })
    .await
}

/// Launch a merge agent in an existing destination worktree.
#[tauri::command]
async fn merge_agent_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    project_id: String,
    mut project: Project,
    request: patchbay_core::merges::MergeRequest,
    terminal: TerminalSpec,
    request_id: String,
) -> CmdResult<String> {
    main_only(&window)?;
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let bridge = state.service.clone();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        let job = patchbay_core::merges::prepare(&project, &request, &terminal, &AllowAll)
            .map_err(err)?;
        let metadata = service::metadata(&project_id, &project, model::MERGE_SCOPE, &job.terminal);
        bridge.start(job.spec, metadata, request_id)
    })
    .await
}

/// Preview what a graph action would run.
#[tauri::command]
async fn graph_action_plan(
    project_id: String,
    state: State<'_, AppState>,
    mut project: Project,
    request: ActionRequest,
    task: Option<String>,
) -> CmdResult<ActionPlan> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let roots = scoped.roots();
    blocking(move || {
        access.trust(&mut project).map_err(err)?;
        let (project, _, _) = for_task(project, task.as_deref(), &[], roots)?;
        ActionPlan::build(&project, &project_id, request, task.as_deref()).map_err(err)
    })
    .await
}

/// Run a graph action in the session service, which owns the terminals it starts.
#[tauri::command]
async fn graph_action_run(
    app: AppHandle,
    project_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project: Project,
    request: ActionRequest,
    task: Option<String>,
) -> CmdResult<ActionReport> {
    main_only(&window)?;
    state.project(&project_id)?;
    blocking(move || {
        agent_commands::run_action(&app, &project_id, project, request, task.as_deref(), "User")
            .map(|(report, _)| report)
    })
    .await
}

#[tauri::command]
async fn graph_group_stop(
    app: AppHandle,
    project_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    group_id: String,
    task: Option<String>,
) -> CmdResult<()> {
    main_only(&window)?;
    let (root, _) = task_repo(&state, &project_id)?;
    blocking(move || {
        agent_commands::stop_group(&app, &project_id, &root, &group_id, task.as_deref(), "User")
    })
    .await
}

/// Stop every environment started in a task's worktree, before the task is removed.
#[tauri::command]
async fn graph_task_stop(
    project_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    task: String,
) -> CmdResult<()> {
    main_only(&window)?;
    state.project(&project_id)?;
    service(&state, Request::ActionStopTask { project_id, task }).await
}

/// Stop the running validation; it still reports the validators that ran.
#[tauri::command]
async fn graph_validation_cancel(
    project_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<bool> {
    main_only(&window)?;
    service(&state, Request::ActionCancel { project_id }).await
}

/// Run a session service request on a blocking worker, never the main thread.
async fn service<T: serde::de::DeserializeOwned + Send + 'static>(
    state: &AppState,
    request: Request,
) -> CmdResult<T> {
    let bridge = state.service.clone();
    blocking(move || bridge.call(request)).await
}

/// Keystrokes are queued in order and return at once.
#[tauri::command]
fn terminal_write(
    window: WebviewWindow,
    state: State<AppState>,
    session_id: String,
    data: String,
) -> CmdResult<()> {
    state.service.send(Request::Write {
        id: session_id,
        viewer: window.label().into(),
        data,
    })
}
#[tauri::command]
fn terminal_resize(
    window: WebviewWindow,
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state.service.send(Request::Resize {
        id: session_id,
        viewer: window.label().into(),
        cols,
        rows,
    })
}
#[tauri::command]
async fn terminal_stop(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    service(&state, Request::Stop { id: session_id }).await
}
#[tauri::command]
async fn sessions_stop_all(state: State<'_, AppState>) -> CmdResult<()> {
    service(&state, Request::StopAll).await
}
/// Block launches from every webview while the saved terminal is being removed.
#[tauri::command]
async fn terminal_close_guard(
    project_id: String,
    component_id: String,
    terminal_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<String> {
    main_only(&window)?;
    state.project(&project_id)?;
    service(
        &state,
        Request::TerminalCloseGuard {
            project_id,
            component_id,
            terminal_id,
        },
    )
    .await
}
#[tauri::command]
async fn terminal_seen(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    service(&state, Request::Seen { id: session_id }).await
}
#[tauri::command]
async fn terminal_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Option<Snapshot>> {
    service(&state, Request::Snapshot { id: session_id }).await
}
/// Register this window as a viewer (and, with `claim`, the one that types and
/// sizes the PTY). Returns no output: windows hydrate with `terminal_snapshot`.
#[tauri::command]
async fn terminal_attach(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
    claim: bool,
) -> CmdResult<()> {
    let request = Request::Claim {
        id: session_id,
        viewer: window.label().into(),
        claim,
    };
    service(&state, request).await
}
#[tauri::command]
async fn terminal_detach(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<()> {
    let request = Request::Detach {
        id: session_id,
        viewer: window.label().into(),
    };
    service(&state, request).await
}
#[tauri::command]
async fn sessions_list(state: State<'_, AppState>) -> CmdResult<Vec<Record>> {
    let bridge = state.service.clone();
    blocking(move || bridge.list()).await
}
#[tauri::command]
async fn session_resume(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
) -> CmdResult<String> {
    let bridge = state.service.clone();
    let extensions = state.extensions.clone();
    let projects: HashMap<_, _> = state.projects.read().unwrap().clone();
    blocking(move || {
        let records = bridge.list()?;
        let record = records
            .iter()
            .find(|r| r.id == session_id)
            .ok_or("Unknown session")?;
        let scoped = projects
            .get(&record.metadata.project_id)
            .ok_or("Project unavailable; locate its folder first")?;
        // A task's terminal may only reach the task's worktree, as when it started.
        let root = scoped.access.snapshot().root();
        let mut roots = if record.metadata.component_id == model::MERGE_SCOPE {
            patchbay_core::merges::resume_roots(
                root.as_deref().ok_or("No project is open")?,
                &record.spec,
            )
            .map_err(err)?
        } else {
            match &record.metadata.task {
                Some(task) => {
                    let root = root.as_deref().ok_or("No project is open")?;
                    let worktree = tasks::stored(root, task).map_err(err)?.worktree;
                    vec![Path::new(&worktree).canonicalize().map_err(err)?]
                }
                None => scoped.roots(),
            }
        };
        // Planners and agents with a plan were handed the repo's plans folder,
        // which lies under `.git` (and every worktree shares).
        roots.extend(root.and_then(|r| patchbay_core::plans::existing_dir(&r)));
        session::check_resume(record, &roots).map_err(err)?;
        if let Some(extension_id) = &record.metadata.extension_id {
            extensions.get().allowed(extension_id, None).map_err(err)?;
        }
        bridge.call(Request::Resume {
            id: session_id,
            request_id,
        })
    })
    .await
}
#[tauri::command]
async fn session_conversation(
    state: State<'_, AppState>,
    session_id: String,
    conversation_id: String,
) -> CmdResult<()> {
    let request = Request::Conversation {
        id: session_id,
        conversation_id,
    };
    service(&state, request).await
}
#[tauri::command]
async fn session_forget(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    service(&state, Request::Forget { id: session_id }).await
}
#[tauri::command]
async fn quit_patchbay(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state
        .quitting
        .store(true, std::sync::atomic::Ordering::Release);
    layout::save(&app);
    app.exit(0);
    Ok(())
}

/// Navigation roots are derived from backend grants and registered task/worktree identity.
fn navigation_roots(
    scoped: &ProjectAccess,
    task: Option<&str>,
    worktree: Option<&str>,
) -> CmdResult<(Vec<PathBuf>, Vec<PathBuf>)> {
    let roots = scoped.roots();
    let root = roots.first().ok_or("No project is open")?.clone();
    let scan = scoped.access.watch_roots();
    let task = task
        .map(|id| tasks::stored(&root, id).map_err(err))
        .transpose()?;
    let worktree = worktree.or_else(|| task.as_ref().map(|t| t.worktree.as_str()));
    let Some(worktree) = worktree else {
        return Ok((roots, scan));
    };
    let roots = Cached::get_or(
        &scoped.worktree_roots,
        (root, worktree.to_string(), scan),
        WORKTREE_ROOTS_TTL,
        |(root, worktree, scan)| {
            let components = scan
                .iter()
                .enumerate()
                .map(|(i, dir)| (i.to_string(), dir.clone()))
                .collect();
            let (task_root, mapped) =
                git::in_worktree(root, components, Some(worktree)).map_err(err)?;
            let mut roots = vec![task_root];
            // Folders in other repos (granted siblings, nested repos) aren't part of the task's
            // worktree, so they stay as they are; in-repo folders the worktree lacks are dropped.
            let repo = git::repo_root(root);
            let external = scan.iter().filter(|dir| git::repo_root(dir) != repo);
            for dir in mapped.into_iter().map(|(_, d)| d).chain(external.cloned()) {
                if !roots.contains(&dir) {
                    roots.push(dir);
                }
            }
            CmdResult::Ok(roots)
        },
    )?;
    Ok((roots.clone(), roots))
}

/// Lists the active task's folder, preserving relative project paths.
#[tauri::command]
async fn list_dir(
    project_id: String,
    state: State<'_, AppState>,
    path: String,
    task: Option<String>,
) -> CmdResult<Vec<DirEntry>> {
    let scoped = state.project(&project_id)?;
    blocking(move || {
        let (roots, _) = navigation_roots(&scoped, task.as_deref(), None)?;
        files::list_dir(&roots, Path::new(&path)).map_err(err)
    })
    .await
}

/// Reveal remains a separate, worktree-aware file-manager action.
#[tauri::command]
async fn reveal_path(
    project_id: String,
    state: State<'_, AppState>,
    path: String,
    task: Option<String>,
    worktree: Option<String>,
) -> CmdResult<()> {
    let scoped = state.project(&project_id)?;
    blocking(move || {
        let (roots, _) = navigation_roots(&scoped, task.as_deref(), worktree.as_deref())?;
        tauri_plugin_opener::reveal_item_in_dir(
            files::resolve(&roots, Path::new(&path)).map_err(err)?,
        )
        .map_err(err)
    })
    .await
}
#[tauri::command]
async fn editor_preferences() -> CmdResult<EditorPreferences> {
    blocking(|| navigation::preferences().map_err(err)).await
}
#[tauri::command]
async fn editor_save_preferences(preferences: EditorPreferences) -> CmdResult<()> {
    blocking(move || navigation::save_preferences(&preferences).map_err(err)).await
}
#[tauri::command]
async fn editor_discover() -> CmdResult<Vec<EditorLauncher>> {
    blocking(|| Ok(navigation::discover())).await
}
#[tauri::command]
async fn editor_open(
    project_id: String,
    state: State<'_, AppState>,
    target: EditorTarget,
    task: Option<String>,
    worktree: Option<String>,
) -> CmdResult<()> {
    let scoped = state.project(&project_id)?;
    blocking(move || {
        let prefs = navigation::preferences().map_err(err)?;
        let (roots, _) = navigation_roots(&scoped, task.as_deref(), worktree.as_deref())?;
        navigation::open(&prefs, &roots, &target).map_err(err)
    })
    .await
}
#[tauri::command]
async fn file_search(
    project_id: String,
    state: State<'_, AppState>,
    query: String,
    task: Option<String>,
) -> CmdResult<Vec<FileSearchResult>> {
    let scoped = state.project(&project_id)?;
    blocking(move || {
        let (roots, scan) = navigation_roots(&scoped, task.as_deref(), None)?;
        let paths = Cached::get_or(
            &scoped.search_paths,
            (roots.clone(), scan),
            SEARCH_PATHS_TTL,
            |(roots, scan)| navigation::candidates(roots, scan).map(Arc::new),
        )
        .map_err(err)?;
        navigation::rank_candidates(&roots, &paths, &query).map_err(err)
    })
    .await
}
/// A terminal link uses its recorded launch directory and process generation,
/// never the current tab or a search for similarly named files.
#[tauri::command]
async fn terminal_open_reference(
    state: State<'_, AppState>,
    session_id: String,
    generation: u64,
    reference: String,
) -> CmdResult<()> {
    let bridge = state.service.clone();
    let projects = state.projects.read().unwrap().clone();
    blocking(move || {
        let records = bridge.list()?;
        let record = records
            .iter()
            .find(|r| r.id == session_id)
            .ok_or("Unknown terminal session")?;
        let snapshot = record
            .snapshot
            .iter()
            .chain(record.history.iter())
            .find(|s| s.generation == generation)
            .ok_or(
                "This file reference belongs to an earlier process whose history is unavailable",
            )?;
        let launch_directory = snapshot
            .launch_directory
            .as_ref()
            .or_else(|| {
                (record.snapshot.as_ref().map(|s| s.generation) == Some(generation))
                    .then_some(&record.spec.cwd)
            })
            .ok_or("The original launch folder of this historical process is unknown")?;
        let scoped = projects
            .get(&record.metadata.project_id)
            .ok_or("Originating project is unavailable")?;
        let (roots, _) = navigation_roots(scoped, record.metadata.task.as_deref(), None)?;
        let mut target = navigation::reference(&reference).map_err(err)?;
        let resolved =
            files::resolve(&roots, &launch_directory.join(&target.path)).map_err(|e| {
                format!(
                    "Cannot resolve {reference} from recorded launch folder {}: {e}",
                    launch_directory.display()
                )
            })?;
        target.path = resolved.to_string_lossy().into_owned();
        navigation::open(&navigation::preferences().map_err(err)?, &roots, &target).map_err(err)
    })
    .await
}

/// Debug smoke helper: stops every session and returns the highest generation
/// seen, so late events from the stopped sessions can be ignored. Refused in
/// release builds, where it would end all running work.
#[tauri::command]
async fn terminal_reset(state: State<'_, AppState>) -> CmdResult<u64> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        Err("terminal_reset is only available in debug builds".into())
    }
    #[cfg(debug_assertions)]
    {
        let bridge = state.service.clone();
        blocking(move || {
            let mut floor = 0;
            for r in bridge.call::<Vec<Record>>(Request::List)? {
                floor = r
                    .snapshot
                    .iter()
                    .chain(&r.history)
                    .map(|s| s.generation)
                    .fold(floor, u64::max);
            }
            bridge.call::<()>(Request::StopAll)?;
            Ok(floor)
        })
        .await
    }
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
        .on_window_event(|window, event| {
            layout::event(window, event);
            match event {
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
                    let bridge = window.app_handle().state::<AppState>().service.clone();
                    let viewer = window.label().to_string();
                    std::thread::spawn(move || {
                        let _ = bridge.call::<()>(Request::DetachViewer { viewer });
                    });
                    let _ = window
                        .app_handle()
                        .emit(WINDOW_CLOSED_EVENT, window.label());
                }
                _ => {}
            }
        })
        .manage(AppState::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            smoke::setup(app);
            // Built here rather than by Tauri (`create: false`) so smoke runs can adjust it.
            let config = app.config().app.windows.first().cloned();
            let config = config.ok_or("tauri.conf.json defines no main window")?;
            let main = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            #[cfg(debug_assertions)]
            let main = smoke::main_window(main);
            main.build()?;
            app.state::<AppState>().service.run(app.handle().clone());
            *app.state::<AppState>().agent_commands.lock().unwrap() =
                agent_commands::start(app.handle().clone())
                    .map_err(|e| eprintln!("Patchbay agent commands are unavailable: {e}"))
                    .ok();
            Ok(())
        })
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
                agent_hooks_check,
                agent_hooks_configure,
                open_project,
                rescan_project,
                map_issues,
                apply_reconciliation,
                edit_map_components,
                cleanup_component_scopes,
                release_map_edit,
                add_folder,
                pick_component_folder,
                sync_roots,
                save_project,
                reload_project,
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
                plan_read,
                task_root_start,
                merge_agent_start,
                agent_commands::task_activities,
                agent_commands::sync_agent_project,
                agent_commands::proposal_read,
                agent_commands::proposal_apply,
                plan_start,
                plan_write,
                list_devices,
                save_device,
                terminal_start,
                terminal_attach,
                terminal_detach,
                sessions_list,
                session_resume,
                session_history,
                session_conversation,
                session_forget,
                quit_patchbay,
                service_status,
                project_fingerprint,
                project_close,
                window_register,
                window_layout,
                window_tab,
                window_panels,
                workspace_load,
                workspace_save,
                project_relink,
                graph_action_plan,
                graph_action_run,
                graph_group_stop,
                graph_task_stop,
                graph_validation_cancel,
                terminal_write,
                terminal_resize,
                terminal_stop,
                sessions_stop_all,
                terminal_close_guard,
                terminal_seen,
                terminal_reset,
                terminal_snapshot,
                list_dir,
                reveal_path,
                editor_preferences,
                editor_save_preferences,
                editor_discover,
                editor_open,
                file_search,
                terminal_open_reference,
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
                extension_sessions_list,
                extension_url_open,
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building Patchbay")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                let state = app.state::<AppState>();
                if code.is_none()
                    && !state.quitting.load(std::sync::atomic::Ordering::Acquire)
                    && app.get_webview_window("main").is_some()
                {
                    api.prevent_exit();
                    let _ = app.emit_to("main", "patchbay://quit-request", ());
                } else {
                    state
                        .quitting
                        .store(true, std::sync::atomic::Ordering::Release);
                    layout::save(app);
                }
            }
            if let RunEvent::Exit = event {
                app.state::<AppState>()
                    .quitting
                    .store(true, std::sync::atomic::Ordering::Release);
                layout::save(app);
                for project in app.state::<AppState>().projects.read().unwrap().values() {
                    project.watcher.stop();
                }
                if let Some(server) = app
                    .state::<AppState>()
                    .agent_commands
                    .lock()
                    .unwrap()
                    .take()
                {
                    server.stop();
                }
                app.state::<AppState>().service.disconnect();
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
#[allow(clippy::too_many_arguments)] // Named IPC fields preserve the existing command contract.
async fn command_run(
    project_id: String,
    request_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project: Project,
    component_id: String,
    command_id: String,
    task: Option<String>,
) -> CmdResult<String> {
    main_only(&window)?;
    launch_extension_terminal(
        project_id,
        request_id,
        &state,
        project,
        component_id,
        task,
        move |registry| {
            let owner = registry
                .extensions
                .iter()
                .find(|e| {
                    e.enabled
                        && e.errors.is_empty()
                        && e.manifest
                            .contributes
                            .commands
                            .iter()
                            .any(|c| c.id == command_id)
                })
                .ok_or("Unknown enabled extension command")?;
            Ok((
                extensions::command_terminal(registry, &command_id).map_err(err)?,
                owner.id.clone(),
                Some(command_id),
                None,
            ))
        },
    )
    .await
}

/// Spawn a terminal that isn't on the map, with the component's file context.
async fn launch_extension_terminal(
    project_id: String,
    request_id: String,
    state: &AppState,
    project: Project,
    component_id: String,
    task: Option<String>,
    terminal: impl FnOnce(
        &Registry,
    ) -> CmdResult<(TerminalSpec, String, Option<String>, Option<String>)>
    + Send
    + 'static,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let roots = scoped.roots();
    let extensions = state.extensions.clone();
    let bridge = state.service.clone();
    let agent_server = state.agent_commands.lock().unwrap().clone();
    blocking(move || {
        let registry = extensions.get();
        let (terminal, extension_id, command_id, key) = terminal(&registry)?;
        let project = access
            .restrict(project, std::slice::from_ref(&component_id))
            .map_err(err)?;
        let ids = std::slice::from_ref(&component_id);
        let (project, roots, section) = for_task(project, task.as_deref(), ids, roots)?;
        let sections = briefing_sections(&registry, &project, ids, &roots, section, None);
        let mut metadata = service::metadata(&project_id, &project, &component_id, &terminal);
        metadata.task.clone_from(&task);
        metadata.extension_id = Some(extension_id);
        metadata.command_id = command_id;
        metadata.key = key;
        let agent = terminal.kind == patchbay_core::TerminalKind::Agent;
        let mut spec =
            context::extra_session_spec(project, &component_id, terminal, &AllowAll, &sections)
                .map_err(err)?;
        if agent {
            agent_commands::inject(agent_server, &project_id, task.as_deref(), &mut spec);
        }
        let id = bridge.start(spec, metadata, request_id)?;
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
    project_id: String,
    request_id: String,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project: Project,
    request: ExtensionTerminalRequest,
    task: Option<String>,
) -> CmdResult<String> {
    main_only(&window)?;
    let ExtensionTerminalRequest {
        extension_id,
        component_id,
        command,
        key,
    } = request;
    launch_extension_terminal(
        project_id,
        request_id,
        &state,
        project,
        component_id,
        task,
        move |registry| {
            registry
                .allowed(&extension_id, Some("terminals"))
                .map_err(err)?;
            Ok((
                extensions::run_terminal(&extension_id, command, &key).map_err(err)?,
                extension_id,
                None,
                Some(key),
            ))
        },
    )
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
    project_id: String,
    state: State<'_, AppState>,
    extension_id: String,
    path: String,
    task: Option<String>,
) -> CmdResult<String> {
    let scoped = state.project(&project_id)?;
    main_only(&window)?;
    let extensions = state.extensions.clone();
    let mut roots = scoped.roots();
    let root = scoped
        .access
        .snapshot()
        .root()
        .ok_or("Project unavailable")?;
    blocking(move || {
        extensions
            .get()
            .allowed(&extension_id, Some("files:read"))
            .map_err(err)?;
        if let Some(task) = task {
            let task = tasks::stored(&root, &task).map_err(err)?;
            let (mapped_root, _) =
                git::in_worktree(&root, vec![], Some(&task.worktree)).map_err(err)?;
            roots = vec![mapped_root];
        }
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

fn workspace_path() -> CmdResult<PathBuf> {
    Ok(workspace::home()
        .map_err(err)?
        .join("workspaces/default.json"))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Restored {
    document: Workspace,
    opened: Vec<Opened>,
    errors: HashMap<String, String>,
}
#[tauri::command]
async fn workspace_load(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Restored> {
    main_only(&window)?;
    let extensions = state.extensions.clone();
    blocking(move || {
        let document = Workspace::load(&workspace_path()?).map_err(err)?;
        let mut opened = vec![];
        let mut errors = HashMap::new();
        for entry in &document.projects {
            let result = (|| -> CmdResult<Opened> {
                let loaded = workspace::restore_project(entry, &extensions.get().detectors())
                    .map_err(err)?;
                let scoped = Arc::new(ProjectAccess::default());
                scoped.access.open(&loaded.project).map_err(err)?;
                // External grants are revalidated by trusted pickers; restoration cannot
                // grant them. Opening the project again asks for them.
                let id = loaded.id.clone();
                *scoped.agent_project.write().unwrap() = Some(loaded.project.clone());
                let restored = to_opened(loaded, &scoped.access.snapshot());
                app.state::<AppState>()
                    .projects
                    .write()
                    .unwrap()
                    .insert(id.clone(), scoped);
                rewatch(&app, &id);
                Ok(restored)
            })();
            match result {
                Ok(project) => opened.push(project),
                Err(e) => {
                    errors.insert(entry.id.clone(), e);
                }
            }
        }
        *app.state::<AppState>().workspace.lock().unwrap() = document.clone();
        app.state::<AppState>()
            .workspace_ready
            .store(true, std::sync::atomic::Ordering::Release);
        layout::restore_main(&app)?;
        Ok(Restored {
            document,
            opened,
            errors,
        })
    })
    .await
}
#[tauri::command]
async fn workspace_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mut document: Workspace,
) -> CmdResult<()> {
    main_only(&window)?;
    let mut stored = state.workspace.lock().unwrap();
    document.windows = stored.windows.clone();
    document.validate().map_err(err)?;
    document.save(&workspace_path()?).map_err(err)?;
    *stored = document;
    Ok(())
}
#[tauri::command]
async fn project_relink(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    project_id: String,
) -> CmdResult<Option<Opened>> {
    main_only(&window)?;
    if !state
        .workspace
        .lock()
        .unwrap()
        .projects
        .iter()
        .any(|p| p.id == project_id)
    {
        return Err("Unknown unavailable project".into());
    }
    // Folders already registered (another open tab) must survive a failed relink.
    let registered: std::collections::HashSet<String> =
        state.projects.read().unwrap().keys().cloned().collect();
    let Some(mut opened) = open_project(app.clone(), window, state, None).await? else {
        return Ok(None);
    };
    let state = app.state::<AppState>();
    let chosen = workspace::Loaded {
        id: opened.id.clone(),
        root: PathBuf::from(&opened.project.root),
        project: opened.project.clone(),
        detected: opened.detected,
        fingerprint: opened.fingerprint.clone(),
    };
    let document = state.workspace.lock().unwrap().clone();
    if let Err(e) = workspace::relink_project(&document, &project_id, &chosen) {
        // `open_project` registered the folder under its own identity; undo that.
        if opened.id != project_id
            && !registered.contains(&opened.id)
            && let Some(scoped) = state.projects.write().unwrap().remove(&opened.id)
        {
            scoped.watcher.stop();
        }
        return Err(err(e));
    }
    let entry_id = project_id;
    let scoped = state
        .projects
        .write()
        .unwrap()
        .remove(&opened.id)
        .ok_or("Chosen project unavailable")?;
    scoped.watcher.stop();
    let relinked = Arc::new(ProjectAccess {
        agent_project: RwLock::new(scoped.agent_project.read().unwrap().clone()),
        maintenance: Mutex::default(),
        access: scoped.access.clone(),
        watcher: watch::GitWatcher::default(),
        task_root: scoped.task_root.clone(),
        worktree_roots: Mutex::default(),
        search_paths: Mutex::default(),
    });
    state
        .projects
        .write()
        .unwrap()
        .insert(entry_id.clone(), relinked);
    rewatch(&app, &entry_id);
    opened.id = entry_id;
    Ok(Some(opened))
}
#[tauri::command]
fn service_status(state: State<AppState>) -> serde_json::Value {
    state.service.status()
}
#[tauri::command]
fn project_fingerprint(state: State<AppState>, project_id: String) -> CmdResult<String> {
    let root = state
        .project(&project_id)?
        .access
        .snapshot()
        .root()
        .ok_or("Project unavailable")?;
    workspace::fingerprint(&root).map_err(err)
}
#[tauri::command]
fn project_close(state: State<AppState>, project_id: String) {
    if let Some(project) = state.projects.write().unwrap().remove(&project_id) {
        project.watcher.stop();
    }
}
#[tauri::command]
fn window_register(
    window: WebviewWindow,
    state: State<AppState>,
    label: String,
    project_id: String,
    component_id: String,
) -> CmdResult<serde_json::Value> {
    main_only(&window)?;
    state.project(&project_id)?;
    let mut document = state.workspace.lock().unwrap();
    if !document.windows.is_object() {
        document.windows = serde_json::json!({});
    }
    let entry = document
        .windows
        .as_object_mut()
        .unwrap()
        .entry(label)
        .or_insert_with(|| serde_json::json!({}));
    entry["projectId"] = serde_json::json!(project_id);
    entry["componentId"] = serde_json::json!(component_id);
    let geometry = layout::clamp(&window, entry, false)?;
    state
        .layout_dirty
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(geometry)
}
#[tauri::command]
fn window_layout(window: WebviewWindow, state: State<AppState>) -> serde_json::Value {
    state
        .workspace
        .lock()
        .unwrap()
        .windows
        .get(window.label())
        .cloned()
        .unwrap_or_default()
}
#[tauri::command]
fn window_tab(window: WebviewWindow, state: State<AppState>, tab: String) -> CmdResult<()> {
    if tab != "files" && tab != "changes" {
        return Err("Unknown pop-out tab".into());
    }
    let mut document = state.workspace.lock().unwrap();
    if let Some(entry) = document.windows.get_mut(window.label()) {
        entry["tab"] = serde_json::json!(tab);
    }
    state
        .layout_dirty
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}
#[tauri::command]
fn window_panels(window: WebviewWindow, state: State<AppState>, panels: serde_json::Value) {
    let mut document = state.workspace.lock().unwrap();
    if let Some(entry) = document.windows.get_mut(window.label()) {
        entry["panels"] = panels;
    }
    state
        .layout_dirty
        .store(true, std::sync::atomic::Ordering::Release);
}

#[tauri::command]
async fn session_history(
    state: State<'_, AppState>,
    session_id: String,
    incarnation: usize,
) -> CmdResult<Option<Snapshot>> {
    let request = Request::History {
        id: session_id,
        incarnation,
    };
    service(&state, request).await
}

#[cfg(test)]
mod navigation_tests {
    use super::*;
    use std::process::Command;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn navigation_maps_nested_project_targets_to_registered_task_and_review_worktrees() {
        let dir = std::env::temp_dir().join(format!(
            "patchbay-navigation-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let fixture = Fixture(dir);
        let repo = fixture.0.join("repo");
        let project_root = repo.join("apps/project");
        let sibling = fixture.0.join("sibling");
        std::fs::create_dir_all(&project_root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(project_root.join("target.txt"), "target").unwrap();
        std::fs::write(sibling.join("external.txt"), "external").unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=smoke",
            "-c",
            "user.email=smoke@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
        ]);
        let worktree = fixture.0.join("task");
        git(&[
            "worktree",
            "add",
            "-qb",
            "navigation-task",
            worktree.to_str().unwrap(),
        ]);
        let worktree = worktree.canonicalize().unwrap();
        let mut project = detect::detect(&project_root.canonicalize().unwrap()).unwrap();
        project.components.push(patchbay_core::Component {
            id: "sibling".into(),
            detection: None,
            name: "Sibling".into(),
            kind: patchbay_core::ComponentKind::Other,
            path: model::relative_path(Path::new(&project.root), &sibling.canonicalize().unwrap()),
            notes: String::new(),
            terminals: vec![],
            position: model::Position::default(),
        });
        let scoped = ProjectAccess::default();
        scoped.access.open(&project).unwrap();
        let denied = navigation_roots(&scoped, None, None).unwrap().0;
        assert!(files::resolve(&denied, &sibling.join("external.txt")).is_err());
        scoped.access.grant(&sibling).unwrap();
        let allowed = navigation_roots(&scoped, None, None).unwrap().0;
        assert!(files::resolve(&allowed, &sibling.join("external.txt")).is_ok());
        let task = tasks::attach(
            Path::new(&project.root),
            worktree.to_str().unwrap(),
            None,
            vec![],
        )
        .unwrap();
        let mapped = navigation_roots(&scoped, Some(&task.id), None).unwrap().0;
        assert_eq!(
            files::resolve(&mapped, Path::new("target.txt")).unwrap(),
            worktree.join("apps/project/target.txt")
        );
        // A granted sibling isn't part of the task's worktree and stays reachable as it is.
        assert_eq!(
            files::resolve(&mapped, &sibling.join("external.txt")).unwrap(),
            sibling.canonicalize().unwrap().join("external.txt")
        );
        assert!(
            !mapped
                .iter()
                .any(|r| r.starts_with(repo.canonicalize().unwrap()))
        );
        let explicit = navigation_roots(&scoped, None, worktree.to_str())
            .unwrap()
            .0;
        assert_eq!(mapped, explicit);
        assert!(navigation_roots(&scoped, None, sibling.to_str()).is_err());
    }
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    #[test]
    fn preview_rechecks_draft_access_and_detector_availability() {
        let root = std::env::temp_dir().join(format!(
            "patchbay-preview-token-{}",
            PREVIEW_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut project: Project = serde_json::from_value(serde_json::json!({"name":"P","root":root.display().to_string(),"components":[{"id":"web","name":"Web","path":"."}]})).unwrap();
        let access = Access::default();
        access.open(&project).unwrap();
        let preview = maintenance::ReconciliationPreview {
            id: "token".into(),
            access_revision: access.snapshot().revision(),
            issues: vec![],
            proposals: vec![],
        };
        let pending = PendingPreview {
            draft: serde_json::to_string(&project).unwrap(),
            detectors: "[]".into(),
            preview,
        };
        assert!(pending.check(&project, &access.snapshot(), &[]).is_ok());
        project.components[0].notes = "changed during scan".into();
        assert!(pending.check(&project, &access.snapshot(), &[]).is_err());
        project.components[0].notes.clear();
        let detector = extensions::DetectorContribution {
            id: "extension:new:detector".into(),
            files: vec!["manifest".into()],
            kind: model::ComponentKind::Other,
            terminals: vec![],
        };
        assert!(
            pending
                .check(&project, &access.snapshot(), &[detector])
                .is_err()
        );
        access.sync(vec!["other".into()]);
        assert!(pending.check(&project, &access.snapshot(), &[]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Extension summaries are permission checked natively and narrowed to one component/task.
#[tauri::command]
async fn extension_sessions_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    extension_id: String,
    project_id: String,
    project: Project,
    component_id: String,
    task: Option<String>,
) -> CmdResult<Vec<extensions::ComponentSessionSummary>> {
    main_only(&window)?;
    let scoped = state.project(&project_id)?;
    let access = scoped.access.snapshot();
    let roots = scoped.roots();
    let extensions = state.extensions.clone();
    let bridge = state.service.clone();
    blocking(move || {
        extensions
            .get()
            .allowed(&extension_id, Some("sessions:read"))
            .map_err(err)?;
        let project = access
            .restrict(project, std::slice::from_ref(&component_id))
            .map_err(err)?;
        let (_, roots, _) = for_task(
            project,
            task.as_deref(),
            std::slice::from_ref(&component_id),
            roots,
        )?;
        // List intentionally omits output. Filter first, then let the service scan each
        // (at most 32) backlog for URLs, so no output crosses the bridge.
        let mut summaries = extensions::session_summaries(
            &bridge.list()?,
            &project_id,
            task.as_deref(),
            &component_id,
            &roots,
        );
        for summary in &mut summaries {
            let scan: Option<PreviewScan> = bridge.call(Request::PreviewUrls {
                id: summary.session_id.clone(),
            })?;
            if let Some(scan) = scan.filter(|s| s.generation == summary.generation) {
                summary.urls = scan.urls;
                summary.running = scan.running;
            }
        }
        Ok(summaries)
    })
    .await
}
/// Only the native broker can open preview URLs, under a separate permission.
#[tauri::command]
async fn extension_url_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    extension_id: String,
    project_id: String,
    url: String,
) -> CmdResult<()> {
    main_only(&window)?;
    state.project(&project_id)?;
    let url = extensions::preview_url(&url).map_err(err)?;
    let extensions = state.extensions.clone();
    blocking(move || {
        extensions
            .get()
            .allowed(&extension_id, Some("urls:open"))
            .map_err(err)?;
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
    })
    .await
}

#[cfg(test)]
mod window_label_tests {
    /// Pinned in `src/lib/windows.test.ts` too: pop-out events are routed by this label.
    #[test]
    fn component_window_labels_match_the_frontend() {
        assert_eq!(
            super::component_window_label("p-1", "web"),
            "component-5b-22-70-2d-31-22-2c-22-77-65-62-22-5d"
        );
        assert_eq!(
            super::component_window_label("p", "a\"/ü😀"),
            "component-5b-22-70-22-2c-22-61-5c-22-2f-fc-1f600-22-5d"
        );
    }
}
