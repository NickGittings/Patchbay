//! Native Windows chrome shared by the main window and component pop-outs.
use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

pub fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .decorations(true)
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .closable(true)
}

/// Check the runtime's effective flags after creation or geometry restoration.
/// These flags cannot establish whether Windows actually painted working buttons;
/// that still requires a desktop check.
pub fn verify<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let before = settings(window)?;
    eprintln!(
        "Windows controls ({}): decorations={}, resizable={}, minimizable={}, maximizable={}, closable={}",
        window.label(),
        before[0],
        before[1],
        before[2],
        before[3],
        before[4]
    );
    if before.iter().all(|enabled| *enabled) {
        return Ok(());
    }
    // Repair only unexpected flags, preserving maximized state and saved geometry.
    if !before[0] {
        window.set_decorations(true)?;
    }
    if !before[1] {
        window.set_resizable(true)?;
    }
    if !before[2] {
        window.set_minimizable(true)?;
    }
    if !before[3] {
        window.set_maximizable(true)?;
    }
    if !before[4] {
        window.set_closable(true)?;
    }
    if settings(window)?.iter().all(|enabled| *enabled) {
        eprintln!(
            "Windows controls ({}): repaired runtime flags",
            window.label()
        );
        Ok(())
    } else {
        Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "Native Windows controls remain disabled for {}",
            window.label()
        )))
    }
}

fn settings<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<[bool; 5]> {
    Ok([
        window.is_decorated()?,
        window.is_resizable()?,
        window.is_minimizable()?,
        window.is_maximizable()?,
        window.is_closable()?,
    ])
}
