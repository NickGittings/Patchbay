//! Debug-only smoke test hook, compiled out of release builds.
//!
//! When `PATCHBAY_SMOKE_SCRIPT` is set, the script is evaluated in every window
//! after it loads, and the app exits once the script reports `PASS…` (0) or
//! `FAIL…` (1) on [`REPORT_EVENT`]. `npm run smoke` drives this.

use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{Builder, Listener, Wry};

const REPORT_EVENT: &str = "patchbay://smoke-report";
const TIMEOUT: Duration = Duration::from_secs(90);

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
    let builder = builder.activate_ignoring_other_apps(false);

    let flag = tauri::plugin::Builder::<Wry>::new("patchbay-smoke")
        .js_init_script("window.__PATCHBAY_SMOKE__ = true")
        .build();

    builder.plugin(flag).on_page_load(move |webview, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            let _ = webview.eval(&script);
        }
    })
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
/// or suspend their timers. Pop-outs read `__PATCHBAY_SMOKE__` (set by [`install`]) to do the same.
pub fn main_window<'a>(
    builder: tauri::WebviewWindowBuilder<'a, Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, Wry, tauri::AppHandle> {
    if std::env::var_os("PATCHBAY_SMOKE_SCRIPT").is_none() {
        return builder;
    }
    builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
}

pub fn setup(app: &mut tauri::App) {
    if std::env::var_os("PATCHBAY_SMOKE_SCRIPT").is_none() {
        return;
    }
    // Run in the background: wry activates the app for every new top-level webview, which
    // would take focus from whatever the user is doing, but a prohibited app can't activate.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);

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
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(TIMEOUT);
        eprintln!(
            "PATCHBAY_SMOKE: FAIL timed out after {}s",
            TIMEOUT.as_secs()
        );
        handle.exit(1);
    });
}
