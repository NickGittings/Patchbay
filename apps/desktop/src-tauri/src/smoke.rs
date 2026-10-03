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
    let root = std::env::var("PATCHBAY_SMOKE_ROOT").unwrap_or_default();
    let script = format!(
        "window.__PATCHBAY_SMOKE_ROOT = {};\n{script}",
        serde_json::Value::String(root)
    );

    builder
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.eval(&script);
            }
        })
        .setup(|app| {
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
            Ok(())
        })
}
