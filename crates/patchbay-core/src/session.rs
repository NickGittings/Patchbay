//! Versioned, authenticated loopback session service shared by desktop and CLI.
//! Webviews never receive endpoint credentials. Disconnect is not a stop operation.
use crate::actions::{ActionPlan, GraphActions, Launch, Terminals};
use crate::adapters::Adapter;
use crate::pty::{PtyManager, SessionSpec, Snapshot};
use crate::workspace::{atomic_write, home, lock, private_dir};
use crate::{EventSink, TerminalEvent, TerminalKind};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

mod briefing;
pub use briefing::with_pending_briefing;

pub const PROTOCOL: u32 = 5;
const MAX_FRAME: usize = 16 * 1024 * 1024;
/// Estimated wire size of the retained event ring (output travels as a JSON number array).
const EVENT_CAP: usize = 8 * 1024 * 1024;
/// Events returned by one `Poll`; a full batch tells the poller to come straight back.
pub const POLL_LIMIT: usize = 512;
/// Earlier incarnations kept per session, oldest dropped first.
const MAX_HISTORY: usize = 3;
/// How much of a finished run's output is searched for a provider's resume hint.
const CAPTURE_TAIL: usize = 4096;
/// Reply timeout for quick requests; slow ones (spawning, stopping, resuming) get `SLOW_TIMEOUT`.
const TIMEOUT: Duration = Duration::from_secs(10);
const SLOW_TIMEOUT: Duration = Duration::from_secs(90);
const SHUTDOWN_REFUSED: &str = "Work is running; shutdown requires --stop-running";

/// A confirmed refusal, distinct from a lost reply or another service error.
#[derive(Debug, Clone)]
struct RetirementRefused {
    protocol: u32,
}
impl std::fmt::Display for RetirementRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Session service protocol mismatch (service {}, this build {PROTOCOL}): an older Patchbay session service is still running work, which was preserved",
            self.protocol
        )
    }
}
impl std::error::Error for RetirementRefused {}

/// Only cache confirmed refusals, keyed by runtime directory and service instance.
/// A restarted service gets a fresh attempt; explicit retirement bypasses the cache.
static RETIREMENT_REFUSALS: OnceLock<Mutex<HashMap<PathBuf, (String, RetirementRefused)>>> =
    OnceLock::new();

/// Every read/write shares one deadline, including partial frames and handshakes.
struct DeadlineStream<'a> {
    stream: &'a mut TcpStream,
    until: Instant,
}
fn remaining(until: Instant) -> std::io::Result<Duration> {
    until
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Session service deadline expired",
            )
        })
}
impl Read for DeadlineStream<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        self.stream.set_read_timeout(Some(remaining(self.until)?))?;
        self.stream.read(bytes)
    }
}
impl Write for DeadlineStream<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.stream
            .set_write_timeout(Some(remaining(self.until)?))?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Endpoint {
    pub protocol: u32,
    pub port: u16,
    pub token: String,
    pub instance: String,
}
/// Where the session service keeps its endpoint, locks and records.
///
/// # Errors
/// Fails if there is no home directory.
pub fn runtime_dir() -> Result<PathBuf> {
    Ok(home()?.join("sessiond"))
}

/// Read one length-prefixed JSON frame.
///
/// # Errors
/// Fails on I/O errors, an invalid length or invalid JSON.
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
/// Write one length-prefixed JSON frame.
///
/// # Errors
/// Fails on I/O errors or a frame larger than the protocol allows.
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
    /// Connections sharing a client name share terminal authority, so one
    /// process can use several connections in parallel. Unnamed ones stand alone.
    #[serde(default)]
    client: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub project_id: String,
    pub project_name: String,
    pub project_root: String,
    pub component_id: String,
    pub terminal_id: String,
    /// The task whose worktree this terminal runs in; `None` for the project's own.
    #[serde(default)]
    pub task: Option<String>,
    /// The task's display name at launch, retained even when its project tab is closed.
    #[serde(default)]
    pub task_title: Option<String>,
    pub name: String,
    pub kind: TerminalKind,
    #[serde(default)]
    pub adapter: Option<Adapter>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// Set explicitly by the user, so captured resume hints never replace it.
    #[serde(default)]
    pub conversation_pinned: bool,
    #[serde(default)]
    pub extension_id: Option<String>,
    #[serde(default)]
    pub command_id: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    /// The branch a review job covers, so its findings never depend on the display name.
    #[serde(default)]
    pub branch: Option<String>,
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
    /// Digest of the original settings and briefing, retained across conversation resumes.
    #[serde(default)]
    pub restart_context: Option<String>,
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
/// Answer to `Request::PreviewUrls`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewScan {
    pub generation: u64,
    pub running: bool,
    pub urls: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    List,
    MaintenanceGuard {
        project_id: String,
        component_ids: Vec<String>,
    },
    TerminalCloseGuard {
        project_id: String,
        component_id: String,
        terminal_id: String,
    },
    MaintenanceRelease {
        project_id: String,
        token: String,
    },
    Start {
        request_id: String,
        metadata: Box<Metadata>,
        spec: SessionSpec,
    },
    /// A restart may continue only when the newly prepared settings and briefing match.
    Restart {
        request_id: String,
        metadata: Box<Metadata>,
        spec: SessionSpec,
    },
    Attach {
        id: String,
        viewer: String,
        claim: bool,
    },
    /// `Attach` without the snapshot, for viewers that already hold the output.
    Claim {
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
    StopAll,
    Seen {
        id: String,
    },
    Snapshot {
        id: String,
    },
    /// The local URLs a session printed, scanned here so its output never crosses the wire.
    PreviewUrls {
        id: String,
    },
    /// Scan selected session outputs in one service request, deduplicating URLs.
    PreviewUrlsBatch {
        ids: Vec<String>,
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
    /// Run a graph action `plan` (built by the caller, which also scoped it).
    /// `project` is already trusted, restricted and, for a task, moved into its
    /// worktree. Blocks until it finishes.
    ActionRun {
        project: Box<crate::Project>,
        plan: Box<ActionPlan>,
    },
    ActionStopGroup {
        project_id: String,
        group_id: String,
        task: Option<String>,
    },
    /// Stop every environment started in the task's worktree.
    ActionStopTask {
        project_id: String,
        task: String,
    },
    /// Stop the project's running validation; returns whether one was running.
    ActionCancel {
        project_id: String,
    },
    /// The running session launched with this agent command token, if any.
    AgentSession {
        token: String,
    },
}
/// A running agent session, found by the command token it was launched with.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub metadata: Metadata,
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
    /// Set after a transport error or timeout: the stream may still hold the
    /// reply to an abandoned request, so it must never be read again.
    broken: bool,
}
impl Client {
    /// Connect to the running service as a standalone client.
    ///
    /// # Errors
    /// Fails if no service is running, its protocol differs, or authentication fails.
    pub fn connect(dir: &Path) -> Result<Self> {
        Self::connect_as(dir, None)
    }
    /// Connect as `client`: every connection with the same name shares terminal
    /// authority, and loses it only when the last one closes.
    ///
    /// # Errors
    /// Fails if no service is running, its protocol differs, or authentication fails.
    pub fn connect_as(dir: &Path, client: Option<&str>) -> Result<Self> {
        Self::connect_until(dir, client, Instant::now() + TIMEOUT)
    }
    fn connect_until(dir: &Path, client: Option<&str>, until: Instant) -> Result<Self> {
        let endpoint: Endpoint =
            serde_json::from_slice(&std::fs::read(dir.join("endpoint.json"))?)?;
        anyhow::ensure!(
            endpoint.protocol == PROTOCOL,
            "Session service protocol mismatch (service {}, this build {PROTOCOL}). Use a matching Patchbay version. A newer build can replace an idle older service, or offer to stop its running sessions.",
            endpoint.protocol
        );
        let stream = connect_endpoint(&endpoint, client, until)?;
        Ok(Self {
            stream,
            instance: endpoint.instance,
            broken: false,
        })
    }
    /// Connect, starting the helper if needed and retiring an idle older service.
    /// A newer service is never retired; running older work requires explicit retirement.
    ///
    /// # Errors
    /// Fails if an older service refuses retirement, a newer protocol is running,
    /// the helper is missing, or startup (including waiting for its lock) exceeds 10 seconds.
    pub fn ensure(dir: &Path, helper: &Path) -> Result<Self> {
        Self::ensure_as(dir, helper, None)
    }
    /// `ensure` with a client name, as for `connect_as`.
    ///
    /// # Errors
    /// As for `ensure`.
    pub fn ensure_as(dir: &Path, helper: &Path, client: Option<&str>) -> Result<Self> {
        Self::ensure_until(dir, helper, client, Instant::now() + TIMEOUT)
    }
    fn ensure_until(
        dir: &Path,
        helper: &Path,
        client: Option<&str>,
        until: Instant,
    ) -> Result<Self> {
        if let Ok(client) = Self::connect_until(dir, client, until) {
            return Ok(client);
        }
        private_dir(dir)?;
        // Waiting for other launchers also consumes the startup budget.
        let startup = lock(&dir.join("startup.lock"))?;
        loop {
            match startup.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) => {
                    remaining(until).context("Session service startup lock unavailable")?;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(e.into()),
            }
        }
        let mut spawned: Option<Instant> = None;
        let mut retired = false;
        loop {
            let error = match Self::connect_until(dir, client, until) {
                Ok(client) => return Ok(client),
                Err(e) => e,
            };
            if Instant::now() >= until {
                return Err(error.context("Session service unavailable; no work was restarted"));
            }
            if service_stopped(dir)?
                && spawned.is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
            {
                spawn_helper(dir, helper)?;
                spawned = Some(Instant::now());
            } else if spawned.is_none() && !retired {
                // Transport failures may mean shutdown succeeded but its reply was lost.
                // Retry startup; only a confirmed running-work refusal warrants a prompt.
                match retire_outdated_until(dir, false, until) {
                    Ok(protocol) => retired = protocol.is_some(),
                    Err(e) if e.is::<RetirementRefused>() => return Err(e),
                    Err(_) => {}
                }
            }
            if let Some(wait) = until.checked_duration_since(Instant::now()) {
                std::thread::sleep(Duration::from_millis(100).min(wait));
            }
        }
    }
    /// Whether a transport error or timeout made this connection unusable.
    #[must_use]
    pub fn is_broken(&self) -> bool {
        self.broken
    }
    /// Send one request and wait for its reply.
    ///
    /// # Errors
    /// Fails if the service reports an error, or on transport errors and timeouts,
    /// after which the client is broken and every later call fails.
    pub fn call<T: DeserializeOwned>(&mut self, request: Request) -> Result<T> {
        with_pending_briefing(request, |request| self.call_inner(request))
    }
    fn call_inner<T: DeserializeOwned>(&mut self, request: Request) -> Result<T> {
        anyhow::ensure!(!self.broken, "Session service connection was lost");
        let timeout = match request {
            // Validators and readiness gates take as long as they take.
            Request::ActionRun { .. } => None,
            Request::Start { .. }
            | Request::Restart { .. }
            | Request::Resume { .. }
            | Request::Stop { .. }
            | Request::StopAll
            | Request::Forget { .. }
            | Request::Shutdown { .. }
            | Request::ActionStopGroup { .. }
            | Request::ActionStopTask { .. } => Some(SLOW_TIMEOUT),
            _ => Some(TIMEOUT),
        };
        let response = (|| -> Result<Response> {
            self.stream.set_read_timeout(timeout)?;
            write_frame(&mut self.stream, &request)?;
            read_frame(&mut self.stream)
        })();
        let response = match response {
            Ok(response) => response,
            Err(e) => {
                self.broken = true;
                return Err(e);
            }
        };
        if let Some(error) = response.error {
            bail!("{error}");
        }
        Ok(serde_json::from_value(response.result)?)
    }
}

/// Shut down a running service with a lower protocol, persisting its records.
/// Returns its protocol, or `None` if it is gone, current, or newer than this build.
/// Legacy services refuse only for running work: connected apps with exited
/// terminals do not prevent retirement. Close older apps before upgrading.
///
/// # Errors
/// Fails on a confirmed running-work refusal, another service error, or transport failure.
pub fn retire_outdated(dir: &Path, stop_running: bool) -> Result<Option<u32>> {
    let timeout = if stop_running { SLOW_TIMEOUT } else { TIMEOUT };
    retire_outdated_until(dir, stop_running, Instant::now() + timeout)
}
fn retire_outdated_until(dir: &Path, stop_running: bool, until: Instant) -> Result<Option<u32>> {
    let refusals = RETIREMENT_REFUSALS.get_or_init(Mutex::default);
    let Ok(bytes) = std::fs::read(dir.join("endpoint.json")) else {
        refusals.lock().unwrap().remove(dir);
        return Ok(None);
    };
    let endpoint: Endpoint = serde_json::from_slice(&bytes)?;
    if endpoint.protocol >= PROTOCOL || service_stopped(dir)? {
        refusals.lock().unwrap().remove(dir);
        return Ok(None);
    }
    {
        let mut cached = refusals.lock().unwrap();
        if let Some((instance, refusal)) = cached.get(dir) {
            if instance == &endpoint.instance && !stop_running {
                return Err(refusal.clone().into());
            }
            if instance != &endpoint.instance {
                cached.remove(dir);
            }
        }
    }
    match retire(&endpoint, stop_running, until) {
        Ok(()) => {
            refusals.lock().unwrap().remove(dir);
            Ok(Some(endpoint.protocol))
        }
        Err(e) => {
            if let Some(refusal) = e.downcast_ref::<RetirementRefused>() {
                refusals
                    .lock()
                    .unwrap()
                    .insert(dir.into(), (endpoint.instance, refusal.clone()));
            }
            Err(e)
        }
    }
}

/// Authenticate using the endpoint's protocol. Normal clients first require a
/// matching protocol; retirement uses the older service's stable handshake.
fn connect_endpoint(
    endpoint: &Endpoint,
    client: Option<&str>,
    until: Instant,
) -> Result<TcpStream> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let mut stream =
        TcpStream::connect_timeout(&address, remaining(until)?.min(Duration::from_secs(2)))?;
    stream.set_nodelay(true)?;
    {
        let mut wire = DeadlineStream {
            stream: &mut stream,
            until,
        };
        write_frame(
            &mut wire,
            &Hello {
                protocol: endpoint.protocol,
                token: endpoint.token.clone(),
                client: client.map(Into::into),
            },
        )?;
        let response: Response = read_frame(&mut wire)?;
        if let Some(error) = response.error {
            bail!("{error}");
        }
    }
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    Ok(stream)
}
/// The handshake and Shutdown wire formats are shared by every protocol version
/// (`retire_wire_format_is_stable`). The automatic path uses the startup deadline;
/// only explicit stopping gets the longer grace period.
fn retire(endpoint: &Endpoint, stop_running: bool, until: Instant) -> Result<()> {
    let mut stream = connect_endpoint(endpoint, None, until)?;
    let mut wire = DeadlineStream {
        stream: &mut stream,
        until,
    };
    write_frame(&mut wire, &Request::Shutdown { stop_running })?;
    let response: Response = read_frame(&mut wire)?;
    if let Some(error) = response.error {
        if error == SHUTDOWN_REFUSED {
            return Err(RetirementRefused {
                protocol: endpoint.protocol,
            }
            .into());
        }
        bail!("{error}");
    }
    Ok(())
}

/// True when no service process holds the lifetime lock.
fn service_stopped(dir: &Path) -> Result<bool> {
    let service_lock = lock(&dir.join("service.lock"))?;
    if service_lock.try_lock().is_ok() {
        service_lock.unlock()?;
        return Ok(true);
    }
    Ok(false)
}

fn spawn_helper(dir: &Path, helper: &Path) -> Result<()> {
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
    Ok(())
}
#[derive(Default)]
struct Events {
    end: u64,
    bytes: usize,
    ring: VecDeque<(usize, Envelope)>,
}
#[derive(Clone)]
struct Viewer {
    client: String,
    viewer: String,
    order: u64,
}
pub struct Service {
    pty: Arc<PtyManager>,
    /// Graph actions per project: each runs one operation at a time, and
    /// projects never wait on or cancel each other.
    actions: Mutex<HashMap<String, Arc<GraphActions>>>,
    records: Mutex<BTreeMap<String, Record>>,
    events: Mutex<Events>,
    viewers: Mutex<BTreeMap<String, Vec<Viewer>>>,
    /// Open connections per client name; viewers are dropped with the last one.
    connections: Mutex<HashMap<String, usize>>,
    /// Sessions that exited since the serve loop last looked for resume hints.
    exited: Mutex<Vec<String>>,
    confirmed: Mutex<Vec<(String, u64, Adapter, String)>>,
    maintenance: Mutex<HashMap<String, MaintenanceLease>>,
    operation: Mutex<()>,
    bulk_stop: Mutex<()>,
    persistence: Mutex<()>,
    instance: String,
    dir: PathBuf,
    /// Records or lifecycle changed: persisted within `SAVE_DIRTY`.
    dirty: AtomicBool,
    /// Only output arrived: persisted within `SAVE_OUTPUT`.
    output_dirty: AtomicBool,
    shutdown: AtomicBool,
    stopping: AtomicBool,
    clients: AtomicUsize,
    authority: AtomicUsize,
}
struct MaintenanceLease {
    project_id: String,
    component_ids: Vec<String>,
    expires: Instant,
}
const SAVE_DIRTY: Duration = Duration::from_millis(500);
const SAVE_OUTPUT: Duration = Duration::from_secs(5);
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
            // A record without a snapshot was saved mid-launch; nothing runs it any more, and
            // clients read a snapshot-less, uninterrupted record as a session still starting.
            if record.snapshot.is_none() {
                record.interrupted = true;
            }
            // Only the latest snapshot is known to belong to Record.spec. Older legacy
            // history has no folder metadata, so preserve None instead of guessing.
            if let Some(snapshot) = &mut record.snapshot
                && snapshot.launch_directory.is_none()
            {
                snapshot.launch_directory = Some(record.spec.cwd.clone());
            }
            if let Some(s) = &mut record.snapshot
                && s.running
            {
                s.running = false;
                record.interrupted = true;
            }
            record.history.iter_mut().for_each(|s| s.running = false);
            trim_history(&mut record.history);
        }
        let generation = records
            .values()
            .flat_map(|r| r.snapshot.iter().chain(r.history.iter()))
            .map(|s| s.generation)
            .max()
            .unwrap_or(0);
        anyhow::ensure!(
            generation < u64::MAX,
            "Invalid persisted process generation"
        );
        Ok(Arc::new(Self {
            pty: Arc::new(PtyManager::with_generation_floor(generation)),
            actions: Mutex::default(),
            records: Mutex::new(records),
            events: Mutex::default(),
            viewers: Mutex::default(),
            connections: Mutex::default(),
            exited: Mutex::default(),
            confirmed: Mutex::default(),
            maintenance: Mutex::default(),
            operation: Mutex::new(()),
            bulk_stop: Mutex::new(()),
            persistence: Mutex::new(()),
            instance: uuid::Uuid::new_v4().to_string(),
            dir: dir.into(),
            dirty: AtomicBool::new(true),
            output_dirty: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            clients: AtomicUsize::new(0),
            authority: AtomicUsize::new(0),
        }))
    }
    fn stop_all(&self, shutdown: bool, stop_running: bool) -> Result<()> {
        // Serialize bulk requests without holding locks needed by launches or rollback.
        let _bulk_stop = self.bulk_stop.lock().unwrap();
        {
            let _operation = self.operation.lock().unwrap();
            anyhow::ensure!(stop_running || !self.pty.has_running(), SHUTDOWN_REFUSED);
            self.stopping.store(true, Ordering::Release);
        }
        // Launches now fail under the operation lock. Never hold that lock (or
        // the registry lock) while acquiring a project's graph lock.
        let actions: Vec<_> = self.actions.lock().unwrap().values().cloned().collect();
        for action in actions {
            action.reset();
        }
        let result = (|| {
            if stop_running {
                let runs = self.pty.begin_stop_all();
                self.pty.finish_stop_all(&runs)?;
            }
            if shutdown {
                self.persist()?;
                self.shutdown.store(true, Ordering::Release);
            }
            Ok(())
        })();
        let _operation = self.operation.lock().unwrap();
        self.stopping.store(false, Ordering::Release);
        result
    }
    fn check_maintenance_block(&self, project_id: &str, components: &[String]) -> Result<()> {
        let mut leases = self.maintenance.lock().unwrap();
        leases.retain(|_, lease| lease.expires > Instant::now());
        anyhow::ensure!(
            !leases.values().any(|lease| lease.project_id == project_id
                && lease.component_ids.iter().any(|id| components.contains(id))),
            "Map maintenance is applying; retry after it finishes"
        );
        Ok(())
    }
    fn actions_for(&self, project_id: &str) -> Arc<GraphActions> {
        self.actions
            .lock()
            .unwrap()
            .entry(project_id.into())
            .or_default()
            .clone()
    }
    fn snapshot(&self, id: &str) -> Option<Snapshot> {
        self.pty
            .snapshot(id)
            .or_else(|| self.records.lock().unwrap().get(id)?.snapshot.clone())
    }
    /// Every record with its live snapshot, output included, for persistence.
    fn list(&self) -> Vec<Record> {
        let mut records: Vec<_> = self.records.lock().unwrap().values().cloned().collect();
        for r in &mut records {
            if let Some(s) = self.pty.snapshot(&r.id) {
                r.snapshot = Some(s);
            }
        }
        records
    }
    /// Records without output, environment or launch internals, for clients.
    /// Never copies a backlog.
    fn summaries(&self) -> Vec<Record> {
        let bare = |s: &Snapshot| Snapshot {
            launch_directory: s.launch_directory.clone(),
            data: Vec::new(),
            notice: s.notice.clone(),
            status: s.status.clone(),
            ..*s
        };
        let records = self.records.lock().unwrap();
        records
            .values()
            .map(|r| {
                let mut spec = r.spec.clone();
                spec.env.clear();
                spec.resume_command = None;
                spec.command.clone_from(&r.metadata.command);
                Record {
                    id: r.id.clone(),
                    metadata: r.metadata.clone(),
                    spec,
                    snapshot: self
                        .pty
                        .snapshot_with(&r.id, 0)
                        .or_else(|| r.snapshot.as_ref().map(bare)),
                    history: r.history.iter().map(bare).collect(),
                    launch_command: String::new(),
                    restart_context: None,
                    interrupted: r.interrupted,
                    request_ids: Vec::new(),
                }
            })
            .collect()
    }
    fn persist(&self) -> Result<()> {
        let _persistence = self.persistence.lock().unwrap();
        let records: BTreeMap<_, _> = self.list().into_iter().map(|r| (r.id.clone(), r)).collect();
        atomic_write(
            &self.dir.join("sessions.json"),
            &serde_json::to_vec(&records)?,
        )
    }
    fn owns(&self, client: &str, id: &str, viewer: &str) -> bool {
        self.viewers
            .lock()
            .unwrap()
            .get(id)
            .and_then(|v| v.iter().max_by_key(|v| v.order))
            .is_some_and(|v| v.client == client && v.viewer == viewer)
    }
    fn claim(&self, client: &str, id: String, viewer: String, claim: bool) {
        let mut viewers = self.viewers.lock().unwrap();
        let own = viewers.entry(id).or_default();
        let order = self.authority.fetch_add(1, Ordering::Relaxed) as u64 + 1;
        match own
            .iter_mut()
            .find(|v| v.client == client && v.viewer == viewer)
        {
            Some(v) if claim => v.order = order,
            Some(_) => {}
            None => own.push(Viewer {
                client: client.into(),
                viewer,
                order: if claim || own.is_empty() { order } else { 0 },
            }),
        }
    }
    fn connected(&self, client: &str) {
        *self
            .connections
            .lock()
            .unwrap()
            .entry(client.into())
            .or_default() += 1;
    }
    fn disconnected(&self, client: &str) {
        let mut connections = self.connections.lock().unwrap();
        let count = connections.entry(client.into()).or_default();
        *count = count.saturating_sub(1);
        if *count == 0 {
            connections.remove(client);
            for viewers in self.viewers.lock().unwrap().values_mut() {
                viewers.retain(|v| v.client != client);
            }
        }
    }
    /// Read the resume hints providers print as they exit, from the tail of each
    /// finished run. Runs outside the event path, which holds the backlog lock.
    fn capture_conversations(&self) {
        let confirmed = std::mem::take(&mut *self.confirmed.lock().unwrap());
        // Only the latest confirmation per session matters; each status event queues one.
        let mut handled = std::collections::HashSet::new();
        for (id, generation, adapter, conversation) in confirmed.into_iter().rev() {
            if !handled.insert(id.clone())
                || self
                    .pty
                    .snapshot_with(&id, 0)
                    .is_none_or(|s| s.generation != generation)
            {
                continue;
            }
            let mut records = self.records.lock().unwrap();
            if let Some(record) = records.get_mut(&id)
                && !record.metadata.conversation_pinned
                && record.metadata.adapter == Some(adapter)
                && record.metadata.conversation_id.as_ref() != Some(&conversation)
            {
                record.metadata.conversation_id = Some(conversation);
                self.dirty.store(true, Ordering::Release);
            }
        }
        let exited = std::mem::take(&mut *self.exited.lock().unwrap());
        for id in exited {
            let Some(tail) = self.pty.snapshot_with(&id, CAPTURE_TAIL) else {
                continue;
            };
            let mut records = self.records.lock().unwrap();
            let Some(record) = records.get_mut(&id) else {
                continue;
            };
            if record.metadata.conversation_pinned
                || tail.status.agent.as_ref().is_some_and(|a| a.authoritative)
            {
                continue;
            }
            if let Some(adapter) = record.metadata.adapter
                && let Some(conversation) = adapter.capture(&String::from_utf8_lossy(&tail.data))
            {
                record.metadata.conversation_id = Some(conversation);
                self.dirty.store(true, Ordering::Release);
            }
        }
    }
    fn start(
        self: &Arc<Self>,
        request: String,
        metadata: Metadata,
        mut spec: SessionSpec,
    ) -> Result<String> {
        let _pending = briefing::PendingBriefing::new(&spec);
        // An unreadable fingerprint disables automatic resume without blocking launch.
        let restart_context = restart_context(&metadata, &spec).ok().flatten();
        // Keep a service-owned copy before spawning. A timed-out sender can always remove
        // its pending file without invalidating a launch that the service accepted.
        crate::context::retain_owned_briefing(&mut spec)?;
        let candidate = crate::context::owned_briefing(&spec);
        let result = self.start_with_command(request, metadata, spec, None, false, restart_context);
        // A rejected or idempotent launch must not leave its pending briefing behind.
        if let Some(file) = candidate {
            self.remove_unused_briefing(&file);
        }
        result
    }
    fn remove_unused_briefing(&self, file: &Path) {
        if !self
            .records
            .lock()
            .unwrap()
            .values()
            .any(|record| crate::context::owned_briefing(&record.spec).as_deref() == Some(file))
        {
            crate::context::remove_owned_briefing_file(file);
        }
    }
    fn start_with_command(
        self: &Arc<Self>,
        request: String,
        mut metadata: Metadata,
        mut spec: SessionSpec,
        original_command: Option<String>,
        managed: bool,
        restart_context: Option<String>,
    ) -> Result<String> {
        anyhow::ensure!(!request.is_empty(), "Launch request ID required");
        let id = crate::model::task_session_id(
            &metadata.project_id,
            &metadata.component_id,
            &metadata.terminal_id,
            metadata.task.as_deref(),
        );
        spec.id.clone_from(&id);
        if let Some(adapter) = metadata.adapter {
            spec.env.insert(
                crate::agent_hooks::PROVIDER_ENV.into(),
                match adapter {
                    Adapter::Claude => "claude",
                    Adapter::Codex => "codex",
                }
                .into(),
            );
        }
        let _operation = self.operation.lock().unwrap();
        anyhow::ensure!(
            !self.stopping.load(Ordering::Acquire),
            "Sessions are stopping; retry after they finish"
        );
        self.check_maintenance_block(
            &metadata.project_id,
            std::slice::from_ref(&metadata.component_id),
        )?;
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
        let cwd = spec.cwd.canonicalize()?;
        let busy = self.records.lock().unwrap().values().any(|r| {
            if !(spec.exclusive_cwd || r.spec.exclusive_cwd) || !self.pty.is_running(&r.id) {
                return false;
            }
            let other = r
                .spec
                .cwd
                .canonicalize()
                .unwrap_or_else(|_| r.spec.cwd.clone());
            cwd.starts_with(&other) || other.starts_with(&cwd)
        });
        anyhow::ensure!(
            !busy,
            "An exclusive session requires an unused worktree; stop other terminals there first"
        );
        if let (Some(adapter), Some(conversation)) = (metadata.adapter, &metadata.conversation_id) {
            let running = self.records.lock().unwrap().values().any(|r| {
                r.metadata.adapter == Some(adapter)
                    && r.metadata.conversation_id.as_ref() == Some(conversation)
                    && self.pty.is_running(&r.id)
            });
            anyhow::ensure!(
                !running,
                "Conversation is already running; reconnect instead"
            );
        }
        // Every launch path (desktop, CLI, extensions and graph actions) records the task name.
        // A resumed or older request can keep its retained title if the task is no longer stored.
        if let Some(task) = metadata.task.as_deref()
            && let Ok(task) = crate::tasks::stored(Path::new(&metadata.project_root), task)
        {
            metadata.task_title = Some(task.title);
        }
        let previous = self.records.lock().unwrap().get(&id).cloned();
        let mut history = previous
            .as_ref()
            .map_or_else(Vec::new, |r| r.history.clone());
        if let Some(mut snapshot) = self.snapshot(&id) {
            if snapshot.launch_directory.is_none() {
                snapshot.launch_directory = previous.as_ref().map(|r| r.spec.cwd.clone());
            }
            history.push(snapshot);
        }
        trim_history(&mut history);
        let mut requests = previous
            .as_ref()
            .map_or_else(Vec::new, |r| r.request_ids.clone());
        requests.push(request);
        // Only recent launches can be retried; older request ids are useless.
        requests.drain(..requests.len().saturating_sub(16));
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
                restart_context,
                request_ids: requests,
            },
        );
        let spawned = if managed {
            self.pty.spawn_managed(spec, self.clone())
        } else {
            self.pty.spawn(spec, self.clone())
        };
        if let Err(e) = spawned {
            let mut records = self.records.lock().unwrap();
            if let Some(r) = previous {
                records.insert(id, r);
            } else {
                records.remove(&id);
            }
            return Err(e);
        }
        if let Some(previous) = previous
            && let Some(file) = crate::context::owned_briefing(&previous.spec)
        {
            self.remove_unused_briefing(&file);
        }
        // The serve loop persists shortly; a launch never waits on a full rewrite.
        self.dirty.store(true, Ordering::Release);
        Ok(id)
    }
    fn restart(
        self: &Arc<Self>,
        request_id: String,
        metadata: Metadata,
        spec: SessionSpec,
    ) -> Result<String> {
        let _pending = briefing::PendingBriefing::new(&spec);
        let id = crate::model::task_session_id(
            &metadata.project_id,
            &metadata.component_id,
            &metadata.terminal_id,
            metadata.task.as_deref(),
        );
        let record = self.records.lock().unwrap().get(&id).cloned();
        if let Some(record) = record {
            if record.request_ids.contains(&request_id) {
                return Ok(id);
            }
            let context = restart_context(&metadata, &spec).ok().flatten();
            if metadata.kind == TerminalKind::Agent
                && metadata.adapter.is_some()
                && context.is_some()
                && context == record.restart_context
            {
                // Read the final native hooks and output only for a matching restart.
                self.refresh_restart_conversation(&id);
                let mut record = self
                    .records
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .context("Unknown session")?;
                let mut metadata = metadata.clone();
                if !metadata.conversation_pinned {
                    metadata.conversation_id = record.metadata.conversation_id;
                    metadata.conversation_pinned = record.metadata.conversation_pinned;
                }
                // Resume the conversation with this launch's credentials, briefing and names.
                record.metadata = metadata;
                record.spec = spec.clone();
                crate::context::retain_owned_briefing(&mut record.spec)?;
                let candidate = crate::context::owned_briefing(&record.spec);
                record.launch_command.clone_from(&record.spec.command);
                if let Ok(original) = prepare_resume(&mut record) {
                    // Return launch errors: a lost reply must never cause a fresh launch.
                    let result = self.start_with_command(
                        request_id,
                        record.metadata,
                        record.spec,
                        Some(original),
                        false,
                        context,
                    );
                    if let Some(file) = candidate {
                        self.remove_unused_briefing(&file);
                    }
                    return result;
                }
                if let Some(file) = candidate {
                    self.remove_unused_briefing(&file);
                }
            }
        }
        self.start(request_id, metadata, spec)
    }

    fn refresh_restart_conversation(&self, id: &str) {
        let Some(snapshot) = self.pty.snapshot_with(id, CAPTURE_TAIL) else {
            return;
        };
        if snapshot.running {
            return;
        }
        let mut records = self.records.lock().unwrap();
        let Some(record) = records.get_mut(id) else {
            return;
        };
        if record.metadata.conversation_pinned {
            return;
        }
        let Some(adapter) = record.metadata.adapter else {
            return;
        };
        if let Some(conversation) = restart_conversation(adapter, &snapshot)
            && record.metadata.conversation_id.as_ref() != Some(&conversation)
        {
            record.metadata.conversation_id = Some(conversation);
            self.dirty.store(true, Ordering::Release);
        }
    }
    fn resume(self: &Arc<Self>, id: &str, request_id: String) -> Result<String> {
        let mut r = self
            .records
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("Unknown session")?;
        if r.request_ids.contains(&request_id) {
            return Ok(id.into());
        }
        let original = prepare_resume(&mut r)?;
        // Keep the original launch command for later resumes; context environment persists.
        self.start_with_command(
            request_id,
            r.metadata,
            r.spec,
            Some(original),
            false,
            r.restart_context,
        )
    }
    fn handle(self: &Arc<Self>, client: &str, request: Request) -> Result<serde_json::Value> {
        let result = match request {
            Request::List => serde_json::to_value(self.summaries())?,
            Request::AgentSession { token } => {
                let found = (!token.is_empty())
                    .then(|| {
                        let records = self.records.lock().unwrap();
                        records
                            .values()
                            .find(|r| {
                                r.spec.env.get(crate::agent_bridge::TOKEN_ENV) == Some(&token)
                            })
                            .map(|r| AgentSession {
                                id: r.id.clone(),
                                metadata: r.metadata.clone(),
                            })
                    })
                    .flatten();
                // A token lives as long as its process; a restart replaces it.
                let running = found.filter(|s| {
                    self.pty
                        .snapshot_with(&s.id, 0)
                        .is_some_and(|snapshot| snapshot.running)
                });
                serde_json::to_value(running)?
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
            Request::Restart {
                request_id,
                metadata,
                spec,
            } => serde_json::to_value(self.restart(request_id, *metadata, spec)?)?,
            Request::Snapshot { id } => serde_json::to_value(self.snapshot(&id))?,
            Request::PreviewUrls { id } => {
                serde_json::to_value(self.snapshot(&id).map(|s| PreviewScan {
                    generation: s.generation,
                    running: s.running,
                    urls: crate::extensions::preview_urls(&s.data),
                }))?
            }
            Request::PreviewUrlsBatch { ids } => {
                let mut urls = Vec::new();
                for id in ids {
                    if let Some(snapshot) = self.snapshot(&id) {
                        for url in crate::extensions::preview_urls(&snapshot.data) {
                            if !urls.contains(&url) {
                                urls.push(url);
                            }
                        }
                    }
                }
                serde_json::to_value(urls)?
            }
            Request::Attach { id, viewer, claim } => {
                self.claim(client, id.clone(), viewer, claim);
                serde_json::to_value(self.snapshot(&id))?
            }
            Request::Claim { id, viewer, claim } => {
                self.claim(client, id, viewer, claim);
                serde_json::Value::Null
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
                let project = self
                    .records
                    .lock()
                    .unwrap()
                    .get(&id)
                    .map(|r| r.metadata.project_id.clone());
                let stop = || {
                    let _operation = self.operation.lock().unwrap();
                    self.pty.stop(&id);
                };
                let actions =
                    project.and_then(|project| self.actions.lock().unwrap().get(&project).cloned());
                if let Some(actions) = actions {
                    actions.with_session_stop_guard(&id, stop);
                } else {
                    stop();
                }
                serde_json::Value::Null
            }
            Request::StopAll => {
                self.stop_all(false, true)?;
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
                        .take(POLL_LIMIT)
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
                record.metadata.conversation_pinned = true;
                self.dirty.store(true, Ordering::Release);
                serde_json::Value::Null
            }
            Request::Resume { id, request_id } => {
                serde_json::to_value(self.resume(&id, request_id)?)?
            }
            Request::Forget { id } => {
                let _operation = self.operation.lock().unwrap();
                anyhow::ensure!(
                    !self.pty.is_running(&id),
                    "Stop running work before forgetting it"
                );
                let forgotten = self.records.lock().unwrap().remove(&id);
                if let Some(record) = forgotten
                    && let Some(file) = crate::context::owned_briefing(&record.spec)
                {
                    self.remove_unused_briefing(&file);
                }
                self.pty.forget(&id);
                self.dirty.store(true, Ordering::Release);
                serde_json::Value::Null
            }
            Request::MaintenanceGuard {
                project_id,
                component_ids,
            } => {
                let ids: Vec<_> = self
                    .records
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|r| {
                        r.metadata.project_id == project_id
                            && component_ids.contains(&r.metadata.component_id)
                    })
                    .map(|r| r.id.clone())
                    .collect();
                // Match graph launch's lock order: action state before service operation.
                // Keep graph state held until the lease blocks every affected launch.
                self.actions_for(&project_id).with_maintenance_guard(&ids, &component_ids, || {
                    let _operation = self.operation.lock().unwrap();
                    self.check_maintenance_block(&project_id, &component_ids)?;
                    anyhow::ensure!(!self.records.lock().unwrap().values().any(|r| r.metadata.project_id == project_id && component_ids.contains(&r.metadata.component_id) && self.pty.is_running(&r.id)), "Stop this component's live sessions in every task before changing its folder or removing it");
                    let token = uuid::Uuid::new_v4().to_string();
                    self.maintenance.lock().unwrap().insert(token.clone(), MaintenanceLease { project_id, component_ids: component_ids.clone(), expires: Instant::now() + Duration::from_secs(30) });
                    serde_json::to_value(token)
                        .map_err(Into::into)
                })?
            }
            Request::TerminalCloseGuard {
                project_id,
                component_id,
                terminal_id,
            } => {
                let component_ids = vec![component_id.clone()];
                let ids: Vec<_> = self
                    .records
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|r| {
                        r.metadata.project_id == project_id
                            && r.metadata.component_id == component_id
                            && r.metadata.terminal_id == terminal_id
                    })
                    .map(|r| r.id.clone())
                    .collect();
                self.actions_for(&project_id).with_maintenance_guard(
                    &ids,
                    &component_ids,
                    || {
                        let _operation = self.operation.lock().unwrap();
                        self.check_maintenance_block(&project_id, &component_ids)?;
                        let token = uuid::Uuid::new_v4().to_string();
                        self.maintenance.lock().unwrap().insert(
                            token.clone(),
                            MaintenanceLease {
                                project_id: project_id.clone(),
                                component_ids: component_ids.clone(),
                                expires: Instant::now() + Duration::from_secs(30),
                            },
                        );
                        // Read again under the launch lock: a start may have completed while
                        // acquiring the graph guard. The lease rejects starts from every window.
                        let ids: Vec<_> = self
                            .records
                            .lock()
                            .unwrap()
                            .values()
                            .filter(|r| {
                                r.metadata.project_id == project_id
                                    && r.metadata.component_id == component_id
                                    && r.metadata.terminal_id == terminal_id
                            })
                            .map(|r| r.id.clone())
                            .collect();
                        for id in ids {
                            self.pty.stop(&id);
                        }
                        serde_json::to_value(token).map_err(Into::into)
                    },
                )?
            }
            Request::MaintenanceRelease { project_id, token } => {
                let mut leases = self.maintenance.lock().unwrap();
                if leases
                    .get(&token)
                    .is_some_and(|lease| lease.project_id == project_id)
                {
                    leases.remove(&token);
                }
                serde_json::Value::Null
            }
            Request::ActionRun { project, plan } => {
                self.check_maintenance_block(&plan.project_id, &plan.component_ids())?;
                let actions = self.actions_for(&plan.project_id);
                let epoch = actions.epoch();
                let project_id = plan.project_id.clone();
                let terminals = ServiceTerminals {
                    service: self.clone(),
                    project_id: &project_id,
                    project: Some(&project),
                };
                // `execute` rebuilds the plan against `project`, as restricted.
                serde_json::to_value(actions.execute(&project, *plan, epoch, &terminals)?)?
            }
            Request::ActionStopGroup {
                project_id,
                group_id,
                task,
            } => {
                let terminals = ServiceTerminals {
                    service: self.clone(),
                    project_id: &project_id,
                    project: None,
                };
                let actions = self.actions_for(&project_id);
                let epoch = actions.epoch();
                actions.stop_group(&project_id, &group_id, task.as_deref(), epoch, &terminals)?;
                serde_json::Value::Null
            }
            Request::ActionStopTask { project_id, task } => {
                let terminals = ServiceTerminals {
                    service: self.clone(),
                    project_id: &project_id,
                    project: None,
                };
                let actions = self.actions_for(&project_id);
                let epoch = actions.epoch();
                actions.stop_task(&project_id, &task, epoch, &terminals)?;
                serde_json::Value::Null
            }
            Request::ActionCancel { project_id } => {
                serde_json::to_value(self.actions_for(&project_id).cancel_validation())?
            }
            Request::Shutdown { stop_running } => {
                self.stop_all(true, stop_running)?;
                serde_json::Value::Null
            }
        };
        Ok(result)
    }
}
/// Check that resuming `record` stays within the folders the user has granted
/// now (`roots`): its working directory and every folder its recorded launch
/// added for the agent. Restoring a workspace doesn't restore grants, so a
/// resume must not quietly bring back access to a folder that is locked again.
///
/// # Errors
/// Fails naming the first folder that is no longer readable.
pub fn check_resume(record: &Record, roots: &[PathBuf]) -> Result<()> {
    for dir in std::iter::once(&record.spec.cwd).chain(&record.spec.dirs) {
        crate::files::resolve(roots, dir).with_context(|| {
            format!(
                "{} is locked. Allow it (Browse… or Add repo…) before resuming, or start a fresh session.",
                dir.display()
            )
        })?;
    }
    Ok(())
}

/// Graph actions' view of the service's terminals: launches are recorded like
/// any other start, under the project's identity.
struct ServiceTerminals<'a> {
    service: Arc<Service>,
    project_id: &'a str,
    /// The project launches belong to; `None` where nothing is launched.
    project: Option<&'a crate::Project>,
}
impl Terminals for ServiceTerminals<'_> {
    fn snapshot(&self, id: &str) -> Option<Snapshot> {
        self.service.pty.snapshot_with(id, 0)
    }
    fn is_running(&self, id: &str) -> bool {
        self.service.pty.is_running(id)
    }
    fn launch_matches(&self, spec: &SessionSpec) -> bool {
        self.service.pty.launch_matches(spec)
    }
    fn launch(&self, launch: Launch) -> Result<()> {
        let Launch {
            spec,
            component_id,
            terminal,
            task,
        } = launch;
        let id = spec.id.clone();
        let project = self.project.context("Nothing may be launched here")?;
        let metadata = Metadata {
            project_id: self.project_id.into(),
            project_name: project.name.clone(),
            project_root: project.root.clone(),
            component_id,
            terminal_id: terminal.id.clone(),
            task,
            task_title: None,
            name: terminal.name.clone(),
            kind: terminal.kind,
            adapter: None,
            conversation_id: None,
            conversation_pinned: false,
            extension_id: None,
            command_id: None,
            key: None,
            branch: None,
            command: terminal.command.clone(),
        };
        let started = self.service.start_with_command(
            uuid::Uuid::new_v4().to_string(),
            metadata,
            spec,
            None,
            true,
            None,
        )?;
        anyhow::ensure!(started == id, "Graph action session id mismatch for {id}");
        Ok(())
    }
    fn stop_generation(&self, id: &str, generation: u64) -> Result<()> {
        self.service.pty.stop_generation(id, generation)
    }
}

/// Prefer the final native conversation, then the provider's exit hint, so new evidence
/// after `/clear` replaces the stored ID. Without a hint, callers retain the known ID.
fn restart_conversation(adapter: Adapter, snapshot: &Snapshot) -> Option<String> {
    let agent = snapshot
        .status
        .agent
        .as_ref()
        .filter(|a| a.provider == Some(adapter));
    agent
        .filter(|a| a.authoritative)
        .and_then(|a| a.conversation_id.clone())
        .or_else(|| adapter.capture(&String::from_utf8_lossy(&snapshot.data)))
        .or_else(|| agent.and_then(|a| a.conversation_id.clone()))
}

/// Validate and prepare before spawning, so a definite refusal may safely start fresh.
fn prepare_resume(r: &mut Record) -> Result<String> {
    let adapter = r
        .metadata
        .adapter
        .context("Select an adapter to resume this conversation")?;
    let conversation = r
        .metadata
        .conversation_id
        .as_ref()
        .context("Set conversation ID before resuming")?;
    // The recorded command points at its briefing; never resume without it.
    if let Some(file) = r.spec.env.get(crate::context::CONTEXT_ENV) {
        anyhow::ensure!(
            Path::new(file).is_file(),
            "This agent's briefing is gone (temporary files were cleaned up). Start it again instead of resuming."
        );
    }
    let original = if r.launch_command.is_empty() {
        r.spec.command.clone()
    } else {
        r.launch_command.clone()
    };
    let resume_command = r.spec.resume_command.as_deref().unwrap_or(&original);
    r.spec.command = adapter.resume(resume_command, conversation, &r.spec.cwd)?;
    crate::adapters::require_executable(&r.spec.command, &r.spec.cwd, &r.spec.env)?;
    Ok(original)
}

/// A stable digest: temporary bridge credentials and decorated resume commands are excluded.
fn restart_context(metadata: &Metadata, spec: &SessionSpec) -> Result<Option<String>> {
    if metadata.kind != TerminalKind::Agent {
        return Ok(None);
    }
    let briefing = spec
        .env
        .get(crate::context::CONTEXT_ENV)
        .map(std::fs::read_to_string)
        .transpose()?;
    let briefing = briefing
        .map(|text| {
            crate::plans::restart_briefing(
                &text,
                Path::new(&metadata.project_root),
                metadata.task.as_deref(),
            )
        })
        .transpose()?;
    let settings = serde_json::to_string(&(
        &metadata.command,
        metadata.kind,
        metadata.adapter,
        &spec.cwd,
        &spec.dirs,
        &spec.ready_when,
        spec.service,
        &spec.resume_command,
        &briefing,
    ))?;
    Ok(Some(crate::workspace::session_id("restart", &settings, "")))
}

/// Keep the newest `MAX_HISTORY` incarnations.
fn trim_history(history: &mut Vec<Snapshot>) {
    history.drain(..history.len().saturating_sub(MAX_HISTORY));
}
impl EventSink for Service {
    fn emit(&self, event: TerminalEvent) {
        // Called by the PTY threads, sometimes under a backlog lock: never read
        // backlogs here.
        if let TerminalEvent::Status {
            session_id,
            generation,
            status,
        } = &event
            && let Some(agent) = &status.agent
            && agent.authoritative
            && let (Some(adapter), Some(conversation)) = (agent.provider, &agent.conversation_id)
        {
            self.confirmed.lock().unwrap().push((
                session_id.clone(),
                *generation,
                adapter,
                conversation.clone(),
            ));
        }
        let output = matches!(event, TerminalEvent::Output { .. });
        if let TerminalEvent::Exited { session_id, .. } = &event {
            self.exited.lock().unwrap().push(session_id.clone());
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
        if output {
            self.output_dirty.store(true, Ordering::Release);
        } else {
            self.dirty.store(true, Ordering::Release);
        }
    }
}

/// Run the session service in this process until it is shut down, or has had
/// no clients and no running work for a minute.
///
/// # Errors
/// Fails if the runtime directory, lock, listener or records can't be set up.
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
    let mut saved_output = Instant::now();
    let next = AtomicUsize::new(1);
    while !service.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let service = service.clone();
                let token = token.clone();
                let connection = next.fetch_add(1, Ordering::Relaxed);
                // Counted before the handshake, so the idle check below can't
                // shut down under a client that is still connecting.
                service.clients.fetch_add(1, Ordering::AcqRel);
                std::thread::spawn(move || {
                    serve_connection(&service, &mut stream, &token, connection);
                    service.clients.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        service.capture_conversations();
        let metadata = saved.elapsed() >= SAVE_DIRTY && service.dirty.swap(false, Ordering::AcqRel);
        let output = saved_output.elapsed() >= SAVE_OUTPUT
            && service.output_dirty.swap(false, Ordering::AcqRel);
        if metadata || output {
            if let Err(e) = service.persist() {
                eprintln!("Session persistence failed: {e}");
                service.dirty.store(true, Ordering::Release);
            } else {
                // A full write covers pending output too.
                service.output_dirty.store(false, Ordering::Release);
                saved_output = Instant::now();
            }
            saved = Instant::now();
        }
        if service.clients.load(Ordering::Acquire) > 0 || service.pty.has_running() {
            idle = Instant::now();
        }
        if idle.elapsed() >= Duration::from_secs(60) {
            // Withdraw the endpoint before the last idle check, so a client either
            // connected already (and is counted) or finds no endpoint and starts
            // a new service once this one releases its lock.
            let _ = std::fs::remove_file(dir.join("endpoint.json"));
            std::thread::sleep(Duration::from_millis(50));
            if let Ok((stream, _)) = listener.accept() {
                drop(stream);
            }
            if service.clients.load(Ordering::Acquire) == 0 && !service.pty.has_running() {
                break;
            }
            atomic_write(
                &dir.join("endpoint.json"),
                &serde_json::to_vec(&Endpoint {
                    protocol: PROTOCOL,
                    port: endpoint.port,
                    token: token.to_string(),
                    instance: service.instance.clone(),
                })?,
            )?;
            idle = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    service.capture_conversations();
    service.persist()?;
    match std::fs::remove_file(dir.join("endpoint.json")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    drop(lifetime);
    Ok(())
}

fn serve_connection(
    service: &Arc<Service>,
    stream: &mut TcpStream,
    token: &str,
    connection: usize,
) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let Ok(hello) = read_frame::<Hello>(stream) else {
        return;
    };
    let valid = hello.protocol == PROTOCOL && hello.token == token;
    let reply = if valid {
        Response::result(Ok(serde_json::Value::Null))
    } else {
        Response::result(Err(anyhow::anyhow!(
            "Session service authentication/protocol mismatch"
        )))
    };
    if write_frame(stream, &reply).is_err() || !valid {
        return;
    }
    // Clients poll regularly, so an idle read means the client is gone; long
    // requests are timed on the client side.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));
    let client = hello.client.map_or_else(
        || format!("connection-{connection}"),
        |c| format!("client-{c}"),
    );
    service.connected(&client);
    while let Ok(request) = read_frame::<Request>(stream) {
        let reply = Response::result(service.handle(&client, request));
        if write_frame(stream, &reply).is_err() {
            break;
        }
    }
    service.disconnected(&client);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_or_malformed_protocol_frames() {
        assert!(read_frame::<Request>(&mut &u32::MAX.to_be_bytes()[..]).is_err());
        assert!(read_frame::<Request>(&mut &[0, 0, 0, 2, b'[', b']'][..]).is_err());
    }
    #[test]
    fn retire_wire_format_is_stable() {
        // Every protocol since 1 reads these frames; newer builds retire older
        // services with them, so they must never change shape.
        let hello = Hello {
            protocol: 4,
            token: "t".into(),
            client: None,
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            serde_json::json!({"protocol": 4, "token": "t", "client": null})
        );
        assert_eq!(
            serde_json::to_value(Request::Shutdown { stop_running: true }).unwrap(),
            serde_json::json!({"op": "shutdown", "stop_running": true})
        );
        let reply: Response =
            serde_json::from_value(serde_json::json!({"result": null, "error": "no"})).unwrap();
        assert_eq!(reply.error.as_deref(), Some("no"));
    }
    #[test]
    fn retires_only_an_older_service_in_its_own_protocol() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        assert_eq!(retire_outdated(&dir, false).unwrap(), None);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let old = PROTOCOL - 1;
        let endpoint = Endpoint {
            protocol: old,
            port: listener.local_addr().unwrap().port(),
            token: "secret".into(),
            instance: "old".into(),
        };
        atomic_write(
            &dir.join("endpoint.json"),
            &serde_json::to_vec(&endpoint).unwrap(),
        )
        .unwrap();
        // A stale endpoint whose service is gone is left for `ensure` to replace.
        assert_eq!(retire_outdated(&dir, false).unwrap(), None);
        let lifetime = lock(&dir.join("service.lock")).unwrap();
        lifetime.try_lock().unwrap();
        // The old service refuses while work runs, then accepts `stop_running`.
        let server = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let hello: serde_json::Value = read_frame(&mut stream).unwrap();
                assert_eq!(hello["protocol"], old);
                assert_eq!(hello["token"], "secret");
                write_frame(
                    &mut stream,
                    &serde_json::json!({"result": null, "error": null}),
                )
                .unwrap();
                let request: serde_json::Value = read_frame(&mut stream).unwrap();
                assert_eq!(request["op"], "shutdown");
                let stop_running = request["stop_running"].as_bool().unwrap();
                asked.push(stop_running);
                let error = (!stop_running).then_some(SHUTDOWN_REFUSED);
                write_frame(
                    &mut stream,
                    &serde_json::json!({"result": null, "error": error}),
                )
                .unwrap();
            }
            asked
        });
        let refused = retire_outdated(&dir, false).unwrap_err().to_string();
        assert!(refused.contains("still running work"), "{refused}");
        // Reconnects do not keep asking this instance to shut down.
        assert!(
            retire_outdated(&dir, false)
                .unwrap_err()
                .is::<RetirementRefused>()
        );
        assert!(
            Client::ensure(&dir, Path::new("missing helper"))
                .err()
                .unwrap()
                .is::<RetirementRefused>()
        );
        assert_eq!(retire_outdated(&dir, true).unwrap(), Some(old));
        assert_eq!(server.join().unwrap(), [false, true]);
        drop(lifetime);
        let _ = std::fs::remove_dir_all(dir);
    }
    struct RetirementFixture {
        dir: PathBuf,
        endpoint: Endpoint,
        listener: TcpListener,
        _lifetime: std::fs::File,
    }
    impl RetirementFixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            private_dir(&dir).unwrap();
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let endpoint = Endpoint {
                protocol: PROTOCOL - 1,
                port: listener.local_addr().unwrap().port(),
                token: "secret".into(),
                instance: "older".into(),
            };
            let lifetime = lock(&dir.join("service.lock")).unwrap();
            lifetime.try_lock().unwrap();
            let fixture = Self {
                dir,
                endpoint,
                listener,
                _lifetime: lifetime,
            };
            fixture.save_endpoint();
            fixture
        }
        fn save_endpoint(&self) {
            atomic_write(
                &self.dir.join("endpoint.json"),
                &serde_json::to_vec(&self.endpoint).unwrap(),
            )
            .unwrap();
        }
        fn accept(listener: &TcpListener, protocol: u32) -> TcpStream {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let hello: Hello = read_frame(&mut stream).unwrap();
            assert_eq!(hello.protocol, protocol);
            assert_eq!(hello.token, "secret");
            write_frame(&mut stream, &Response::result(Ok(serde_json::Value::Null))).unwrap();
            stream
        }
    }
    impl Drop for RetirementFixture {
        fn drop(&mut self) {
            if let Some(cache) = RETIREMENT_REFUSALS.get() {
                cache.lock().unwrap().remove(&self.dir);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn never_retires_current_or_newer_protocols_even_when_forced() {
        let mut f = RetirementFixture::new();
        for protocol in [PROTOCOL, PROTOCOL + 1] {
            f.endpoint.protocol = protocol;
            f.save_endpoint();
            for forced in [false, true] {
                assert_eq!(retire_outdated(&f.dir, forced).unwrap(), None);
            }
        }
        let error = Client::ensure_until(
            &f.dir,
            Path::new("missing helper"),
            None,
            Instant::now() + Duration::from_millis(80),
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("unavailable"), "{error}");
        // No connection, and in particular no Shutdown, was sent to the newer service.
        f.listener.set_nonblocking(true).unwrap();
        assert_eq!(
            f.listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let saved: Endpoint =
            serde_json::from_slice(&std::fs::read(f.dir.join("endpoint.json")).unwrap()).unwrap();
        assert_eq!(saved.protocol, PROTOCOL + 1);
    }

    #[test]
    fn a_replacement_instance_gets_a_fresh_retirement_attempt() {
        let mut f = RetirementFixture::new();
        let listener = f.listener.try_clone().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let mut stream = RetirementFixture::accept(&listener, PROTOCOL - 1);
                assert!(matches!(
                    read_frame::<Request>(&mut stream).unwrap(),
                    Request::Shutdown {
                        stop_running: false
                    }
                ));
                write_frame(
                    &mut stream,
                    &Response::result(Err(anyhow::anyhow!(SHUTDOWN_REFUSED))),
                )
                .unwrap();
            }
        });
        assert!(
            retire_outdated(&f.dir, false)
                .unwrap_err()
                .is::<RetirementRefused>()
        );
        f.endpoint.instance = "replacement".into();
        f.save_endpoint();
        assert!(
            retire_outdated(&f.dir, false)
                .unwrap_err()
                .is::<RetirementRefused>()
        );
        server.join().unwrap();
    }

    #[test]
    fn other_service_errors_are_not_running_work_refusals_or_cached() {
        let f = RetirementFixture::new();
        let listener = f.listener.try_clone().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let mut stream = RetirementFixture::accept(&listener, PROTOCOL - 1);
                let _: Request = read_frame(&mut stream).unwrap();
                write_frame(
                    &mut stream,
                    &Response::result(Err(anyhow::anyhow!("Persistence failed"))),
                )
                .unwrap();
            }
        });
        for _ in 0..2 {
            let error = retire_outdated(&f.dir, false).unwrap_err();
            assert!(!error.is::<RetirementRefused>());
            assert_eq!(error.to_string(), "Persistence failed");
        }
        server.join().unwrap();
    }

    #[test]
    fn startup_retries_after_a_successful_shutdown_loses_its_reply() {
        let f = RetirementFixture::new();
        let listener = f.listener.try_clone().unwrap();
        let dir = f.dir.clone();
        let server = std::thread::spawn(move || {
            let mut stream = RetirementFixture::accept(&listener, PROTOCOL - 1);
            assert!(matches!(
                read_frame::<Request>(&mut stream).unwrap(),
                Request::Shutdown {
                    stop_running: false
                }
            ));
            // The replacement is ready, but the retiring service's reply was lost.
            atomic_write(
                &dir.join("endpoint.json"),
                &serde_json::to_vec(&Endpoint {
                    protocol: PROTOCOL,
                    port: listener.local_addr().unwrap().port(),
                    token: "secret".into(),
                    instance: "replacement".into(),
                })
                .unwrap(),
            )
            .unwrap();
            drop(stream);
            let _stream = RetirementFixture::accept(&listener, PROTOCOL);
        });
        let client = Client::ensure_until(
            &f.dir,
            Path::new("missing helper"),
            None,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(client.instance, "replacement");
        server.join().unwrap();
    }

    #[test]
    fn startup_deadline_bounds_slow_handshake_and_shutdown() {
        for handshake in [true, false] {
            let f = RetirementFixture::new();
            let listener = f.listener.try_clone().unwrap();
            let (done, wait) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let _: Hello = read_frame(&mut stream).unwrap();
                if !handshake {
                    write_frame(&mut stream, &Response::result(Ok(serde_json::Value::Null)))
                        .unwrap();
                    let _: Request = read_frame(&mut stream).unwrap();
                }
                wait.recv_timeout(Duration::from_secs(2)).unwrap();
            });
            let start = Instant::now();
            let error = Client::ensure_until(
                &f.dir,
                Path::new("missing helper"),
                None,
                start + Duration::from_millis(120),
            )
            .err()
            .unwrap();
            assert!(start.elapsed() < Duration::from_secs(1));
            assert!(!error.is::<RetirementRefused>());
            assert!(!error.to_string().contains("still running work"));
            done.send(()).unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn startup_deadline_includes_waiting_for_another_launcher() {
        let f = RetirementFixture::new();
        let startup = lock(&f.dir.join("startup.lock")).unwrap();
        startup.lock().unwrap();
        let start = Instant::now();
        let error = Client::ensure_until(
            &f.dir,
            Path::new("missing helper"),
            None,
            start + Duration::from_millis(80),
        )
        .err()
        .unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(error.to_string().contains("startup lock"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn terminal_close_guard_stops_every_worktree_and_blocks_late_launches() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({ "projectId":"p", "projectName":"P", "projectRoot":dir.display().to_string(), "componentId":"web", "terminalId":"shell", "name":"Shell", "kind":"shell" })).unwrap();
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: String::new(),
            command: "cat".into(),
            cwd: dir.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let own = service
            .start("own".into(), metadata.clone(), spec.clone())
            .unwrap();
        let mut task = metadata.clone();
        task.task = Some("task".into());
        let other = service.start("task".into(), task, spec.clone()).unwrap();
        let mut unrelated = metadata.clone();
        unrelated.terminal_id = "dev".into();
        let kept = service
            .start("kept".into(), unrelated, spec.clone())
            .unwrap();
        let token: String = serde_json::from_value(
            service
                .handle(
                    "desktop",
                    Request::TerminalCloseGuard {
                        project_id: "p".into(),
                        component_id: "web".into(),
                        terminal_id: "shell".into(),
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert!(
            service
                .start("late".into(), metadata.clone(), spec.clone())
                .is_err()
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.pty.is_running(&own) || service.pty.is_running(&other) {
            assert!(Instant::now() < deadline, "closed terminal still running");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(service.pty.is_running(&kept));
        service
            .handle(
                "desktop",
                Request::MaintenanceRelease {
                    project_id: "p".into(),
                    token,
                },
            )
            .unwrap();
        let restarted = service.start("restored".into(), metadata, spec).unwrap();
        service.pty.stop(&restarted);
        service.pty.stop(&kept);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn service_stops_cancel_staged_startups_without_stopping_unrelated_projects() {
        use crate::actions::ActionRequest;
        for bulk in [false, true] {
            let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            private_dir(&dir).unwrap();
            let service = Service::load(&dir).unwrap();
            let project: crate::Project = serde_json::from_value(serde_json::json!({
                "name":"P", "root":dir, "components":[
                    {"id":"first", "name":"First", "path":".", "terminals":[
                        {"id":"dev", "name":"Dev", "kind":"task", "command":"sleep 30",
                            "readyWhen":"NEVER", "action":"development"}]},
                    {"id":"later", "name":"Later", "path":".", "terminals":[
                        {"id":"dev", "name":"Dev", "kind":"task", "command":"sleep 30",
                            "action":"development"}]}],
                "links":[{"id":"dependency", "source":"later", "target":"first"}],
                "groups":[{"id":"dev", "name":"Dev", "componentIds":["first","later"],
                    "orderedStartup":true}]
            }))
            .unwrap();
            let other: Metadata = serde_json::from_value(serde_json::json!({
                "projectId":"other", "projectName":"Other", "projectRoot":dir,
                "componentId":"shell", "terminalId":"shell", "name":"Shell", "kind":"shell"
            }))
            .unwrap();
            let other = service
                .start(
                    "other".into(),
                    other,
                    SessionSpec {
                        resume_command: None,
                        owns_briefing: false,
                        exclusive_cwd: false,
                        merge_source: None,
                        id: String::new(),
                        command: "cat".into(),
                        cwd: dir.clone(),
                        env: BTreeMap::new(),
                        ready_when: String::new(),
                        service: false,
                        notice: None,
                        dirs: vec![],
                    },
                )
                .unwrap();
            let plan = ActionPlan::build(
                &project,
                "p",
                ActionRequest::StartGroup {
                    group_id: "dev".into(),
                },
                None,
            )
            .unwrap();
            let worker_service = service.clone();
            let worker = std::thread::spawn(move || {
                worker_service.handle(
                    "desktop",
                    Request::ActionRun {
                        project: Box::new(project),
                        plan: Box::new(plan),
                    },
                )
            });
            let first = crate::model::task_session_id("p", "first", "dev", None);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !service.pty.is_running(&first) {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            service
                .handle(
                    "desktop",
                    if bulk {
                        Request::StopAll
                    } else {
                        Request::Stop { id: first }
                    },
                )
                .unwrap();
            assert!(worker.join().unwrap().is_err());
            let later = crate::model::task_session_id("p", "later", "dev", None);
            assert!(service.snapshot(&later).is_none());
            assert_eq!(service.pty.is_running(&other), !bulk);
            assert!(!service.shutdown.load(Ordering::Acquire));
            service.handle("desktop", Request::StopAll).unwrap();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[cfg(unix)]
    mod stop_requests {
        use super::*;
        use crate::actions::{ActionReport, ActionRequest, TaskOutcome};

        struct Fixture {
            dir: PathBuf,
            service: Arc<Service>,
            project: crate::Project,
        }
        impl Fixture {
            fn new() -> Self {
                let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
                private_dir(&dir).unwrap();
                let project = serde_json::from_value(serde_json::json!({
                    "name":"P", "root":dir, "components":[
                        {"id":"first", "name":"First", "path":".", "terminals":[
                            {"id":"dev", "name":"Dev", "kind":"task",
                                "command":"while test ! -f ready; do sleep 0.02; done; printf 'READY\\n'; cat",
                                "readyWhen":"READY", "action":"development"},
                            {"id":"check", "name":"Check", "kind":"task",
                                "command":"sleep 30", "action":"validation"}]},
                        {"id":"later", "name":"Later", "path":".", "terminals":[
                            {"id":"dev", "name":"Dev", "kind":"task", "command":"cat",
                                "action":"development"},
                            {"id":"check", "name":"Check", "kind":"task", "command":"exit 0",
                                "action":"validation"}]},
                        {"id":"library", "name":"Library", "path":".", "terminals":[]}],
                    "links":[{"id":"dependency", "source":"later", "target":"first"}],
                    "groups":[{"id":"dev", "name":"Dev", "componentIds":["first","later","library"],
                        "orderedStartup":true}]
                })).unwrap();
                let service = Service::load(&dir).unwrap();
                Self {
                    dir,
                    service,
                    project,
                }
            }
            fn run(
                &self,
                request: ActionRequest,
            ) -> std::thread::JoinHandle<Result<serde_json::Value>> {
                let plan = ActionPlan::build(&self.project, "p", request, None).unwrap();
                let project = self.project.clone();
                let service = self.service.clone();
                std::thread::spawn(move || {
                    service.handle(
                        "desktop",
                        Request::ActionRun {
                            project: Box::new(project),
                            plan: Box::new(plan),
                        },
                    )
                })
            }
            fn wait_running(&self, id: &str) {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !self.service.pty.is_running(id) {
                    assert!(Instant::now() < deadline, "{id} never started");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            fn manual(&self, request: &str, command: &str) -> String {
                let metadata = serde_json::from_value(serde_json::json!({
                    "projectId":"p", "projectName":"P", "projectRoot":self.dir,
                    "componentId":"unrelated", "terminalId":"dev", "name":"Dev", "kind":"task"
                }))
                .unwrap();
                self.service
                    .start(
                        request.into(),
                        metadata,
                        SessionSpec {
                            resume_command: None,
                            owns_briefing: false,
                            exclusive_cwd: false,
                            merge_source: None,
                            id: String::new(),
                            command: command.into(),
                            cwd: self.dir.clone(),
                            env: BTreeMap::new(),
                            ready_when: String::new(),
                            service: false,
                            notice: None,
                            dirs: vec![],
                        },
                    )
                    .unwrap()
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                self.service.handle("desktop", Request::StopAll).unwrap();
                std::fs::remove_dir_all(&self.dir).unwrap();
            }
        }

        #[test]
        fn stop_request_for_one_validator_preserves_report_and_runs_the_rest() {
            let f = Fixture::new();
            let worker = f.run(ActionRequest::ValidateAffected {
                component_id: "first".into(),
            });
            let first = crate::model::task_session_id("p", "first", "check", None);
            f.wait_running(&first);
            f.service
                .handle("desktop", Request::Stop { id: first })
                .unwrap();
            let report: ActionReport =
                serde_json::from_value(worker.join().unwrap().unwrap()).unwrap();
            assert_eq!(report.results.len(), 2);
            assert!(matches!(report.results[0].outcome, TaskOutcome::Stopped));
            assert!(matches!(report.results[1].outcome, TaskOutcome::Passed));
            assert_eq!(f.service.actions_for("p").epoch(), 0);
        }

        #[test]
        fn restarting_unrelated_terminal_preserves_startup_and_its_scope() {
            let f = Fixture::new();
            let unrelated = f.manual("manual", "cat");
            let worker = f.run(ActionRequest::StartGroup {
                group_id: "dev".into(),
            });
            f.wait_running(&crate::model::task_session_id("p", "first", "dev", None));
            f.service
                .handle(
                    "desktop",
                    Request::Stop {
                        id: unrelated.clone(),
                    },
                )
                .unwrap();
            f.manual("restart", "cat");
            std::fs::write(f.dir.join("ready"), "").unwrap();
            worker.join().unwrap().unwrap();
            let actions = f.service.actions_for("p");
            assert_eq!(actions.epoch(), 0);
            assert!(
                actions
                    .with_maintenance_guard(&[], &["library".into()], || Ok(()))
                    .is_err()
            );
            f.service
                .handle(
                    "desktop",
                    Request::ActionStopGroup {
                        project_id: "p".into(),
                        group_id: "dev".into(),
                        task: None,
                    },
                )
                .unwrap();
            assert!(
                actions
                    .with_maintenance_guard(&[], &["library".into()], || Ok(()))
                    .is_ok()
            );
            assert!(f.service.pty.is_running(&unrelated));
        }

        #[test]
        fn bulk_stop_releases_launch_lock_and_rejects_new_work_during_grace() {
            let f = Fixture::new();
            let id = f.manual("stubborn", "trap '' HUP; printf 'READY\\n'; cat");
            let deadline = Instant::now() + Duration::from_secs(5);
            while !f
                .service
                .pty
                .snapshot(&id)
                .unwrap()
                .data
                .windows(5)
                .any(|s| s == b"READY")
            {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            let service = f.service.clone();
            let worker = std::thread::spawn(move || service.handle("desktop", Request::StopAll));
            while !f.service.stopping.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
            // Even requests that require the operation lock remain responsive.
            let started = Instant::now();
            f.service
                .handle(
                    "desktop",
                    Request::Forget {
                        id: "unknown".into(),
                    },
                )
                .unwrap();
            assert!(started.elapsed() < Duration::from_millis(500));
            assert!(f.service.operation.try_lock().is_ok());
            assert!(f.service.actions.try_lock().is_ok());
            let metadata = f
                .service
                .records
                .lock()
                .unwrap()
                .get(&id)
                .unwrap()
                .metadata
                .clone();
            let spec = f
                .service
                .records
                .lock()
                .unwrap()
                .get(&id)
                .unwrap()
                .spec
                .clone();
            let error = f.service.start("late".into(), metadata, spec).unwrap_err();
            assert!(
                error.to_string().contains("Sessions are stopping"),
                "{error}"
            );
            let service = f.service.clone();
            let second_stop =
                std::thread::spawn(move || service.handle("desktop", Request::StopAll));
            let service = f.service.clone();
            let shutdown = std::thread::spawn(move || {
                service.handle("desktop", Request::Shutdown { stop_running: true })
            });
            worker.join().unwrap().unwrap();
            second_stop.join().unwrap().unwrap();
            shutdown.join().unwrap().unwrap();
            assert!(f.service.shutdown.load(Ordering::Acquire));
            assert!(!f.service.pty.is_running(&id));
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_all_retains_records_and_service_can_start_again() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: String::new(),
            command: "echo retained; sleep 30".into(),
            cwd: dir.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let metadata = |project: &str| -> Metadata {
            serde_json::from_value(
                serde_json::json!({"projectId":project, "projectName":project,
                "projectRoot":dir.display().to_string(), "componentId":"web",
                "terminalId":"shell", "name":"Shell", "kind":"shell"}),
            )
            .unwrap()
        };
        let one = service
            .start("one".into(), metadata("one"), spec.clone())
            .unwrap();
        service
            .start("two".into(), metadata("two"), spec.clone())
            .unwrap();
        service.handle("desktop", Request::StopAll).unwrap();
        assert!(!service.shutdown.load(Ordering::Acquire));
        assert_eq!(service.list().len(), 2);
        assert!(
            service
                .list()
                .iter()
                .all(|r| r.snapshot.as_ref().is_some_and(|s| !s.running))
        );
        assert!(service.snapshot(&one).is_some());
        let restarted = service
            .start("restart".into(), metadata("one"), spec)
            .unwrap();
        assert!(service.pty.is_running(&restarted));
        service
            .handle("desktop", Request::Stop { id: restarted })
            .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stopping_an_idle_service_returns_without_grace_or_persistence_work() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        service.dirty.store(false, Ordering::Release);
        let started = Instant::now();
        service.handle("desktop", Request::StopAll).unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!service.dirty.load(Ordering::Acquire));
        assert!(!service.stopping.load(Ordering::Acquire));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn task_title_and_project_subfolder_survive_service_restart() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let root = dir.join("repo/project");
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            std::process::Command::new("git")
                .args(["init", "--quiet"])
                .arg(dir.join("repo"))
                .status()
                .unwrap()
                .success()
        );
        let store = crate::tasks::store_dir(&root).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(
            store.join("tasks.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "tasks": [{ "id": "t1", "title": "Retained work",
                    "worktree": dir.join("repo") }]
            }))
            .unwrap(),
        )
        .unwrap();
        // Older callers omit taskTitle; the service enriches every launch centrally.
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId": "p", "projectName": "P", "projectRoot": root,
            "componentId": "web", "terminalId": "shell", "task": "t1",
            "name": "Shell", "kind": "shell"
        }))
        .unwrap();
        assert!(metadata.task_title.is_none());
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: "ignored".into(),
            command: "printf done".into(),
            cwd: root.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: Vec::new(),
        };
        let state = dir.join("state");
        let service = Service::load(&state).unwrap();
        let id = service.start("start".into(), metadata, spec).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.pty.is_running(&id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!service.pty.is_running(&id));
        service.persist().unwrap();
        // The task list needn't be present to recover the session's display identity.
        std::fs::remove_file(store.join("tasks.json")).unwrap();
        let restored = Service::load(&state).unwrap();
        let record = &restored.list()[0];
        assert_eq!(record.metadata.task_title.as_deref(), Some("Retained work"));
        assert_eq!(record.metadata.project_root, root.display().to_string());
        let json = serde_json::to_value(&record.metadata).unwrap();
        assert_eq!(json["taskTitle"], "Retained work");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn load_marks_snapshotless_records_interrupted() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let record: Record = serde_json::from_value(serde_json::json!({
            "id":"starting", "metadata":{"projectId":"p", "projectName":"P",
                "projectRoot":dir.display().to_string(), "componentId":"web",
                "terminalId":"shell", "name":"Shell", "kind":"shell"},
            "spec":{"id":"starting", "command":"cat", "cwd":dir, "env":{},
                "ready_when":"", "service":false, "notice":null, "dirs":[]},
            "snapshot":null, "history":[], "launchCommand":"cat",
            "interrupted":false, "requestIds":[]
        }))
        .unwrap();
        service
            .records
            .lock()
            .unwrap()
            .insert(record.id.clone(), record.clone());
        service.persist().unwrap();
        assert!(Service::load(&dir).unwrap().list()[0].interrupted);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn maintenance_lease_blocks_launches_until_frontend_apply_finishes() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({ "projectId":"p", "projectName":"P", "projectRoot":dir.display().to_string(), "componentId":"web", "terminalId":"shell", "name":"Shell", "kind":"shell" })).unwrap();
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: String::new(),
            command: "cat".into(),
            cwd: dir.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let token: String = serde_json::from_value(
            service
                .handle(
                    "desktop",
                    Request::MaintenanceGuard {
                        project_id: "p".into(),
                        component_ids: vec!["web".into()],
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert!(
            service
                .start("blocked".into(), metadata.clone(), spec.clone())
                .is_err()
        );
        service
            .handle(
                "desktop",
                Request::MaintenanceRelease {
                    project_id: "other".into(),
                    token: token.clone(),
                },
            )
            .unwrap();
        assert!(
            service
                .start("still-blocked".into(), metadata.clone(), spec.clone())
                .is_err()
        );
        service
            .handle(
                "desktop",
                Request::MaintenanceRelease {
                    project_id: "p".into(),
                    token,
                },
            )
            .unwrap();
        let id = service.start("allowed".into(), metadata, spec).unwrap();
        assert!(
            service
                .handle(
                    "desktop",
                    Request::MaintenanceGuard {
                        project_id: "p".into(),
                        component_ids: vec!["web".into()]
                    }
                )
                .is_err()
        );
        service.pty.stop(&id);
        let original_directory = service.records.lock().unwrap()[&id].spec.cwd.clone();
        let token: String = serde_json::from_value(
            service
                .handle(
                    "desktop",
                    Request::MaintenanceGuard {
                        project_id: "p".into(),
                        component_ids: vec!["web".into()],
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            service.records.lock().unwrap()[&id].spec.cwd,
            original_directory
        );
        service
            .handle(
                "desktop",
                Request::MaintenanceRelease {
                    project_id: "p".into(),
                    token,
                },
            )
            .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn agent_tokens_resolve_only_to_their_running_session() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata = Metadata {
            project_id: "p".into(),
            project_name: "P".into(),
            project_root: dir.display().to_string(),
            component_id: crate::model::PLAN_SCOPE.into(),
            terminal_id: "planner".into(),
            task: Some("t1".into()),
            task_title: None,
            name: "Planner".into(),
            kind: TerminalKind::Agent,
            adapter: None,
            conversation_id: None,
            conversation_pinned: false,
            extension_id: None,
            command_id: None,
            key: None,
            branch: None,
            command: String::new(),
        };
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: "ignored".into(),
            command: "read line".into(),
            cwd: dir.clone(),
            env: BTreeMap::from([(
                crate::agent_bridge::TOKEN_ENV.to_string(),
                "secret".to_string(),
            )]),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: Vec::new(),
        };
        let id = service.start("request".into(), metadata, spec).unwrap();
        let lookup = |token: &str| -> Option<AgentSession> {
            serde_json::from_value(
                service
                    .handle(
                        "1",
                        Request::AgentSession {
                            token: token.into(),
                        },
                    )
                    .unwrap(),
            )
            .unwrap()
        };
        let found = lookup("secret").unwrap();
        assert_eq!(found.id, id);
        assert_eq!(found.metadata.task.as_deref(), Some("t1"));
        assert!(lookup("other").is_none());
        assert!(lookup("").is_none());
        // Records outlive their process; the token doesn't.
        service.pty.kill(&id);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while service.pty.is_running(&id) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(lookup("secret").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn merge_briefings_are_retained_for_recovery_and_removed_when_unclaimed() {
        owned_job_briefings_are_retained(crate::model::MERGE_SCOPE);
    }

    #[cfg(unix)]
    #[test]
    fn review_briefings_are_retained_for_recovery_and_removed_when_unclaimed() {
        owned_job_briefings_are_retained(crate::model::REVIEW_SCOPE);
    }

    #[cfg(unix)]
    fn owned_job_briefings_are_retained(scope: &str) {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId":"p", "projectName":"P", "projectRoot":dir,
            "componentId":scope, "terminalId":"merge", "name":"Merge",
            "kind":"agent"
        }))
        .unwrap();
        let project = crate::model::Project {
            schema_version: crate::model::SCHEMA_VERSION,
            root: dir.to_string_lossy().into_owned(),
            name: "P".into(),
            components: vec![],
            links: vec![],
            groups: vec![],
        };
        let terminal: crate::model::TerminalSpec = serde_json::from_value(serde_json::json!({
            "id":"merge", "name":"Merge", "kind":"agent", "command":"sleep 30"
        }))
        .unwrap();
        let make_spec = || {
            if scope == crate::model::MERGE_SCOPE {
                crate::context::merge_agent_spec(
                    &project,
                    &terminal,
                    "Merge briefing",
                    vec![],
                    &crate::policy::AllowAll,
                )
                .unwrap()
            } else {
                crate::context::job_agent_spec(
                    &project,
                    &terminal,
                    "Review briefing",
                    vec![],
                    scope,
                    crate::context::REVIEW_PROMPT,
                    BTreeMap::new(),
                    &crate::policy::AllowAll,
                )
                .unwrap()
            }
        };
        let file = |spec: &SessionSpec| PathBuf::from(&spec.env[crate::context::CONTEXT_ENV]);
        let first = make_spec();
        let pending_file = file(&first);
        let id = service
            .start("first".into(), metadata.clone(), first)
            .unwrap();
        assert!(!pending_file.exists());
        let first_file = file(&service.list()[0].spec);
        assert!(first_file.exists());
        let retry = make_spec();
        let retry_file = file(&retry);
        assert_eq!(
            service
                .start("first".into(), metadata.clone(), retry)
                .unwrap(),
            id
        );
        assert!(!retry_file.exists());
        let rejected = make_spec();
        let rejected_file = file(&rejected);
        assert!(
            service
                .start("second".into(), metadata.clone(), rejected)
                .is_err()
        );
        assert!(!rejected_file.exists());
        assert!(first_file.exists());
        service.pty.stop(&id);
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.pty.is_running(&id) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        // Stop retains the briefing for resume; a new launch supersedes it.
        assert!(first_file.exists());
        let next = make_spec();
        let pending_file = file(&next);
        service.start("next".into(), metadata, next).unwrap();
        assert!(!pending_file.exists());
        let next_file = file(&service.list()[0].spec);
        assert!(!first_file.exists());
        assert!(next_file.exists());
        service.pty.stop(&id);
        while service.pty.is_running(&id) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        service.persist().unwrap();
        let recovered = Service::load(&dir).unwrap();
        let record = recovered.list().pop().unwrap();
        assert_eq!(
            record.spec.exclusive_cwd,
            scope == crate::model::MERGE_SCOPE
        );
        assert_eq!(record.spec.dirs, service.list()[0].spec.dirs);
        assert_eq!(record.spec.command, service.list()[0].spec.command);
        assert_eq!(
            record.spec.resume_command,
            service.list()[0].spec.resume_command
        );
        assert_eq!(
            crate::context::owned_briefing(&record.spec),
            Some(next_file.clone())
        );
        assert!(recovered.summaries()[0].spec.resume_command.is_none());
        let serialized = serde_json::to_vec(&record).unwrap();
        let roundtrip: Record = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(roundtrip.spec.dirs, record.spec.dirs);
        assert_eq!(roundtrip.spec.merge_source, record.spec.merge_source);
        recovered.handle("1", Request::Forget { id }).unwrap();
        assert!(!next_file.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_exclusive_flag_never_removes_git_metadata_grants() {
        let dir = std::env::temp_dir().join("repo/.git");
        let command = format!(
            "claude --add-dir {}",
            crate::context::quote_argument(dir.to_str().unwrap())
        );
        let record: Record = serde_json::from_value(serde_json::json!({
            "id":"merge", "metadata": {
                "projectId":"p", "projectName":"P", "projectRoot":"/repo",
                "componentId":crate::model::MERGE_SCOPE, "terminalId":"merge",
                "name":"Merge", "kind":"agent"
            },
            "spec": {"id":"merge", "command":command, "cwd":"/repo", "env":{},
                "ready_when":"", "service":false, "notice":null, "dirs":[dir]},
            "snapshot":null, "history":[], "interrupted":true, "requestIds":[],
            "launchCommand":command
        }))
        .unwrap();
        assert_eq!(record.spec.dirs, vec![dir]);
        assert_eq!(record.spec.command, command);
        assert_eq!(record.launch_command, command);
    }

    #[cfg(unix)]
    #[test]
    fn lost_start_replies_remove_pending_files_and_keep_accepted_briefings() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let project: crate::model::Project = serde_json::from_value(serde_json::json!({
            "schemaVersion":4, "root":dir, "name":"P", "components":[], "links":[], "groups":[]
        }))
        .unwrap();
        let terminal: crate::model::TerminalSpec = serde_json::from_value(serde_json::json!({
            "id":"merge", "name":"Merge", "kind":"agent", "command":"sleep 30"
        }))
        .unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId":"p", "projectName":"P", "projectRoot":dir,
            "componentId":crate::model::MERGE_SCOPE, "terminalId":"merge", "name":"Merge", "kind":"agent"
        })).unwrap();
        for accepted in [false, true] {
            let spec = crate::context::merge_agent_spec(
                &project,
                &terminal,
                "private briefing",
                vec![],
                &crate::policy::AllowAll,
            )
            .unwrap();
            let pending = crate::context::owned_briefing(&spec).unwrap();
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let service_copy = service.clone();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let request: Request = read_frame(&mut socket).unwrap();
                if accepted {
                    service_copy.handle("test", request).unwrap();
                }
                // The request was written, but the peer closes without a reply.
            });
            let mut client = Client {
                stream,
                instance: "test".into(),
                broken: false,
            };
            assert!(
                client
                    .call::<String>(Request::Start {
                        request_id: "lost-reply".into(),
                        metadata: Box::new(metadata.clone()),
                        spec,
                    })
                    .is_err()
            );
            server.join().unwrap();
            assert!(client.is_broken());
            assert!(!pending.exists());
            if accepted {
                let record = service.list().pop().unwrap();
                let retained = crate::context::owned_briefing(&record.spec).unwrap();
                assert_ne!(retained, pending);
                assert_eq!(
                    std::fs::read_to_string(&retained).unwrap(),
                    "private briefing"
                );
                service.pty.stop(&record.id);
                let deadline = Instant::now() + Duration::from_secs(5);
                while service.pty.is_running(&record.id) {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(10));
                }
                service
                    .handle("test", Request::Forget { id: record.id })
                    .unwrap();
                assert!(!retained.exists());
            }
        }
        // A caller that cannot even connect uses the same core cleanup boundary.
        let spec = crate::context::merge_agent_spec(
            &project,
            &terminal,
            "retry",
            vec![],
            &crate::policy::AllowAll,
        )
        .unwrap();
        let pending = crate::context::owned_briefing(&spec).unwrap();
        let result: Result<()> = with_pending_briefing(
            Request::Start {
                request_id: "disconnected".into(),
                metadata: Box::new(metadata),
                spec,
            },
            |_| bail!("Disconnected"),
        );
        assert!(result.is_err());
        assert!(!pending.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_sessions_serialize_directories_across_projects_and_allow_retries() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let worktree = dir.join("destination");
        std::fs::create_dir(&worktree).unwrap();
        let other = dir.join("other");
        std::fs::create_dir(&other).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId":"p", "projectName":"P", "projectRoot":dir,
            "componentId":"folder", "terminalId":"exclusive", "name":"Exclusive",
            "kind":"agent"
        }))
        .unwrap();
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: true,
            merge_source: None,
            id: "ignored".into(),
            command: "sleep 30".into(),
            cwd: worktree.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let id = service
            .start("request".into(), metadata.clone(), spec.clone())
            .unwrap();
        assert_eq!(
            service
                .start("request".into(), metadata.clone(), spec.clone())
                .unwrap(),
            id
        );
        let mut second = metadata.clone();
        second.project_id = "another-project".into();
        second.terminal_id = "another-agent".into();
        assert!(
            service
                .start("competing".into(), second.clone(), spec.clone())
                .unwrap_err()
                .to_string()
                .contains("exclusive session requires an unused worktree")
        );
        // Regular task agents and development terminals cannot enter any part of the reserved
        // worktree, including a component folder or a symlink spelling of that folder.
        let nested = worktree.join("component");
        std::fs::create_dir(&nested).unwrap();
        let alias = dir.join("alias");
        std::os::unix::fs::symlink(&nested, &alias).unwrap();
        for cwd in [&worktree, &nested, &alias] {
            let mut ordinary = spec.clone();
            ordinary.exclusive_cwd = false;
            ordinary.cwd = cwd.clone();
            for kind in [TerminalKind::Agent, TerminalKind::Task, TerminalKind::Shell] {
                second.kind = kind;
                assert!(
                    service
                        .start("ordinary".into(), second.clone(), ordinary.clone())
                        .is_err()
                );
            }
        }
        std::fs::remove_file(alias).unwrap();
        let mut other_spec = spec.clone();
        other_spec.cwd = other;
        let other_id = service
            .start("other-destination".into(), second.clone(), other_spec)
            .unwrap();
        service.pty.stop(&id);
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.pty.is_running(&id) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        second.terminal_id = "replacement".into();
        let mut ordinary = spec.clone();
        ordinary.exclusive_cwd = false;
        ordinary.cwd = nested;
        let replacement = service
            .start("after-stop".into(), second, ordinary)
            .unwrap();
        // An idle-but-running task agent also prevents an exclusive launch.
        assert!(
            service
                .start("blocked-by-task".into(), metadata, spec)
                .is_err()
        );
        service.pty.stop(&replacement);
        service.pty.stop(&other_id);
        std::fs::remove_dir_all(dir).unwrap();
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
            task: None,
            task_title: None,
            name: "Counter".into(),
            kind: TerminalKind::Task,
            adapter: None,
            conversation_id: None,
            conversation_pinned: false,
            extension_id: None,
            command_id: None,
            key: None,
            branch: None,
            command: String::new(),
        };
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: "ignored".into(),
            command: "i=0; while :; do printf 'number:%s\\n' \"$i\"; i=$((i+1)); sleep 0.05; done"
                .into(),
            cwd: dir.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: Vec::new(),
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
                "1",
                Request::Attach {
                    id: id.clone(),
                    viewer: "a".into(),
                    claim: true,
                },
            )
            .unwrap();
        service
            .handle(
                "2",
                Request::Attach {
                    id: id.clone(),
                    viewer: "b".into(),
                    claim: true,
                },
            )
            .unwrap();
        assert!(!service.owns("1", id, "a"));
        assert!(service.owns("2", id, "b"));
        service
            .handle(
                "2",
                Request::Detach {
                    id: id.clone(),
                    viewer: "b".into(),
                },
            )
            .unwrap();
        assert!(service.owns("1", id, "a"));
        assert!(
            service
                .handle(
                    "1",
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
                .handle("1", Request::Poll { after: baseline })
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
                    "1",
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
        service
            .handle("1", Request::Stop { id: id.clone() })
            .unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while service.snapshot(id).unwrap().running && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!service.snapshot(id).unwrap().running);
        service
            .handle("1", Request::Forget { id: id.clone() })
            .unwrap();
        assert!(service.list().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn event_buffer_is_bounded_and_detects_gaps() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        for seq in 0..400 {
            service.emit(TerminalEvent::Output {
                session_id: "unknown".into(),
                generation: 1,
                seq,
                data: vec![b'x'; 8192],
            });
        }
        assert!(service.events.lock().unwrap().bytes <= EVENT_CAP);
        let batch: Batch =
            serde_json::from_value(service.handle("1", Request::Poll { after: 0 }).unwrap())
                .unwrap();
        assert!(batch.gap);
        assert_eq!(batch.instance_id, service.instance);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn stopped_then_repaired_launch_keeps_history_folder_and_legacy_unknowns() {
        let dir =
            std::env::temp_dir().join(format!("patchbay-history-cwd-{}", uuid::Uuid::new_v4()));
        private_dir(&dir).unwrap();
        let old = dir.join("old-component");
        let repaired = dir.join("repaired-component");
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&repaired).unwrap();
        let service = Service::load(&dir).unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId": "p", "projectName": "P", "projectRoot": dir,
            "componentId": "component", "terminalId": "shell", "name": "Shell",
            "kind": "shell", "adapter": null, "conversationId": null
        }))
        .unwrap();
        let spec = SessionSpec {
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            id: "ignored".into(),
            command: "exec cat".into(),
            cwd: old.clone(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let id = service
            .start("old-run".into(), metadata.clone(), spec.clone())
            .unwrap();
        let first = service.snapshot(&id).unwrap();
        assert_eq!(first.launch_directory, Some(old.clone()));
        service
            .handle("1", Request::Stop { id: id.clone() })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while service.snapshot(&id).unwrap().running {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut next = spec;
        next.cwd.clone_from(&repaired);
        service
            .start("repaired-run".into(), metadata, next)
            .unwrap();
        let record = service.summaries().pop().unwrap();
        assert_eq!(record.spec.cwd, repaired);
        assert_eq!(
            record.snapshot.as_ref().unwrap().launch_directory.as_ref(),
            Some(&repaired)
        );
        assert_eq!(record.history[0].generation, first.generation);
        assert_eq!(record.history[0].launch_directory.as_ref(), Some(&old));
        let history: Option<Snapshot> = serde_json::from_value(
            service
                .handle(
                    "1",
                    Request::History {
                        id: id.clone(),
                        incarnation: 0,
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(history.unwrap().launch_directory, Some(old));
        service
            .handle("1", Request::Stop { id: id.clone() })
            .unwrap();
        service.persist().unwrap();
        let path = dir.join("sessions.json");
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        legacy[&id]["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("launchDirectory");
        legacy[&id]["history"][0]
            .as_object_mut()
            .unwrap()
            .remove("launchDirectory");
        atomic_write(&path, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        let recovered = Service::load(&dir).unwrap();
        let record = recovered.summaries().pop().unwrap();
        assert_eq!(record.snapshot.unwrap().launch_directory, Some(repaired));
        assert_eq!(record.history[0].launch_directory, None);
        service.pty.reset();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restart_context_tracks_settings_and_briefing_but_not_bridge_credentials() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("briefing.md");
        std::fs::write(&file, "Original highlights, peers, and plan").unwrap();
        let metadata: Metadata = serde_json::from_value(serde_json::json!({
            "projectId": "p", "projectName": "P", "projectRoot": dir,
            "componentId": "web", "terminalId": "agent", "name": "Agent",
            "kind": "agent", "adapter": "claude", "command": "claude --model first"
        }))
        .unwrap();
        let spec = SessionSpec {
            id: "s".into(),
            command: "claude --model first".into(),
            resume_command: None,
            owns_briefing: false,
            exclusive_cwd: false,
            merge_source: None,
            cwd: dir.clone(),
            env: BTreeMap::from([(
                crate::context::CONTEXT_ENV.into(),
                file.display().to_string(),
            )]),
            ready_when: String::new(),
            service: false,
            notice: None,
            dirs: vec![],
        };
        let before = restart_context(&metadata, &spec).unwrap();
        assert!(before.is_some());
        let mut changed = metadata.clone();
        changed.command = "claude --model edited".into();
        assert_ne!(before, restart_context(&changed, &spec).unwrap());
        changed = metadata.clone();
        changed.adapter = Some(Adapter::Codex);
        assert_ne!(before, restart_context(&changed, &spec).unwrap());
        changed.kind = TerminalKind::Task;
        assert_eq!(restart_context(&changed, &spec).unwrap(), None);
        let mut changed_spec = spec.clone();
        changed_spec.dirs.push(dir.join("peer"));
        assert_ne!(before, restart_context(&metadata, &changed_spec).unwrap());
        changed_spec = spec.clone();
        changed_spec
            .env
            .insert(crate::agent_bridge::TOKEN_ENV.into(), "new-token".into());
        assert_eq!(before, restart_context(&metadata, &changed_spec).unwrap());
        std::fs::write(&file, "Changed highlights, peers, and plan").unwrap();
        assert_ne!(before, restart_context(&metadata, &spec).unwrap());

        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&dir)
                .status()
                .unwrap()
                .success()
        );
        crate::plans::write(&dir, None, "Implement the change").unwrap();
        let section = crate::plans::section(&dir, None).unwrap();
        let briefing = format!(
            "## {}\n\n{}\n\n## Peers\n\nKeep these",
            section.title, section.body
        );
        std::fs::write(&file, &briefing).unwrap();
        let before = restart_context(&metadata, &spec).unwrap();
        std::fs::write(
            &file,
            briefing.replace("saved just now", "saved 2 minutes ago"),
        )
        .unwrap();
        assert_eq!(before, restart_context(&metadata, &spec).unwrap());
        let plan = crate::plans::plan_file(&dir, None).unwrap();
        let handle = std::fs::File::options().write(true).open(&plan).unwrap();
        let modified = handle.metadata().unwrap().modified().unwrap();
        handle
            .set_times(std::fs::FileTimes::new().set_modified(modified + Duration::from_secs(60)))
            .unwrap();
        assert_ne!(before, restart_context(&metadata, &spec).unwrap());
        handle
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_eq!(before, restart_context(&metadata, &spec).unwrap());
        crate::plans::write(&dir, None, "A different plan").unwrap();
        assert_ne!(before, restart_context(&metadata, &spec).unwrap());
        crate::plans::remove(&dir, None).unwrap();
        assert_ne!(before, restart_context(&metadata, &spec).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    fn restart_fixture(dir: &Path, command: &str) -> (Metadata, SessionSpec) {
        let metadata = serde_json::from_value(serde_json::json!({
            "projectId": "p", "projectName": "P", "projectRoot": dir,
            "componentId": "web", "terminalId": "agent", "name": "Agent",
            "kind": "agent", "adapter": "claude", "command": command,
            "conversationId": "12345678-aaaa-1234-bbbb-123456789abc"
        }))
        .unwrap();
        let spec = serde_json::from_value(serde_json::json!({
            "id": "ignored", "command": command, "cwd": dir,
            "env": {}, "ready_when": "", "service": false, "notice": null
        }))
        .unwrap();
        (metadata, spec)
    }

    #[cfg(unix)]
    fn wait_for_exit(service: &Service, id: &str) -> Snapshot {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = service.snapshot(id).unwrap();
            if !snapshot.running {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "terminal did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn agent_start_tolerates_missing_and_unreadable_fingerprint_briefings() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let (metadata, mut spec) = restart_fixture(&dir, "printf launched");
        for (index, file) in [dir.join("missing.md"), dir.clone()]
            .into_iter()
            .enumerate()
        {
            spec.env.insert(
                crate::context::CONTEXT_ENV.into(),
                file.display().to_string(),
            );
            let id = service
                .start(format!("launch-{index}"), metadata.clone(), spec.clone())
                .unwrap();
            let snapshot = wait_for_exit(&service, &id);
            assert!(String::from_utf8_lossy(&snapshot.data).contains("launched"));
            assert!(service.list()[0].restart_context.is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn restart_retains_known_conversations_and_skips_refresh_for_retries_and_mismatches() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        let (metadata, spec) = restart_fixture(&dir, "printf quiet");
        let id = service
            .start("launch".into(), metadata.clone(), spec.clone())
            .unwrap();
        wait_for_exit(&service, &id);
        service.dirty.store(false, Ordering::Release);
        service.refresh_restart_conversation(&id);
        assert_eq!(
            service.list()[0].metadata.conversation_id,
            metadata.conversation_id
        );
        assert!(!service.dirty.load(Ordering::Acquire));
        let context = service.list()[0].restart_context.clone();
        assert!(context.is_some());
        assert!(service.summaries()[0].restart_context.is_none());
        service.persist().unwrap();
        assert_eq!(
            Service::load(&dir).unwrap().list()[0].restart_context,
            context
        );

        let mut hinted = spec;
        hinted.command = "printf 'claude --resume 87654321-bbbb-4321-aaaa-123456789abc'".into();
        service
            .start("hinted".into(), metadata.clone(), hinted.clone())
            .unwrap();
        let snapshot = wait_for_exit(&service, &id);
        assert!(restart_conversation(Adapter::Claude, &snapshot).is_some());
        service.dirty.store(false, Ordering::Release);
        let mut missing = hinted;
        missing.cwd = dir.join("missing");
        missing.env.insert(
            crate::context::CONTEXT_ENV.into(),
            dir.join("gone.md").display().to_string(),
        );
        assert_eq!(
            service
                .restart("hinted".into(), metadata.clone(), missing.clone())
                .unwrap(),
            id
        );
        assert!(!service.dirty.load(Ordering::Acquire));
        missing.env.remove(crate::context::CONTEXT_ENV);
        assert!(
            service
                .restart("mismatch".into(), metadata.clone(), missing)
                .is_err()
        );
        assert!(!service.dirty.load(Ordering::Acquire));
        assert_eq!(
            service.list()[0].metadata.conversation_id,
            metadata.conversation_id
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn restart_resumes_with_current_launch_settings() {
        use std::os::unix::fs::PermissionsExt;
        // Provider history is selected through process-wide environment variables.
        // Use a child test process so this fixture cannot affect concurrent tests.
        let marker = "PATCHBAY_RESTART_TEST_DIR";
        let Ok(dir) = std::env::var(marker) else {
            let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            private_dir(&dir).unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "session::tests::restart_resumes_with_current_launch_settings",
                    "--nocapture",
                ])
                .env(marker, &dir)
                .env("CLAUDE_CONFIG_DIR", dir.join("claude-config"))
                .output()
                .unwrap();
            std::fs::remove_dir_all(dir).unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        };
        let dir = PathBuf::from(dir);
        let history = dir.join("claude-config/projects");
        std::fs::create_dir_all(&history).unwrap();
        let conversation = "12345678-aaaa-1234-bbbb-123456789abc";
        std::fs::write(history.join(format!("{conversation}.jsonl")), "{}\n").unwrap();
        let executable = dir.join("claude");
        std::fs::write(&executable, "#!/bin/sh\nprintf 'args:%s token:%s cli:%s\\n' \"$*\" \"$PATCHBAY_AGENT_TOKEN\" \"$PATCHBAY_CLI\"\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command = crate::context::quote_argument(&executable.display().to_string());
        let (mut metadata, mut spec) = restart_fixture(&dir, &command);
        metadata.task = Some("t1".into());
        metadata.task_title = Some("Old task".into());
        let file = dir.join("briefing.md");
        std::fs::write(&file, "Same briefing").unwrap();
        spec.env.insert(
            crate::context::CONTEXT_ENV.into(),
            file.display().to_string(),
        );
        spec.env
            .insert(crate::agent_bridge::TOKEN_ENV.into(), "old-token".into());
        let service = Service::load(&dir).unwrap();
        let id = service
            .start("first".into(), metadata.clone(), spec.clone())
            .unwrap();
        wait_for_exit(&service, &id);
        let context = service.list()[0].restart_context.clone();
        let next_file = dir.join("new-briefing.md");
        std::fs::write(&next_file, "Same briefing").unwrap();
        spec.env.insert(
            crate::context::CONTEXT_ENV.into(),
            next_file.display().to_string(),
        );
        spec.env
            .insert(crate::agent_bridge::TOKEN_ENV.into(), "new-token".into());
        spec.env.insert("PATCHBAY_CLI".into(), "new-cli".into());
        spec.notice = Some("Current launch notice".into());
        metadata.project_name = "Renamed project".into();
        metadata.task_title = Some("Renamed task".into());
        metadata.name = "Renamed agent".into();
        metadata.conversation_id = None;
        assert_eq!(
            service.restart("restart".into(), metadata, spec).unwrap(),
            id
        );
        let snapshot = wait_for_exit(&service, &id);
        let output = String::from_utf8_lossy(&snapshot.data);
        assert!(
            output.contains(&format!("args:--resume {conversation}")),
            "{output}"
        );
        assert!(output.contains("token:new-token cli:new-cli"), "{output}");
        let record = service.list().pop().unwrap();
        assert_eq!(record.metadata.project_name, "Renamed project");
        assert_eq!(record.metadata.task_title.as_deref(), Some("Renamed task"));
        assert_eq!(record.metadata.name, "Renamed agent");
        assert_eq!(
            record.metadata.conversation_id.as_deref(),
            Some(conversation)
        );
        assert_eq!(
            record.spec.env[crate::context::CONTEXT_ENV],
            next_file.display().to_string()
        );
        assert_eq!(record.spec.notice.as_deref(), Some("Current launch notice"));
        assert_eq!(record.launch_command, command);
        assert_eq!(record.restart_context, context);
        service.dirty.store(false, Ordering::Release);
        assert_eq!(
            service
                .restart("restart".into(), record.metadata, record.spec)
                .unwrap(),
            id
        );
        assert_eq!(
            service.snapshot(&id).unwrap().generation,
            snapshot.generation
        );
        assert!(!service.dirty.load(Ordering::Acquire));
    }

    #[test]
    fn restart_uses_the_final_conversation_after_clear_without_waiting_for_capture() {
        let mut snapshot = Snapshot {
            launch_directory: None,
            truncated: false,
            data: vec![],
            end: 0,
            generation: 1,
            running: false,
            exit_code: Some(0),
            started_ms: 0,
            exited_ms: Some(1),
            status: crate::status::SessionStatus::default(),
            notice: None,
        };
        assert_eq!(restart_conversation(Adapter::Claude, &snapshot), None);
        snapshot.status.agent = Some(crate::status::AgentReport {
            state: crate::status::AgentState::Ended,
            since_ms: 0,
            message: None,
            prompt: None,
            provider: Some(Adapter::Claude),
            conversation_id: Some("after-clear".into()),
            turn_id: None,
            authoritative: true,
        });
        assert_eq!(
            restart_conversation(Adapter::Claude, &snapshot).as_deref(),
            Some("after-clear")
        );
        snapshot.status.agent.as_mut().unwrap().authoritative = false;
        snapshot.data = b"claude --resume 12345678-aaaa-1234-bbbb-123456789abc".to_vec();
        assert_eq!(
            restart_conversation(Adapter::Claude, &snapshot).as_deref(),
            Some("12345678-aaaa-1234-bbbb-123456789abc")
        );
    }

    #[test]
    fn history_is_bounded() {
        let snapshot = |generation| Snapshot {
            launch_directory: None,
            truncated: false,
            data: vec![b'x'; 16],
            end: 16,
            generation,
            running: false,
            exit_code: Some(0),
            started_ms: 0,
            exited_ms: None,
            status: crate::status::SessionStatus::default(),
            notice: None,
        };
        let mut history: Vec<_> = (0..10).map(snapshot).collect();
        trim_history(&mut history);
        assert_eq!(
            history.iter().map(|s| s.generation).collect::<Vec<_>>(),
            [7, 8, 9]
        );
    }
    #[test]
    fn connections_of_one_client_share_authority_until_the_last_closes() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let service = Service::load(&dir).unwrap();
        service.connected("client-a");
        service.connected("client-a");
        service.claim("client-a", "s".into(), "main".into(), true);
        assert!(service.owns("client-a", "s", "main"));
        service.disconnected("client-a");
        assert!(service.owns("client-a", "s", "main"));
        service.disconnected("client-a");
        assert!(!service.owns("client-a", "s", "main"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn resume_rechecks_recorded_folders() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let project = dir.join("project");
        let external = dir.join("billing");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let record = Record {
            id: "s".into(),
            metadata: Metadata {
                project_id: "p".into(),
                project_name: "P".into(),
                project_root: project.display().to_string(),
                component_id: "api".into(),
                terminal_id: "agent".into(),
                task: None,
                task_title: None,
                name: "Agent".into(),
                kind: TerminalKind::Agent,
                adapter: None,
                conversation_id: None,
                conversation_pinned: false,
                extension_id: None,
                command_id: None,
                key: None,
                branch: None,
                command: String::new(),
            },
            spec: SessionSpec {
                resume_command: None,
                owns_briefing: false,
                exclusive_cwd: false,
                merge_source: None,
                id: "s".into(),
                command: String::new(),
                cwd: project.clone(),
                env: BTreeMap::new(),
                ready_when: String::new(),
                service: false,
                notice: None,
                dirs: vec![external.clone()],
            },
            snapshot: None,
            history: vec![],
            launch_command: String::new(),
            restart_context: None,
            interrupted: false,
            request_ids: vec![],
        };
        assert!(check_resume(&record, std::slice::from_ref(&project)).is_err());
        assert!(check_resume(&record, &[project, external]).is_ok());
        // A record saved before its process spawned comes back interrupted, not starting.
        let saved = BTreeMap::from([(record.id.clone(), record)]);
        std::fs::write(
            dir.join("sessions.json"),
            serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        assert!(Service::load(&dir).unwrap().list()[0].interrupted);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
