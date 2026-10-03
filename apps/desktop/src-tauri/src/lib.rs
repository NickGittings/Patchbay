//! Thin Tauri adapter over patchbay-core: commands in, terminal events out.

use patchbay_core::devices::{self, DeviceManifest};
use patchbay_core::files::{self, DirEntry};
use patchbay_core::policy::AllowAll;
use patchbay_core::pty::{PtyManager, Snapshot};
use patchbay_core::{EventSink, Project, TerminalEvent, context, detect, git};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[cfg(debug_assertions)]
mod smoke;

const TERMINAL_EVENT: &str = "patchbay://terminal";
/// Emitted with a window's label when it closes, so the others can pick a new active window.
const WINDOW_CLOSED_EVENT: &str = "patchbay://window-closed";

#[derive(Default)]
struct AppState {
    pty: Arc<PtyManager>,
    /// Folders file commands may read: the open project's root first, then the
    /// folders of components outside it (sibling repos). Set from projects the
    /// backend loaded or detected, never from a list sent by the webview, so file
    /// commands can't reach the rest of the disk.
    roots: Mutex<Vec<PathBuf>>,
}

impl AppState {
    fn roots(&self) -> Vec<PathBuf> {
        self.roots.lock().unwrap().clone()
    }

    fn set_roots(&self, project: &Project) {
        let mut roots = vec![PathBuf::from(&project.root)];
        roots.extend(project.external_dirs());
        *self.roots.lock().unwrap() = roots;
    }

    fn resolve(&self, path: &str) -> CmdResult<PathBuf> {
        files::resolve(&self.roots(), Path::new(path)).map_err(err)
    }
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
    state.set_roots(&opened.project);
    Ok(opened)
}

#[derive(Serialize)]
struct Rescanned {
    project: Project,
    added: usize,
}

#[tauri::command]
async fn rescan_project(state: State<'_, AppState>, mut project: Project) -> CmdResult<Rescanned> {
    let added = detect::rescan(&mut project).map_err(err)?;
    state.set_roots(&project);
    Ok(Rescanned { project, added })
}

/// Ask for a folder (a repo beside the project, or a subfolder detection
/// missed) and add its components. The picker runs here rather than in the
/// webview so only folders the user chose become readable. `None` if cancelled.
#[tauri::command]
async fn add_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    mut project: Project,
) -> CmdResult<Option<Rescanned>> {
    let root = PathBuf::from(&project.root);
    let mut dialog = app.dialog().file().set_title("Add a repo or folder");
    if let Some(parent) = root.parent() {
        dialog = dialog.set_directory(parent);
    }
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = picked.into_path().map_err(err)?;
    let found = detect::detect_folder(&project, &dir).map_err(err)?;
    let added = detect::merge_new(&mut project, found);
    state.set_roots(&project);
    Ok(Some(Rescanned { project, added }))
}

#[tauri::command]
fn save_project(project: Project) -> CmdResult<String> {
    project.save().map(|p| p.display().to_string()).map_err(err)
}

#[tauri::command]
fn component_context(project: Project, component_id: String) -> String {
    context::component_context(&project, &component_id)
}

#[tauri::command]
async fn git_status(project: Project) -> git::GitStatus {
    git::status(&project)
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
