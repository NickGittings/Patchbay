//! Desktop lifecycle and event bridge. Only the helper owns PTYs.
use patchbay_core::pty::SessionSpec;
use patchbay_core::session::{self, Batch, Client, Metadata, Record, Request};
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct Bridge {
    client: Mutex<Option<Client>>,
    stopped: AtomicBool,
}
impl Bridge {
    pub fn call<T: DeserializeOwned>(&self, request: Request) -> Result<T, String> {
        let mut slot = self.client.lock().unwrap();
        let client = slot.as_mut().ok_or(
            "Disconnected from session service. Wait for reconciliation before trying again.",
        )?;
        client.call(request).map_err(|e| e.to_string())
    }
    pub fn start(
        &self,
        spec: SessionSpec,
        metadata: Metadata,
        request_id: String,
    ) -> Result<String, String> {
        self.call(Request::Start {
            request_id,
            metadata: Box::new(metadata),
            spec,
        })
    }
    pub fn status(&self) -> serde_json::Value {
        let slot = self.client.lock().unwrap();
        serde_json::json!({"connected": slot.is_some(), "instanceId": slot.as_ref().map(|c| c.instance.clone()).unwrap_or_default()})
    }
    pub fn disconnect(&self) {
        self.stopped.store(true, Ordering::Release);
        self.client.lock().unwrap().take();
    }
    pub fn run(self: &Arc<Self>, app: AppHandle) {
        let bridge = self.clone();
        std::thread::spawn(move || {
            let helper = helper();
            let mut after = 0;
            let mut delay = 100;
            let mut layout_changed = None;
            while !bridge.stopped.load(Ordering::Acquire) {
                if app
                    .state::<crate::AppState>()
                    .layout_dirty
                    .swap(false, Ordering::AcqRel)
                {
                    layout_changed = Some(std::time::Instant::now());
                }
                if layout_changed.is_some_and(|at: std::time::Instant| {
                    at.elapsed() >= std::time::Duration::from_millis(500)
                }) {
                    crate::layout::save(&app);
                    layout_changed = None;
                }
                if bridge.client.lock().unwrap().is_none() {
                    let connection =
                        session::runtime_dir().and_then(|dir| Client::ensure(&dir, &helper));
                    match connection {
                        Ok(mut client) => {
                            let instance = client.instance.clone();
                            // Subscribe to the event cursor before reconciling snapshots.
                            let baseline: Result<Batch, _> =
                                client.call(Request::Poll { after: 0 });
                            let records: Result<Vec<Record>, _> = client.call(Request::List);
                            if let (Ok(batch), Ok(records)) = (baseline, records) {
                                after = batch.end;
                                *bridge.client.lock().unwrap() = Some(client);
                                let _ = app.emit("patchbay://service", serde_json::json!({"connected": true, "instanceId": instance, "records": records}));
                                delay = 100;
                            }
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "patchbay://service",
                                serde_json::json!({"connected": false, "error": e.to_string()}),
                            );
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                            delay = (delay * 2).min(5000);
                            continue;
                        }
                    }
                }
                match bridge.call::<Batch>(Request::Poll { after }) {
                    Ok(batch) => {
                        if batch.gap {
                            if let Ok(records) = bridge.call::<Vec<Record>>(Request::List) {
                                after = batch.end;
                                let _ = app.emit("patchbay://service", serde_json::json!({"connected": true, "instanceId": batch.instance_id, "records": records}));
                            }
                        } else {
                            for envelope in batch.events {
                                after = envelope.sequence;
                                // Explicit metadata routes events to each project/component window.
                                let _ = app.emit("patchbay://terminal", envelope);
                            }
                        }
                    }
                    Err(e) => {
                        bridge.client.lock().unwrap().take();
                        let _ = app.emit(
                            "patchbay://service",
                            serde_json::json!({"connected": false, "error": e}),
                        );
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
    }
}
fn helper() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_default()
        .with_file_name(if cfg!(windows) {
            "patchbay-sessiond.exe"
        } else {
            "patchbay-sessiond"
        })
}
pub fn metadata(
    project_id: &str,
    project: &patchbay_core::Project,
    component: &str,
    terminal: &patchbay_core::TerminalSpec,
) -> Metadata {
    Metadata {
        project_id: project_id.into(),
        project_name: project.name.clone(),
        project_root: project.root.clone(),
        component_id: component.into(),
        terminal_id: terminal.id.clone(),
        name: terminal.name.clone(),
        kind: terminal.kind,
        adapter: terminal
            .adapter
            .or_else(|| patchbay_core::adapters::Adapter::default_for(&terminal.command)),
        conversation_id: None,
        extension_id: None,
        command_id: None,
        key: None,
        command: terminal.command.clone(),
    }
}
