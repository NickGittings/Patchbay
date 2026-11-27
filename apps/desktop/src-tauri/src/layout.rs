//! Window arrangements are local state; user closes remove pop-outs, app quit preserves them.
use crate::{AppState, CmdResult, workspace_path};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, Window, WindowEvent};

pub fn save(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.workspace_ready.load(Ordering::Acquire) {
        return;
    }
    let document = state.workspace.lock().unwrap();
    if let Ok(path) = workspace_path()
        && let Err(e) = document.save(&path)
    {
        eprintln!("Window arrangement could not be saved: {e}");
    }
}
pub fn event(window: &Window, event: &WindowEvent) {
    let state = window.app_handle().state::<AppState>();
    if matches!(event, WindowEvent::CloseRequested { .. }) && window.label() == "main" {
        state.quitting.store(true, Ordering::Release);
    }
    if !state.workspace_ready.load(Ordering::Acquire) {
        return;
    }
    let mut document = state.workspace.lock().unwrap();
    if !document.windows.is_object() {
        document.windows = json!({});
    }
    if matches!(event, WindowEvent::Destroyed) {
        if window.label() != "main" && !state.quitting.load(Ordering::Acquire) {
            document
                .windows
                .as_object_mut()
                .unwrap()
                .remove(window.label());
        }
    } else if matches!(
        event,
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
    ) {
        let entry = document
            .windows
            .as_object_mut()
            .unwrap()
            .entry(window.label())
            .or_insert_with(|| json!({}));
        let scale = window.scale_factor().unwrap_or(1.0);
        if let Ok(position) = window.outer_position() {
            entry["x"] = json!(f64::from(position.x) / scale);
            entry["y"] = json!(f64::from(position.y) / scale);
        }
        if let Ok(size) = window.inner_size() {
            entry["width"] = json!(f64::from(size.width) / scale);
            entry["height"] = json!(f64::from(size.height) / scale);
        }
        entry["maximized"] = json!(window.is_maximized().unwrap_or(false));
    } else {
        return;
    }
    state.layout_dirty.store(true, Ordering::Release);
}

/// Fits saved window geometry onto one of `monitors` (the one holding its origin, else the first).
///
/// # Errors
/// Fails when no monitor is available.
pub fn clamp_to_monitors(
    monitors: &[tauri::Monitor],
    geometry: &Value,
    main: bool,
) -> CmdResult<Value> {
    let finite = |key: &str| {
        geometry
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    let requested_x = finite("x").unwrap_or(80.0);
    let requested_y = finite("y").unwrap_or(80.0);
    let contains = |m: &&tauri::Monitor, x: f64, y: f64| {
        let scale = m.scale_factor();
        let p = m.position();
        let size = m.size();
        x >= f64::from(p.x) / scale
            && x < f64::from(p.x) / scale + f64::from(size.width) / scale
            && y >= f64::from(p.y) / scale
            && y < f64::from(p.y) / scale + f64::from(size.height) / scale
    };
    // By its centre first: a window maximized on Windows sits a few pixels outside its display,
    // so its origin alone would pick the primary one.
    let centre_x = requested_x + finite("width").unwrap_or(0.0) / 2.0;
    let centre_y = requested_y + finite("height").unwrap_or(0.0) / 2.0;
    let monitor = monitors
        .iter()
        .find(|m| contains(m, centre_x, centre_y))
        .or_else(|| {
            monitors
                .iter()
                .find(|m| contains(m, requested_x, requested_y))
        })
        .or_else(|| monitors.first())
        .ok_or("No displays available")?;
    let scale = monitor.scale_factor();
    let left = f64::from(monitor.position().x) / scale;
    let top = f64::from(monitor.position().y) / scale;
    let sw = f64::from(monitor.size().width) / scale;
    let sh = f64::from(monitor.size().height) / scale;
    let width = finite("width")
        .unwrap_or(if main { 1440.0 } else { 1100.0 })
        .clamp(
            if main { 900.0 } else { 600.0 },
            sw.max(if main { 900.0 } else { 600.0 }),
        );
    let height = finite("height")
        .unwrap_or(if main { 900.0 } else { 700.0 })
        .clamp(
            if main { 600.0 } else { 400.0 },
            sh.max(if main { 600.0 } else { 400.0 }),
        );
    Ok(
        json!({ "x": requested_x.clamp(left, (left + sw - width).max(left)), "y": requested_y.clamp(top, (top + sh - height).max(top)), "width": width, "height": height, "maximized": geometry.get("maximized").and_then(Value::as_bool).unwrap_or(false) }),
    )
}
/// The main window's saved bounds `(x, y, width, height)`, fitted onto a connected display, for
/// building the window there. Every launch still opens maximized (`tauri.conf.json`); these pick
/// the display and the size it returns to when un-maximized. None without a saved arrangement.
pub fn saved_main(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let document = patchbay_core::workspace::Workspace::load(&workspace_path().ok()?).ok()?;
    let saved = document.windows.get("main")?;
    let monitors = app.available_monitors().ok()?;
    let g = clamp_to_monitors(&monitors, saved, true).ok()?;
    Some((
        g["x"].as_f64()?,
        g["y"].as_f64()?,
        g["width"].as_f64()?,
        g["height"].as_f64()?,
    ))
}
