//! Windows window flags: custom chrome for main, native chrome for component pop-outs.
use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

pub fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    decorations: bool,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .decorations(decorations)
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
    let expected = [window.label() != "main", true, true, true, true];
    eprintln!(
        "Windows controls ({}): decorations={}, resizable={}, minimizable={}, maximizable={}, closable={}",
        window.label(),
        before[0],
        before[1],
        before[2],
        before[3],
        before[4]
    );
    if before == expected {
        return Ok(());
    }
    // Repair only unexpected flags, preserving maximized state and saved geometry.
    if before[0] != expected[0] {
        window.set_decorations(expected[0])?;
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
    if settings(window)? == expected {
        eprintln!(
            "Windows controls ({}): repaired runtime flags",
            window.label()
        );
        Ok(())
    } else {
        Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "Windows control flags remain incorrect for {}",
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
