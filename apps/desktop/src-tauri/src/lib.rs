//! Thin Tauri adapter over patchbay-core: commands in, terminal events out.

use patchbay_core::devices::{self, DeviceManifest};
use patchbay_core::files::{self, DirEntry};
use patchbay_core::policy::AllowAll;
use patchbay_core::pty::{PtyManager, Snapshot};
use patchbay_core::{EventSink, Project, TerminalEvent, context, detect, git};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

#[cfg(debug_assertions)]
mod smoke;

const TERMINAL_EVENT: &str = "patchbay://terminal";

#[derive(Default)]
struct AppState {
    pty: Arc<PtyManager>,
}

struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn emit(&self, event: TerminalEvent) {
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
async fn open_project(root: String) -> CmdResult<Opened> {
    let root = PathBuf::from(root).canonicalize().map_err(err)?;
    if let Some(project) = Project::load(&root).map_err(err)? {
        return Ok(Opened {
            project,
            detected: false,
        });
    }
    Ok(Opened {
        project: detect::detect(&root).map_err(err)?,
        detected: true,
    })
}

#[derive(Serialize)]
struct Rescanned {
    project: Project,
    added: usize,
}

#[tauri::command]
async fn rescan_project(mut project: Project) -> CmdResult<Rescanned> {
    let detected = detect::detect(&PathBuf::from(&project.root)).map_err(err)?;
    let added = detect::merge_new(&mut project, detected);
    Ok(Rescanned { project, added })
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
async fn git_changes(root: String, components: Vec<(String, String)>) -> HashMap<String, usize> {
    git::changes_by_component(&PathBuf::from(root), &components)
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

#[tauri::command]
async fn list_dir(root: String, path: String) -> CmdResult<Vec<DirEntry>> {
    files::list_dir(&PathBuf::from(root), &PathBuf::from(path)).map_err(err)
}

/// Returns the generation floor: events at or below it belong to the old project.
#[tauri::command]
fn terminal_reset(state: State<AppState>) -> u64 {
    state.pty.reset()
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
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                for (label, popout) in window.app_handle().webview_windows() {
                    if label.starts_with("component-") {
                        let _ = popout.close();
                    }
                }
            }
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            rescan_project,
            save_project,
            component_context,
            git_changes,
            list_devices,
            save_device,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            terminal_reset,
            terminal_snapshot,
            list_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Patchbay")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<AppState>().pty.kill_all();
            }
        });
}
