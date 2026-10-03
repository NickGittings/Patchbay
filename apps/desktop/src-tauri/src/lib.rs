//! Thin Tauri adapter over patchbay-core: commands in, terminal events out.

use patchbay_core::devices::{self, DeviceManifest};
use patchbay_core::files::{self, DirEntry};
use patchbay_core::model;
use patchbay_core::policy::AllowAll;
use patchbay_core::pty::{PtyManager, Snapshot};
use patchbay_core::{EventSink, Project, TerminalEvent, context, detect, git};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[cfg(debug_assertions)]
mod smoke;

const TERMINAL_EVENT: &str = "patchbay://terminal";
/// Emitted with a window's label when it closes, so the others can pick a new active window.
const WINDOW_CLOSED_EVENT: &str = "patchbay://window-closed";

#[derive(Default)]
struct AppState {
    pty: Arc<PtyManager>,
    access: Mutex<Access>,
}

/// Which folders file commands may read. Only the backend widens this: the root
/// comes from `open_project`, and folders outside it are granted only when they
/// come from a project the backend loaded or detected, or from a folder picker
/// the backend ran. The webview's map can narrow the readable set (a deleted
/// component's folder stops being readable) but never extend it. All paths
/// here are canonical, so a symlink can't lead a granted path elsewhere.
#[derive(Default)]
struct Access {
    /// The open project's root (canonical).
    root: Option<PathBuf>,
    /// External folders the user vouched for; kept until another project opens.
    granted: Vec<PathBuf>,
    /// `root`, then the external component folders on the map within `granted`.
    roots: Vec<PathBuf>,
}

impl Access {
    /// `project.root` must be canonical. External folders from a loaded
    /// `patchbay.json` are granted only if they exist and don't contain the
    /// project (a committed `../../..` must not expose the whole disk).
    fn open(&mut self, project: &Project) {
        let root = PathBuf::from(&project.root);
        self.granted = project
            .external_dirs()
            .iter()
            .filter_map(|d| d.canonicalize().ok())
            .filter(|d| model::check_component_dir(&root, d).is_ok())
            .collect();
        self.root = Some(root);
        self.sync(project.components.iter().map(|c| c.path.as_str()));
    }

    /// `dir` must be canonical and not contain the project.
    fn grant(&mut self, dir: PathBuf) {
        self.granted.push(dir);
    }

    fn is_granted(&self, dir: &Path) -> bool {
        self.granted.iter().any(|g| dir.starts_with(g))
    }

    /// The canonical folder of a component path, if it may be read: inside the
    /// root, or within a granted folder once symlinks are resolved.
    fn readable(&self, path: &str) -> Option<PathBuf> {
        let root = self.root.as_ref()?;
        let dir = root.join(path).canonicalize().ok()?;
        (dir.starts_with(root) || self.is_granted(&dir)).then_some(dir)
    }

    /// Recompute the readable roots from the component paths now on the map.
    fn sync<'a>(&mut self, paths: impl IntoIterator<Item = &'a str>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let mut roots = vec![root.clone()];
        for path in paths {
            if let Some(dir) = self.readable(path)
                && !dir.starts_with(&root)
                && !roots.contains(&dir)
            {
                roots.push(dir);
            }
        }
        self.roots = roots;
    }

    /// Replace the webview's idea of the root with the one the backend opened.
    fn trust(&self, project: &mut Project) -> CmdResult<PathBuf> {
        let root = self.root.clone().ok_or("No project is open")?;
        project.root = root.display().to_string();
        Ok(root)
    }
}

impl AppState {
    fn access(&self) -> std::sync::MutexGuard<'_, Access> {
        self.access.lock().unwrap()
    }

    fn roots(&self) -> Vec<PathBuf> {
        self.access().roots.clone()
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    project: Project,
    /// True when no `patchbay.json` existed and the map was auto-detected.
    detected: bool,
}

#[tauri::command]
async fn open_project(state: State<'_, AppState>, root: String) -> CmdResult<Opened> {
    let root = PathBuf::from(root).canonicalize().map_err(err)?;
    let opened = if let Some(project) = Project::load(&root).map_err(err)? {
        Opened {
            project,
            detected: false,
        }
    } else {
        Opened {
            project: detect::detect(&root).map_err(err)?,
            detected: true,
        }
    };
    state.access().open(&opened.project);
    Ok(opened)
}

#[derive(Serialize)]
struct Rescanned {
    project: Project,
    added: usize,
}

/// Rescan the open root plus the external folders on the map the user added.
#[tauri::command]
async fn rescan_project(state: State<'_, AppState>, mut project: Project) -> CmdResult<Rescanned> {
    let externals: Vec<PathBuf> = {
        let access = state.access();
        access.trust(&mut project)?;
        project
            .external_dirs()
            .into_iter()
            .filter_map(|d| d.canonicalize().ok())
            .filter(|d| access.is_granted(d))
            .collect()
    };
    let added = detect::rescan(&mut project, &externals).map_err(err)?;
    state
        .access()
        .sync(project.components.iter().map(|c| c.path.as_str()));
    Ok(Rescanned { project, added })
}

/// Ask for a folder (a repo beside the project, or a subfolder detection
/// missed) and add its components. The picker runs here rather than in the
/// webview so only folders the user chose become readable. `None` if cancelled.
#[tauri::command]
async fn add_folder(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<Option<Rescanned>> {
    let root = state.access().trust(&mut project)?;
    let Some(dir) = pick_folder(&window, "Add a repo or folder", root.parent())? else {
        return Ok(None);
    };
    let found = detect::detect_folder(&project, &dir).map_err(err)?;
    let added = detect::merge_new(&mut project, found);
    let mut access = state.access();
    access.grant(dir.canonicalize().map_err(err)?);
    access.sync(project.components.iter().map(|c| c.path.as_str()));
    Ok(Some(Rescanned { project, added }))
}

/// Pick a component's folder (inside the project or beside it) and return it
/// relative to the root. `None` if cancelled.
#[tauri::command]
async fn pick_component_folder(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let root = state.access().root.clone().ok_or("No project is open")?;
    let Some(dir) = pick_folder(&window, "Component folder", Some(&root))? else {
        return Ok(None);
    };
    let dir = dir.canonicalize().map_err(err)?;
    model::check_component_dir(&root, &dir).map_err(err)?;
    if !dir.starts_with(&root) {
        state.access().grant(dir.clone());
    }
    Ok(Some(model::relative_path(&root, &dir)))
}

/// Narrow the readable folders to the component paths now on the map.
#[tauri::command]
fn sync_roots(state: State<AppState>, paths: Vec<String>) {
    state.access().sync(paths.iter().map(String::as_str));
}

#[tauri::command]
fn save_project(project: Project) -> CmdResult<String> {
    project.save().map(|p| p.display().to_string()).map_err(err)
}

#[tauri::command]
fn component_context(project: Project, component_id: String) -> String {
    context::component_context(&project, &component_id)
}

#[derive(Deserialize)]
struct ComponentPath {
    id: String,
    path: String,
}

/// Takes only ids and folders, since it is polled every few seconds. Folders
/// the backend hasn't granted are left out, so the webview can't run git
/// anywhere else on disk.
#[tauri::command]
async fn git_status(
    state: State<'_, AppState>,
    components: Vec<ComponentPath>,
) -> CmdResult<git::GitStatus> {
    let (root, components) = {
        let access = state.access();
        let Some(root) = access.root.clone() else {
            return Ok(git::GitStatus::default());
        };
        let components: Vec<(String, PathBuf)> = components
            .into_iter()
            .filter_map(|c| Some((c.id, access.readable(&c.path)?)))
            .collect();
        (root, components)
    };
    Ok(git::status(&root, &components))
}

#[tauri::command]
fn list_devices() -> Vec<DeviceManifest> {
    devices::load_devices()
}

#[tauri::command]
fn save_device(device: DeviceManifest) -> CmdResult<String> {
    devices::save_device(&device)
        .map(|p| p.display().to_string())
        .map_err(err)
}

#[tauri::command]
fn terminal_start(
    app: AppHandle,
    state: State<AppState>,
    project: Project,
    component_id: String,
    terminal_id: String,
) -> CmdResult<String> {
    let spec =
        context::session_spec(&project, &component_id, &terminal_id, &AllowAll).map_err(err)?;
    let id = spec.id.clone();
    state
        .pty
        .spawn(spec, Arc::new(TauriSink(app)))
        .map_err(err)?;
    Ok(id)
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
    Ok(state.pty.reset())
}

/// # Panics
/// Panics if the Tauri runtime fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = smoke::install(builder);
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| match event {
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
        .invoke_handler(tauri::generate_handler![
            open_project,
            rescan_project,
            add_folder,
            pick_component_folder,
            sync_roots,
            save_project,
            component_context,
            git_status,
            list_devices,
            save_device,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            terminal_reset,
            terminal_snapshot,
            list_dir,
            reveal_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Patchbay")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<AppState>().pty.reset();
            }
        });
}
