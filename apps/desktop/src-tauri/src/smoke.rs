//! Debug-only smoke test hook, compiled out of release builds.
//!
//! When `PATCHBAY_SMOKE_SCRIPT` is set, the script is evaluated in every window
//! after it loads, and the app exits once the script reports `PASS…` (0) or
//! `FAIL…` (1) on [`REPORT_EVENT`]. `npm run smoke` drives this.

use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{Builder, Emitter, Listener, Manager, Wry};

const REPORT_EVENT: &str = "patchbay://smoke-report";
/// The launcher's answers to reports, one line each, read from stdin in screenshot runs.
const ACK_EVENT: &str = "patchbay://smoke-ack";
/// The full Chat flow (`simple`) runs about 90s with its fake agents' turns.
const TIMEOUT: Duration = Duration::from_secs(120);
/// Screenshot runs stage much more and may wait on a macOS permission prompt.
const FOREGROUND_TIMEOUT: Duration = Duration::from_secs(600);

pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
    let Ok(path) = std::env::var("PATCHBAY_SMOKE_SCRIPT") else {
        return builder;
    };
    let script = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("PATCHBAY_SMOKE: FAIL cannot read {path}: {e}");
            std::process::exit(1);
        }
    };
    // Don't activate at launch, before `setup` can make the app prohibited.
    #[cfg(target_os = "macos")]
    let builder = if foreground() {
        builder
    } else {
        builder.activate_ignoring_other_apps(false)
    };

    builder.on_page_load(move |webview, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = webview.eval(&script);
        }
    })
}

/// Set by `scripts/readme-shots.mjs`, whose captures need the window on screen, and which answers
/// reports on the app's stdin.
fn foreground() -> bool {
    std::env::var_os("PATCHBAY_SMOKE_FOREGROUND").is_some()
}

/// A root configured by the test process, never by an IPC caller.
pub fn project_root(second: bool) -> Option<std::path::PathBuf> {
    std::env::var_os("PATCHBAY_SMOKE_SCRIPT")?;
    std::env::var_os(if second {
        "PATCHBAY_SMOKE_ROOT_2"
    } else {
        "PATCHBAY_SMOKE_ROOT"
    })
    .map(std::path::PathBuf::from)
}

/// Smoke windows run in the background (see [`setup`]), where WebKit would otherwise throttle
/// or suspend their timers. Applied to the main window and every pop-out.
pub fn window<'a>(
    builder: tauri::WebviewWindowBuilder<'a, Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, Wry, tauri::AppHandle> {
    if std::env::var_os("PATCHBAY_SMOKE_SCRIPT").is_none() {
        return builder;
    }
    builder
        .initialization_script("window.__patchbaySmokeRun = true;")
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
}

/// Prepares the app for a smoke run; does nothing outside one.
///
/// # Panics
///
/// Panics if the smoke-only window resize capability can't be added.
pub fn setup(app: &mut tauri::App) {
    if std::env::var_os("PATCHBAY_SMOKE_SCRIPT").is_none() {
        return;
    }
    // Only smoke runs may resize the main window through the dev-only frontend hooks.
    app.add_capability(
        r#"{"identifier":"smoke-resize","windows":["main"],"permissions":["core:window:allow-set-size"]}"#,
    )
    .expect("smoke resize capability");
    // Run in the background: wry activates the app for every new top-level webview, which
    // would take focus from whatever the user is doing, but a prohibited app can't activate.
    // Screenshot runs need a window on screen, where WebKit paints terminals.
    #[cfg(target_os = "macos")]
    if !foreground() {
        app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    }

    let handle = app.handle().clone();
    app.listen(REPORT_EVENT, move |event| {
        let message: String = serde_json::from_str(event.payload()).unwrap_or_default();
        eprintln!("PATCHBAY_SMOKE: {message}");
        if message.starts_with("PASS") {
            handle.exit(0);
        } else if message.starts_with("FAIL") {
            handle.exit(1);
        }
    });
    if foreground() {
        let handle = app.handle().clone();
        std::thread::spawn(move || forward_acks(&handle));
    }
    let timeout = if foreground() {
        FOREGROUND_TIMEOUT
    } else {
        TIMEOUT
    };
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        eprintln!(
            "PATCHBAY_SMOKE: FAIL timed out after {}s",
            timeout.as_secs()
        );
        handle.exit(1);
    });
}

/// Emits each line the launcher writes to stdin on [`ACK_EVENT`], so a script can wait for the
/// launcher to act on a report (`scripts/readme-shots.mjs` captures the window).
fn forward_acks(handle: &tauri::AppHandle) {
    use std::io::BufRead;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { return };
        let _ = handle.emit(ACK_EVENT, line.trim_end());
    }
}
