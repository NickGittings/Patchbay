//! Desktop lifecycle and event bridge. Only the helper owns PTYs.
use patchbay_core::pty::SessionSpec;
use patchbay_core::session::{
    self, Batch, Client, Envelope, Metadata, POLL_LIMIT, Record, Request,
};
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Sender, channel};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Terminal events: every one to the main window on this channel, and each to
/// its component's pop-out on `patchbay://terminal/<label>`. Mirrored in `ipc.ts`.
pub const TERMINAL_EVENT: &str = "patchbay://terminal";
const DISCONNECTED: &str =
    "Disconnected from session service. Wait for reconciliation before trying again.";
/// Idle pooled connections; the service drops connections idle for 120s.
const POOL_SIZE: usize = 4;
const POOL_IDLE: Duration = Duration::from_secs(60);

/// Commands run on pooled connections in parallel (the service answers each
/// connection on its own thread), so a slow start, stop or resume never holds up
/// typing or polling. All connections share one client name, and so one terminal
/// authority. Keystrokes and resizes go through one writer thread, in order.
pub struct Bridge {
    name: String,
    /// The service instance the poller is connected to; `None` while disconnected.
    instance: Mutex<Option<String>>,
    pool: Mutex<Vec<(Client, Instant)>>,
    writes: Mutex<Option<Sender<Request>>>,
    /// Session id → the label of the pop-out that shows it.
    routes: Mutex<HashMap<String, String>>,
    stopped: AtomicBool,
}
impl Default for Bridge {
    fn default() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        Self {
            name: format!("desktop-{}-{nanos:x}", std::process::id()),
            instance: Mutex::default(),
            pool: Mutex::default(),
            writes: Mutex::default(),
            routes: Mutex::default(),
            stopped: AtomicBool::new(false),
        }
    }
}
impl Bridge {
    /// Run one request on an idle pooled connection, or a new one.
    pub fn call<T: DeserializeOwned>(&self, request: Request) -> Result<T, String> {
        self.call_reporting(request).map_err(|(e, _)| e)
    }
    /// Like `call`; an error also says whether the service may have handled the
    /// request anyway (its reply was lost), rather than certainly not running it.
    ///
    /// # Errors
    /// Fails when the service is disconnected, refuses the request or its reply is lost.
    pub fn call_reporting<T: DeserializeOwned>(
        &self,
        request: Request,
    ) -> Result<T, (String, bool)> {
        session::with_pending_briefing(request, |request| {
            let instance = self
                .instance
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| (DISCONNECTED.to_string(), false))?;
            let mut client = self.take(&instance).map_err(|e| (e, false))?;
            let result = client
                .call(request)
                .map_err(|e| (e.to_string(), client.is_broken()));
            if !client.is_broken() {
                let mut pool = self.pool.lock().unwrap();
                if pool.len() < POOL_SIZE
                    && self.instance.lock().unwrap().as_ref() == Some(&instance)
                {
                    pool.push((client, Instant::now()));
                }
            }
            result
        })
    }
    fn take(&self, instance: &str) -> Result<Client, String> {
        {
            let mut pool = self.pool.lock().unwrap();
            while let Some((client, used)) = pool.pop() {
                if used.elapsed() < POOL_IDLE {
                    return Ok(client);
                }
            }
        }
        let dir = session::runtime_dir().map_err(|e| e.to_string())?;
        let client = Client::connect_as(&dir, Some(&self.name)).map_err(|e| e.to_string())?;
        // A restarted service is reconciled by the poller before anyone uses it.
        if client.instance != instance {
            return Err(DISCONNECTED.into());
        }
        Ok(client)
    }
    /// Queue a keystroke or resize. Order is kept; failures are dropped, as the
    /// session may have exited or another window holds authority.
    pub fn send(&self, request: Request) -> Result<(), String> {
        self.writes
            .lock()
            .unwrap()
            .as_ref()
            .ok_or(DISCONNECTED)?
            .send(request)
            .map_err(|_| DISCONNECTED.into())
    }
    pub fn start(
        &self,
        spec: SessionSpec,
        metadata: Metadata,
        request_id: String,
    ) -> Result<String, String> {
        self.launch(spec, metadata, request_id, false)
    }
    /// Sends one idempotent launch request; Restart selects resume or fresh launch.
    ///
    /// # Errors
    /// Fails when the service is disconnected, refuses the launch or its reply is lost.
    pub fn launch(
        &self,
        spec: SessionSpec,
        metadata: Metadata,
        request_id: String,
        resume: bool,
    ) -> Result<String, String> {
        self.launch_reporting(spec, metadata, request_id, resume)
            .map_err(|(e, _)| e)
    }
    /// Like `start`; an error also says whether the session may have started anyway
    /// (the reply was lost), so callers undo their preparation only on a certain refusal.
    ///
    /// # Errors
    /// Fails when the service is disconnected, refuses the launch or its reply is lost.
    pub fn start_reporting(
        &self,
        spec: SessionSpec,
        metadata: Metadata,
        request_id: String,
    ) -> Result<String, (String, bool)> {
        self.launch_reporting(spec, metadata, request_id, false)
    }
    fn launch_reporting(
        &self,
        spec: SessionSpec,
        metadata: Metadata,
        request_id: String,
        resume: bool,
    ) -> Result<String, (String, bool)> {
        let label = crate::component_window_label(&metadata.project_id, &metadata.component_id);
        let metadata = Box::new(metadata);
        let request = if resume {
            Request::Restart {
                request_id,
                metadata,
                spec,
            }
        } else {
            Request::Start {
                request_id,
                metadata,
                spec,
            }
        };
        let id: String = self.call_reporting(request)?;
        self.routes.lock().unwrap().insert(id.clone(), label);
        Ok(id)
    }
    pub fn list(&self) -> Result<Vec<Record>, String> {
        let records: Vec<Record> = self.call(Request::List)?;
        self.learn(&records);
        Ok(records)
    }
    fn learn(&self, records: &[Record]) {
        let mut routes = self.routes.lock().unwrap();
        for r in records {
            routes.insert(
                r.id.clone(),
                crate::component_window_label(&r.metadata.project_id, &r.metadata.component_id),
            );
        }
    }
    pub fn status(&self) -> serde_json::Value {
        let instance = self.instance.lock().unwrap().clone();
        serde_json::json!({"connected": instance.is_some(), "instanceId": instance.unwrap_or_default()})
    }
    fn disconnected(&self) {
        self.instance.lock().unwrap().take();
        self.pool.lock().unwrap().clear();
    }
    pub fn disconnect(&self) {
        self.stopped.store(true, Ordering::Release);
        self.writes.lock().unwrap().take();
        self.disconnected();
    }
    fn route(&self, app: &AppHandle, envelope: &Envelope) {
        let _ = app.emit_to("main", TERMINAL_EVENT, envelope);
        let label = self
            .routes
            .lock()
            .unwrap()
            .get(envelope.event.session_id())
            .cloned();
        if let Some(label) = label.filter(|l| !l.is_empty())
            && app.get_webview_window(&label).is_some()
        {
            let _ = app.emit_to(&label, &format!("{TERMINAL_EVENT}/{label}"), envelope);
        }
    }
    pub fn run(self: &Arc<Self>, app: AppHandle) {
        let (tx, rx) = channel::<Request>();
        *self.writes.lock().unwrap() = Some(tx);
        let writer = self.clone();
        std::thread::spawn(move || {
            while let Ok(request) = rx.recv() {
                let _ = writer.call::<()>(request);
            }
        });
        let bridge = self.clone();
        std::thread::spawn(move || {
            let helper = helper();
            let mut poller: Option<Client> = None;
            let mut after = 0;
            let mut delay = 100;
            let mut layout_changed = None;
            while !bridge.stopped.load(Ordering::Acquire) {
                if app
                    .state::<crate::AppState>()
                    .layout_dirty
                    .swap(false, Ordering::AcqRel)
                {
                    layout_changed = Some(Instant::now());
                }
                if layout_changed
                    .is_some_and(|at: Instant| at.elapsed() >= Duration::from_millis(500))
                {
                    crate::layout::save(&app);
                    layout_changed = None;
                }
                let Some(client) = poller.as_mut() else {
                    let connection = session::runtime_dir()
                        .and_then(|dir| Client::ensure_as(&dir, &helper, Some(&bridge.name)));
                    match connection {
                        Ok(mut client) => {
                            // Subscribe to the event cursor before reconciling snapshots.
                            let baseline: Result<Batch, _> =
                                client.call(Request::Poll { after: 0 });
                            let records: Result<Vec<Record>, _> = client.call(Request::List);
                            if let (Ok(batch), Ok(records)) = (baseline, records) {
                                after = batch.end;
                                bridge.learn(&records);
                                bridge.pool.lock().unwrap().clear();
                                *bridge.instance.lock().unwrap() = Some(client.instance.clone());
                                let _ = app.emit("patchbay://service", serde_json::json!({"connected": true, "instanceId": client.instance, "records": records}));
                                poller = Some(client);
                                delay = 100;
                            }
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "patchbay://service",
                                serde_json::json!({"connected": false, "error": e.to_string()}),
                            );
                            std::thread::sleep(Duration::from_millis(delay));
                            delay = (delay * 2).min(5000);
                        }
                    }
                    continue;
                };
                let pause = match client.call::<Batch>(Request::Poll { after }) {
                    Ok(batch) if batch.gap => {
                        // Lost events: windows re-read the sessions that fell behind.
                        if let Ok(records) = client.call::<Vec<Record>>(Request::List) {
                            after = batch.end;
                            bridge.learn(&records);
                            let _ = app.emit("patchbay://service", serde_json::json!({"connected": true, "instanceId": batch.instance_id, "records": records}));
                        }
                        0
                    }
                    Ok(batch) => {
                        let count = batch.events.len();
                        // Sessions the service started itself (graph actions) or
                        // another client started: learn their windows before routing.
                        let unknown = {
                            let routes = bridge.routes.lock().unwrap();
                            batch
                                .events
                                .iter()
                                .any(|e| !routes.contains_key(e.event.session_id()))
                        };
                        if unknown && let Ok(records) = client.call::<Vec<Record>>(Request::List) {
                            bridge.learn(&records);
                            // Ids with no record go to main only, without asking again.
                            let mut routes = bridge.routes.lock().unwrap();
                            for e in &batch.events {
                                routes.entry(e.event.session_id().into()).or_default();
                            }
                        }
                        for envelope in &batch.events {
                            after = envelope.sequence;
                            bridge.route(&app, envelope);
                        }
                        // A full batch means more is waiting: fetch it straight away.
                        if count >= POLL_LIMIT {
                            0
                        } else if count > 0 {
                            25
                        } else {
                            100
                        }
                    }
                    Err(e) => {
                        poller = None;
                        bridge.disconnected();
                        let _ = app.emit(
                            "patchbay://service",
                            serde_json::json!({"connected": false, "error": e.to_string()}),
                        );
                        0
                    }
                };
                if pause > 0 {
                    std::thread::sleep(Duration::from_millis(pause));
                }
            }
        });
    }
}
pub(crate) fn helper() -> PathBuf {
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
        task: None,
        task_title: None,
        name: terminal.name.clone(),
        kind: terminal.kind,
        adapter: terminal
            .adapter
            .or_else(|| patchbay_core::adapters::Adapter::default_for(&terminal.command)),
        conversation_id: None,
        conversation_pinned: false,
        extension_id: None,
        command_id: None,
        key: None,
        branch: None,
        command: terminal.command.clone(),
    }
}
