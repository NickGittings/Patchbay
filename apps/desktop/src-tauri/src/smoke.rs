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
/// The full Chat flow (`simple`) runs about two minutes with its fake agents' turns; failing
/// checks report sooner through their own waits, so this only bounds a hung run.
const TIMEOUT: Duration = Duration::from_secs(240);
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
    let builder = builder
        .initialization_script("window.__patchbaySmokeRun = true;")
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    // Shown by [`conceal`] once it can't be seen, so it never flashes on screen.
    #[cfg(target_os = "macos")]
    let builder = if foreground() {
        builder
    } else {
        builder.visible(false)
    };
    // Every instance of the app otherwise shares one WebKit store, so parallel runs (and the
    // developer's own `tauri dev`) would see each other's localStorage. Keyed by the run's state
    // dir, which the launchers create per run, so an app restarted within a run keeps its store.
    let Some(state) = std::env::var_os("PATCHBAY_STATE_DIR") else {
        return builder;
    };
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store_identifier(&state));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.data_directory(std::path::PathBuf::from(state).join("webview"));
    builder
}

/// Shows a window built through [`window`] without putting anything on the user's screen: fully
/// transparent and click-through. It stays ordered in rather than hidden or off-screen, because
/// WebKit would then report `document.visibilityState` as hidden and terminals only attach while
/// visible. Screenshot runs keep a regular window; does nothing outside a smoke run.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn conceal(window: &tauri::WebviewWindow) {
    if std::env::var_os("PATCHBAY_SMOKE_SCRIPT").is_none() || foreground() {
        return;
    }
    let _ = window.set_ignore_cursor_events(true);
    if let Ok(ns_window) = window.ns_window() {
        // SAFETY: `ns_window` is the live `NSWindow` of a window just built on the main thread
        // (macOS builds webview windows there); `setAlphaValue:` takes a `CGFloat` (f64).
        if let Some(ns_window) = unsafe { ns_window.cast::<objc2::runtime::AnyObject>().as_ref() } {
            let _: () = unsafe { objc2::msg_send![ns_window, setAlphaValue: 0.0_f64] };
        }
    }
    let _ = window.show();
}

#[cfg(not(target_os = "macos"))]
pub fn conceal(_window: &tauri::WebviewWindow) {}

/// A UUID-shaped identifier (version 4 bits set) stable for one state dir.
#[cfg(target_os = "macos")]
fn store_identifier(state: &std::ffi::OsStr) -> [u8; 16] {
    use std::hash::{Hash, Hasher};
    let mut id = [0u8; 16];
    for (seed, half) in id.chunks_mut(8).enumerate() {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (seed, state).hash(&mut hasher);
        half.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
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
