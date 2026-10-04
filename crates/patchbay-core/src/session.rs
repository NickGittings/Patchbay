//! Versioned, authenticated loopback session service shared by desktop and CLI.
//! Webviews never receive endpoint credentials. Disconnect is not a stop operation.
use crate::adapters::Adapter;
use crate::pty::{PtyManager, SessionSpec, Snapshot};
use crate::workspace::{atomic_write, home, lock, private_dir};
use crate::{EventSink, TerminalEvent, TerminalKind};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

pub const PROTOCOL: u32 = 1;
const MAX_FRAME: usize = 16 * 1024 * 1024;
const EVENT_CAP: usize = 2 * 1024 * 1024;
#[derive(Debug, Serialize, Deserialize)]
pub struct Endpoint {
    pub protocol: u32,
    pub port: u16,
    pub token: String,
    pub instance: String,
}
pub fn runtime_dir() -> Result<PathBuf> {
    Ok(home()?.join("sessiond"))
}

pub fn read_frame<T: DeserializeOwned>(stream: &mut impl Read) -> Result<T> {
    let mut size = [0; 4];
    stream.read_exact(&mut size)?;
    let size = usize::try_from(u32::from_be_bytes(size))?;
    anyhow::ensure!(
        size > 0 && size <= MAX_FRAME,
        "Invalid session protocol frame length"
    );
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn write_frame(stream: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    anyhow::ensure!(bytes.len() <= MAX_FRAME, "Session protocol frame too large");
    stream.write_all(&u32::try_from(bytes.len())?.to_be_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}
#[derive(Debug, Serialize, Deserialize)]
struct Hello {
    protocol: u32,
    token: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub project_id: String,
    pub project_name: String,
    pub project_root: String,
    pub component_id: String,
    pub terminal_id: String,
    pub name: String,
    pub kind: TerminalKind,
    #[serde(default)]
    pub adapter: Option<Adapter>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub extension_id: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub command: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub metadata: Metadata,
    pub spec: SessionSpec,
    pub snapshot: Option<Snapshot>,
    pub history: Vec<Snapshot>,
    #[serde(default)]
    pub launch_command: String,
    pub interrupted: bool,
    pub request_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub instance_id: String,
    pub sequence: u64,
    pub event: TerminalEvent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub instance_id: String,
    pub end: u64,
    pub gap: bool,
    pub events: Vec<Envelope>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    List,
    Start {
        request_id: String,
        metadata: Box<Metadata>,
        spec: SessionSpec,
    },
    Attach {
        id: String,
        viewer: String,
        claim: bool,
    },
    Detach {
        id: String,
        viewer: String,
    },
    DetachViewer {
        viewer: String,
    },
    Write {
        id: String,
        viewer: String,
        data: String,
    },
    Resize {
        id: String,
        viewer: String,
        cols: u16,
        rows: u16,
    },
    Stop {
        id: String,
    },
    Seen {
        id: String,
    },
    Snapshot {
        id: String,
    },
    History {
        id: String,
        incarnation: usize,
    },
    Poll {
        after: u64,
    },
    Resume {
        id: String,
        request_id: String,
    },
    Conversation {
        id: String,
        conversation_id: String,
    },
    Forget {
        id: String,
    },
    Shutdown {
        stop_running: bool,
    },
}
#[derive(Debug, Serialize, Deserialize)]
struct Response {
    result: serde_json::Value,
    error: Option<String>,
}
impl Response {
    fn result(result: Result<serde_json::Value>) -> Self {
        match result {
            Ok(result) => Self {
                result,
                error: None,
            },
            Err(e) => Self {
                result: serde_json::Value::Null,
                error: Some(e.to_string()),
            },
        }
    }
}
pub struct Client {
    stream: TcpStream,
    pub instance: String,
}
impl Client {
    pub fn connect(dir: &Path) -> Result<Self> {
        let endpoint: Endpoint =
            serde_json::from_slice(&std::fs::read(dir.join("endpoint.json"))?)?;
        anyhow::ensure!(
            endpoint.protocol == PROTOCOL,
            "Session service protocol mismatch. Running work was preserved. Install a matching Patchbay version, or explicitly stop work with the matching CLI before upgrading."
        );
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], endpoint.port));
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        stream.set_nodelay(true)?;
        write_frame(
            &mut stream,
            &Hello {
                protocol: PROTOCOL,
                token: endpoint.token,
            },
        )?;
        let response: Response = read_frame(&mut stream)?;
        if let Some(error) = response.error {
            bail!("{error}");
        }
        Ok(Self {
            stream,
            instance: endpoint.instance,
        })
    }
    pub fn ensure(dir: &Path, helper: &Path) -> Result<Self> {
        if let Ok(client) = Self::connect(dir) {
            return Ok(client);
        }
        private_dir(dir)?;
        // A separate OS lock serializes launcher clients. Service lifetime uses service.lock.
        let startup = lock(&dir.join("startup.lock"))?;
        startup.lock()?;
        if let Ok(client) = Self::connect(dir) {
            return Ok(client);
        }
        if let Ok(bytes) = std::fs::read(dir.join("endpoint.json")) {
            let endpoint: Endpoint = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(
                endpoint.protocol == PROTOCOL,
                "Session service protocol mismatch; running work was preserved. Use the matching Patchbay version."
            );
        }
        let service_lock = lock(&dir.join("service.lock"))?;
        if service_lock.try_lock().is_ok() {
            service_lock.unlock()?;
            anyhow::ensure!(
                helper.is_file(),
                "Session helper missing at {}. Build/install patchbay-sessiond alongside Patchbay.",
                helper.display()
            );
            let mut command = std::process::Command::new(helper);
            command.arg(dir);
            let log_path = dir.join("service.log");
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            if std::fs::metadata(&log_path).is_ok_and(|m| m.len() > 128 * 1024) {
                atomic_write(&log_path, b"")?;
            }
            command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(options.open(log_path)?);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0000_0008 | 0x0800_0000);
            }
            let mut child = command.spawn().context("Starting session helper")?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            match Self::connect(dir) {
                Ok(client) => return Ok(client),
                Err(e) if Instant::now() >= until => {
                    return Err(e.context("Session service unavailable; no work was restarted"));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    pub fn call<T: DeserializeOwned>(&mut self, request: Request) -> Result<T> {
        write_frame(&mut self.stream, &request)?;
        let response: Response = read_frame(&mut self.stream)?;
        if let Some(error) = response.error {
            bail!("{error}");
        }
        Ok(serde_json::from_value(response.result)?)
    }
}
#[derive(Default)]
struct Events {
    end: u64,
    bytes: usize,
    ring: VecDeque<(usize, Envelope)>,
}
#[derive(Clone)]
struct Viewer {
    client: usize,
    viewer: String,
    order: u64,
}
pub struct Service {
    pty: Arc<PtyManager>,
    records: Mutex<BTreeMap<String, Record>>,
    events: Mutex<Events>,
    viewers: Mutex<BTreeMap<String, Vec<Viewer>>>,
    operation: Mutex<()>,
    persistence: Mutex<()>,
    instance: String,
    dir: PathBuf,
    dirty: AtomicBool,
    shutdown: AtomicBool,
    clients: AtomicUsize,
    authority: AtomicUsize,
}
impl Service {
    fn load(dir: &Path) -> Result<Arc<Self>> {
        let path = dir.join("sessions.json");
        let mut records: BTreeMap<String, Record> = if path.exists() {
            serde_json::from_slice(&std::fs::read(path)?)
                .context("Session history is invalid; retained for recovery")?
        } else {
            BTreeMap::new()
        };
        for record in records.values_mut() {
            if let Some(s) = &mut record.snapshot
                && s.running
            {
                s.running = false;
                record.interrupted = true;
            }
            record.history.iter_mut().for_each(|s| s.running = false);
        }
        Ok(Arc::new(Self {
            pty: Arc::new(PtyManager::new()),
            records: Mutex::new(records),
            events: Mutex::default(),
            viewers: Mutex::default(),
            operation: Mutex::new(()),
            persistence: Mutex::new(()),
            instance: uuid::Uuid::new_v4().to_string(),
            dir: dir.into(),
            dirty: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
            clients: AtomicUsize::new(0),
            authority: AtomicUsize::new(0),
        }))
    }
    fn snapshot(&self, id: &str) -> Option<Snapshot> {
        self.pty
            .snapshot(id)
            .or_else(|| self.records.lock().unwrap().get(id)?.snapshot.clone())
    }
    fn list(&self) -> Vec<Record> {
        let mut records: Vec<_> = self.records.lock().unwrap().values().cloned().collect();
        for r in &mut records {
            if let Some(s) = self.pty.snapshot(&r.id) {
                r.snapshot = Some(s);
            }
        }
        records
    }
    fn persist(&self) -> Result<()> {
        let _persistence = self.persistence.lock().unwrap();
        let records: BTreeMap<_, _> = self.list().into_iter().map(|r| (r.id.clone(), r)).collect();
        atomic_write(
            &self.dir.join("sessions.json"),
            &serde_json::to_vec(&records)?,
        )
    }
    fn owns(&self, client: usize, id: &str, viewer: &str) -> bool {
        self.viewers
            .lock()
            .unwrap()
            .get(id)
            .and_then(|v| v.iter().max_by_key(|v| v.order))
            .is_some_and(|v| v.client == client && v.viewer == viewer)
    }
    fn start(
        self: &Arc<Self>,
        request: String,
        metadata: Metadata,
        spec: SessionSpec,
    ) -> Result<String> {
        self.start_with_command(request, metadata, spec, None)
    }
    fn start_with_command(
        self: &Arc<Self>,
        request: String,
        metadata: Metadata,
        mut spec: SessionSpec,
        original_command: Option<String>,
    ) -> Result<String> {
        anyhow::ensure!(!request.is_empty(), "Launch request ID required");
        let id = crate::workspace::session_id(
            &metadata.project_id,
            &metadata.component_id,
            &metadata.terminal_id,
        );
        spec.id.clone_from(&id);
        let _operation = self.operation.lock().unwrap();
        anyhow::ensure!(
            !self.shutdown.load(Ordering::Acquire),
            "Session service is shutting down; no work was started"
        );
        if let Some(r) = self.records.lock().unwrap().get(&id)
            && r.request_ids.contains(&request)
        {
            return Ok(id);
        }
        anyhow::ensure!(
            !self.pty.is_running(&id),
            "Terminal is already running; reconnect instead"
        );
        if let (Some(adapter), Some(conversation)) = (metadata.adapter, &metadata.conversation_id) {
            anyhow::ensure!(
                !self
                    .list()
                    .iter()
                    .any(|r| r.metadata.adapter == Some(adapter)
                        && r.metadata.conversation_id.as_ref() == Some(conversation)
                        && r.snapshot.as_ref().is_some_and(|s| s.running)),
                "Conversation is already running; reconnect instead"
            );
        }
        let previous = self.records.lock().unwrap().get(&id).cloned();
        let mut history = previous
            .as_ref()
            .map_or_else(Vec::new, |r| r.history.clone());
        if let Some(snapshot) = self.snapshot(&id) {
            history.push(snapshot);
        }
        // History is bounded per incarnation; users can explicitly forget a session.
        let mut requests = previous
            .as_ref()
            .map_or_else(Vec::new, |r| r.request_ids.clone());
        requests.push(request);
        self.records.lock().unwrap().insert(
            id.clone(),
            Record {
                id: id.clone(),
                metadata,
                spec: spec.clone(),
                snapshot: None,
                history,
                launch_command: original_command.unwrap_or_else(|| spec.command.clone()),
                interrupted: false,
                request_ids: requests,
            },
        );
        if let Err(e) = self.pty.spawn(spec, self.clone()) {
            let mut records = self.records.lock().unwrap();
            if let Some(r) = previous {
                records.insert(id, r);
            } else {
                records.remove(&id);
            }
            return Err(e);
        }
        self.dirty.store(true, Ordering::Release);
        self.persist()?;
        Ok(id)
    }
    fn handle(self: &Arc<Self>, client: usize, request: Request) -> Result<serde_json::Value> {
        let result = match request {
            Request::List => {
                let mut records = self.list();
                for r in &mut records {
                    if let Some(s) = &mut r.snapshot {
                        s.data.clear();
                    }
                    for s in &mut r.history {
                        s.data.clear();
                    }
                    r.spec.env.clear();
                    r.request_ids.clear();
                    r.spec.command.clone_from(&r.metadata.command);
                    r.launch_command.clear();
                }
                serde_json::to_value(records)?
            }
            Request::History { id, incarnation } => {
                let snapshot = self
                    .records
                    .lock()
                    .unwrap()
                    .get(&id)
                    .and_then(|r| r.history.get(incarnation))
                    .cloned();
                serde_json::to_value(snapshot)?
            }
            Request::Start {
                request_id,
                metadata,
                spec,
            } => serde_json::to_value(self.start(request_id, *metadata, spec)?)?,
            Request::Snapshot { id } => serde_json::to_value(self.snapshot(&id))?,
            Request::Attach { id, viewer, claim } => {
                let mut viewers = self.viewers.lock().unwrap();
                let own = viewers.entry(id.clone()).or_default();
                let order = self.authority.fetch_add(1, Ordering::Relaxed) as u64 + 1;
                match own
                    .iter_mut()
                    .find(|v| v.client == client && v.viewer == viewer)
                {
                    Some(v) if claim => v.order = order,
                    Some(_) => {}
                    None => own.push(Viewer {
                        client,
                        viewer,
                        order: if claim || own.is_empty() { order } else { 0 },
                    }),
                }
                drop(viewers);
                serde_json::to_value(self.snapshot(&id))?
            }
            Request::Detach { id, viewer } => {
                if let Some(v) = self.viewers.lock().unwrap().get_mut(&id) {
                    v.retain(|v| v.client != client || v.viewer != viewer);
                }
                serde_json::Value::Null
            }
            Request::DetachViewer { viewer } => {
                for v in self.viewers.lock().unwrap().values_mut() {
                    v.retain(|v| v.client != client || v.viewer != viewer);
                }
                serde_json::Value::Null
            }
            Request::Write { id, viewer, data } => {
                anyhow::ensure!(
                    self.owns(client, &id, &viewer),
                    "Viewer does not have terminal authority"
                );
                self.pty.write(&id, data.as_bytes())?;
                serde_json::Value::Null
            }
            Request::Resize {
                id,
                viewer,
                cols,
                rows,
            } => {
                anyhow::ensure!(cols > 0 && rows > 0, "Invalid terminal size");
                if self.owns(client, &id, &viewer) {
                    self.pty.resize(&id, cols, rows)?;
                }
                serde_json::Value::Null
            }
            Request::Stop { id } => {
                let _operation = self.operation.lock().unwrap();
                self.pty.stop(&id);
                serde_json::Value::Null
            }
            Request::Seen { id } => {
                if let Some(event) = self.pty.mark_seen(&id) {
                    self.emit(event);
                }
                serde_json::Value::Null
            }
            Request::Poll { after } => {
                let events = self.events.lock().unwrap();
                let gap = events
                    .ring
                    .front()
                    .is_some_and(|(_, e)| after + 1 < e.sequence);
                serde_json::to_value(Batch {
                    instance_id: self.instance.clone(),
                    end: events.end,
                    gap,
                    events: events
                        .ring
                        .iter()
                        .filter(|(_, e)| e.sequence > after)
                        .take(256)
                        .map(|(_, e)| e.clone())
                        .collect(),
                })?
            }
            Request::Conversation {
                id,
                conversation_id,
            } => {
                anyhow::ensure!(
                    crate::adapters::valid_id(&conversation_id),
                    "Invalid conversation ID"
                );
                let mut records = self.records.lock().unwrap();
                let record = records.get_mut(&id).context("Unknown session")?;
                anyhow::ensure!(
                    record.metadata.adapter.is_some(),
                    "Select an agent adapter before setting a conversation ID"
                );
                record.metadata.conversation_id = Some(conversation_id);
                self.dirty.store(true, Ordering::Release);
                serde_json::Value::Null
            }
            Request::Resume { id, request_id } => {
                let mut r = self
                    .records
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .context("Unknown session")?;
                if r.request_ids.contains(&request_id) {
                    return Ok(serde_json::to_value(id)?);
                }
                let adapter = r
                    .metadata
                    .adapter
                    .context("Select an adapter to resume this conversation")?;
                let conversation = r
                    .metadata
                    .conversation_id
                    .as_ref()
                    .context("Set conversation ID before resuming")?;
                let original = if r.launch_command.is_empty() {
                    r.spec.command.clone()
                } else {
                    r.launch_command.clone()
                };
                r.spec.command = adapter.resume(
                    if r.launch_command.is_empty() {
                        &r.spec.command
                    } else {
                        &r.launch_command
                    },
                    conversation,
                    &r.spec.cwd,
                )?;
                crate::adapters::require_executable(&r.spec.command, &r.spec.cwd, &r.spec.env)?;
                // Keep the original launch command for later resumes; context environment persists.
                let id = self.start_with_command(request_id, r.metadata, r.spec, Some(original))?;
                serde_json::to_value(id)?
            }
            Request::Forget { id } => {
                let _operation = self.operation.lock().unwrap();
                anyhow::ensure!(
                    !self.pty.is_running(&id),
                    "Stop running work before forgetting it"
                );
                self.records.lock().unwrap().remove(&id);
                self.pty.forget(&id);
                self.dirty.store(true, Ordering::Release);
                self.persist()?;
                serde_json::Value::Null
            }
            Request::Shutdown { stop_running } => {
                let _operation = self.operation.lock().unwrap();
                let running = self
                    .list()
                    .iter()
                    .any(|r| r.snapshot.as_ref().is_some_and(|s| s.running));
                anyhow::ensure!(
                    !running || stop_running,
                    "Work is running; shutdown requires --stop-running"
                );
                if stop_running {
                    self.pty.stop_all();
                }
                self.persist()?;
                self.shutdown.store(true, Ordering::Release);
                serde_json::Value::Null
            }
        };
        Ok(result)
    }
}
impl EventSink for Service {
    fn emit(&self, event: TerminalEvent) {
        if let TerminalEvent::Output {
            session_id, data, ..
        } = &event
            && let Some(r) = self.records.lock().unwrap().get_mut(session_id)
            && let Some(adapter) = r.metadata.adapter
        {
            // A bounded snapshot also handles messages split across reader chunks.
            let bytes = self
                .pty
                .snapshot(session_id)
                .map_or_else(|| data.clone(), |s| s.data);
            if let Some(id) = adapter.capture(&String::from_utf8_lossy(&bytes)) {
                r.metadata.conversation_id = Some(id);
            }
        }
        let size = match &event {
            TerminalEvent::Output { data, .. } => data.len() * 4 + 512,
            _ => 1024,
        };
        let mut events = self.events.lock().unwrap();
        events.end += 1;
        let envelope = Envelope {
            instance_id: self.instance.clone(),
            sequence: events.end,
            event,
        };
        events.ring.push_back((size, envelope));
        events.bytes += size;
        while events.bytes > EVENT_CAP {
            if let Some((size, _)) = events.ring.pop_front() {
                events.bytes -= size;
            }
        }
        self.dirty.store(true, Ordering::Release);
    }
}

pub fn serve(dir: &Path) -> Result<()> {
    private_dir(dir)?;
    let lifetime = lock(&dir.join("service.lock"))?;
    if lifetime.try_lock().is_err() {
        return Ok(());
    }
    let service = Service::load(dir)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let endpoint = Endpoint {
        protocol: PROTOCOL,
        port: listener.local_addr()?.port(),
        token: uuid::Uuid::new_v4().to_string(),
        instance: service.instance.clone(),
    };
    atomic_write(&dir.join("endpoint.json"), &serde_json::to_vec(&endpoint)?)?;
    let token = Arc::new(endpoint.token);
    let mut idle = Instant::now();
    let mut saved = Instant::now();
    let next = AtomicUsize::new(1);
    while !service.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let service = service.clone();
                let token = token.clone();
                let client = next.fetch_add(1, Ordering::Relaxed);
                std::thread::spawn(move || {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    let Ok(hello) = read_frame::<Hello>(&mut stream) else {
                        return;
                    };
                    let valid = hello.protocol == PROTOCOL && hello.token == *token;
                    let reply = if valid {
                        Response::result(Ok(serde_json::Value::Null))
                    } else {
                        Response::result(Err(anyhow::anyhow!(
                            "Session service authentication/protocol mismatch"
                        )))
                    };
                    if write_frame(&mut stream, &reply).is_err() || !valid {
                        return;
                    }
                    service.clients.fetch_add(1, Ordering::Relaxed);
                    // Authenticated desktop clients poll regularly; CLI attachment does likewise.
                    while let Ok(request) = read_frame::<Request>(&mut stream) {
                        let reply = Response::result(service.handle(client, request));
                        if write_frame(&mut stream, &reply).is_err() {
                            break;
                        }
                    }
                    for viewers in service.viewers.lock().unwrap().values_mut() {
                        viewers.retain(|v| v.client != client);
                    }
                    service.clients.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        if saved.elapsed() >= Duration::from_millis(500) {
            if service.dirty.swap(false, Ordering::AcqRel)
                && let Err(e) = service.persist()
            {
                eprintln!("Session persistence failed: {e}");
                service.dirty.store(true, Ordering::Release);
            }
            saved = Instant::now();
        }
        if service.clients.load(Ordering::Relaxed) > 0 || service.pty.has_running() {
            idle = Instant::now();
        }
        if idle.elapsed() >= Duration::from_secs(60) {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    service.persist()?;
    std::fs::remove_file(dir.join("endpoint.json"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_malformed_protocol_frames() {
        assert!(read_frame::<Request>(&mut &u32::MAX.to_be_bytes()[..]).is_err());
        assert!(read_frame::<Request>(&mut &[0, 0, 0, 2, b'[', b']'][..]).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn idempotent_launch_authority_replay_and_restart() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata = Metadata {
            project_id: "p".into(),
            project_name: "P".into(),
            project_root: dir.display().to_string(),
            component_id: "same/id".into(),
            terminal_id: "shell".into(),
            name: "Counter".into(),
            kind: TerminalKind::Task,
            adapter: None,
            conversation_id: None,
            extension_id: None,
            command_id: None,
            key: None,
            command: String::new(),
        };
        let spec = SessionSpec {
            id: "ignored".into(),
            command: "i=0; while :; do printf 'number:%s\\n' \"$i\"; i=$((i+1)); sleep 0.05; done"
                .into(),
            cwd: dir.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
        };
        let starts: Vec<_> = (0..4)
            .map(|_| {
                let service = service.clone();
                let metadata = metadata.clone();
                let spec = spec.clone();
                std::thread::spawn(move || service.start("request".into(), metadata, spec).unwrap())
            })
            .collect();
        let ids: Vec<_> = starts.into_iter().map(|s| s.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        let id = &ids[0];
        let first = service.snapshot(id).unwrap().generation;
        assert_eq!(service.list().len(), 1);
        assert!(service.start("different".into(), metadata, spec).is_err());
        service
            .handle(
                1,
                Request::Attach {
                    id: id.clone(),
                    viewer: "a".into(),
                    claim: true,
                },
            )
            .unwrap();
        service
            .handle(
                2,
                Request::Attach {
                    id: id.clone(),
                    viewer: "b".into(),
                    claim: true,
                },
            )
            .unwrap();
        assert!(!service.owns(1, id, "a"));
        assert!(service.owns(2, id, "b"));
        service
            .handle(
                2,
                Request::Detach {
                    id: id.clone(),
                    viewer: "b".into(),
                },
            )
            .unwrap();
        assert!(service.owns(1, id, "a"));
        assert!(
            service
                .handle(
                    1,
                    Request::Write {
                        id: id.clone(),
                        viewer: "b".into(),
                        data: "bad".into()
                    }
                )
                .is_err()
        );
        std::thread::sleep(Duration::from_millis(250));
        let snapshot = service.snapshot(id).unwrap();
        let baseline = service.events.lock().unwrap().end;
        std::thread::sleep(Duration::from_millis(150));
        let batch: Batch = serde_json::from_value(
            service
                .handle(1, Request::Poll { after: baseline })
                .unwrap(),
        )
        .unwrap();
        let mut bytes = snapshot.data.clone();
        let mut end = snapshot.end;
        for envelope in batch.events {
            if let TerminalEvent::Output { seq, data, .. } = envelope.event {
                let covered = usize::try_from(end.saturating_sub(seq))
                    .unwrap()
                    .min(data.len());
                bytes.extend_from_slice(&data[covered..]);
                end = end.max(seq + data.len() as u64);
            }
        }
        let text = String::from_utf8_lossy(&bytes);
        let mut seen = std::collections::HashSet::new();
        for line in text.lines().filter(|s| s.starts_with("number:")) {
            assert!(seen.insert(line));
        }
        assert_eq!(service.snapshot(id).unwrap().generation, first);
        assert!(
            service
                .handle(
                    1,
                    Request::Shutdown {
                        stop_running: false
                    }
                )
                .is_err()
        );
        service.persist().unwrap();
        let recovered = Service::load(&dir).unwrap();
        assert_ne!(service.instance, recovered.instance);
        assert!(recovered.list()[0].interrupted);
        assert!(!recovered.snapshot(id).unwrap().running);
        service.handle(1, Request::Stop { id: id.clone() }).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while service.snapshot(id).unwrap().running && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!service.snapshot(id).unwrap().running);
        service
            .handle(1, Request::Forget { id: id.clone() })
            .unwrap();
        assert!(service.list().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn event_buffer_is_bounded_and_detects_gaps() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        for seq in 0..200 {
            service.emit(TerminalEvent::Output {
                session_id: "unknown".into(),
                generation: 1,
                seq,
                data: vec![b'x'; 8192],
            });
        }
        assert!(service.events.lock().unwrap().bytes <= EVENT_CAP);
        let batch: Batch =
            serde_json::from_value(service.handle(1, Request::Poll { after: 0 }).unwrap()).unwrap();
        assert!(batch.gap);
        assert_eq!(batch.instance_id, service.instance);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
