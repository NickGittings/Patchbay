use crate::events::{EventSink, TerminalEvent};
use crate::status::{STATUS_ENV, SessionStatus, Tracker, probe};
use anyhow::{Result, anyhow, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::{Duration, Instant, SystemTime};

const BACKLOG_CAPACITY: usize = 512 * 1024;

/// How long [`PtyManager::reset`] waits for hung-up processes before force-killing them.
const RESET_GRACE: Duration = Duration::from_secs(1);

const DEFAULT_SIZE: (u16, u16) = (120, 30);

/// How often running sessions' status files, activity and health are checked.
const MONITOR_TICK: Duration = Duration::from_millis(250);

/// What to launch in a terminal session.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub id: String,
    /// Empty for an interactive shell.
    pub command: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    /// Output text that means a service is ready; empty for none.
    pub ready_when: String,
    /// A task terminal: watch its output for a local URL or `ready_when`.
    pub service: bool,
}

struct Session {
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    process: Process,
}

/// Enough of a child process to stop it, kept until its waiter sees it exit.
struct Process {
    pid: Option<u32>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Process {
    /// Ask nicely: portable-pty sends SIGHUP on Unix and terminates on Windows.
    fn hang_up(&mut self) {
        let _ = self.killer.kill();
    }

    /// The PTY child leads its own session, so on Unix killing its process group
    /// also reaches dev servers and other descendants that ignore SIGHUP.
    fn force_kill(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            return;
        }
        let _ = self.killer.kill();
    }
}

#[derive(Default)]
struct Backlog {
    data: VecDeque<u8>,
    end: u64,
    generation: u64,
    running: bool,
    exit_code: Option<i32>,
    started_ms: u64,
    exited_ms: Option<u64>,
    tracker: Tracker,
}

/// Wall-clock Unix milliseconds, the clock file modification times use, so
/// runs can be compared with edits.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

impl Backlog {
    fn append(&mut self, data: &[u8]) -> u64 {
        let seq = self.end;
        self.end += data.len() as u64;
        let retained = &data[data.len().saturating_sub(BACKLOG_CAPACITY)..];
        let excess = (self.data.len() + retained.len()).saturating_sub(BACKLOG_CAPACITY);
        self.data.drain(..excess);
        self.data.extend(retained);
        seq
    }
}

/// Retained output and lifecycle state for one session incarnation.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Base64 on the wire: a JSON number array is ~4x larger.
    #[serde(serialize_with = "serialize_base64")]
    pub data: Vec<u8>,
    pub end: u64,
    pub generation: u64,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// When the process was started, in Unix milliseconds.
    pub started_ms: u64,
    /// When it exited, in Unix milliseconds.
    pub exited_ms: Option<u64>,
    pub status: SessionStatus,
}

fn serialize_base64<S: serde::Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
    use base64::Engine;
    s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(data))
}

/// Long-lived PTY sessions keyed by session id. Output and exit are reported
/// through an [`EventSink`]; nothing here blocks the caller.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
    /// Ids reserved by an in-flight [`PtyManager::spawn`], with their generation,
    /// so process creation happens without holding `sessions`.
    starting: Mutex<HashMap<String, u64>>,
    /// Processes from sessions dropped by [`PtyManager::reset`] that have not
    /// exited yet, by generation.
    orphans: Mutex<HashMap<u64, Process>>,
    backlogs: Mutex<HashMap<String, Arc<Mutex<Backlog>>>>,
    sizes: Mutex<HashMap<String, (u16, u16)>>,
    /// Running sessions whose status the monitor thread keeps up to date, by generation.
    watched: Mutex<HashMap<u64, Watched>>,
    monitor_started: std::sync::OnceLock<()>,
    status_dir: StatusDir,
    /// Last generation handed out. Global rather than per id so generations
    /// stay unique across [`PtyManager::reset`].
    generation: Mutex<u64>,
}

/// A running session as the monitor thread sees it.
struct Watched {
    id: String,
    backlog: Arc<Mutex<Backlog>>,
    sink: Arc<dyn EventSink>,
    status_file: Option<PathBuf>,
    /// Modification time and length of the status file when last read.
    seen: Option<(SystemTime, u64)>,
}

/// A private folder (owner-only on Unix) for one manager's status files. It is
/// created fresh, never reused, so on a shared temp dir another user can neither
/// plant it in advance nor read the prompts and messages hooks write there.
/// `None` if it couldn't be created; sessions then run without status reports.
struct StatusDir(Option<PathBuf>);

impl Default for StatusDir {
    fn default() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        for _ in 0..8 {
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.subsec_nanos());
            let dir = std::env::temp_dir().join(format!(
                "patchbay-status-{}-{n}-{nanos:x}",
                std::process::id()
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            match builder.create(&dir) {
                Ok(()) => return Self(Some(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => break,
            }
        }
        Self(None)
    }
}

impl Drop for StatusDir {
    fn drop(&mut self) {
        if let Some(dir) = &self.0 {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn remove_status_file(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// Run through the user's login shell so PATH matches their terminal, even when
/// the app is launched from the dock.
fn shell_command(command: &str) -> CommandBuilder {
    if cfg!(windows) {
        if command.is_empty() {
            CommandBuilder::new("powershell.exe")
        } else {
            let mut cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/C", command]);
            cmd
        }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = CommandBuilder::new(shell);
        if command.is_empty() {
            cmd.arg("-il");
        } else {
            cmd.args(["-ilc", command]);
        }
        cmd
    }
}

fn pty_size((cols, rows): (u16, u16)) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

impl PtyManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Start a session. Returns once the process is spawned.
    ///
    /// # Errors
    /// Fails if a session with the same id is running or the process cannot start.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn spawn(self: &Arc<Self>, spec: SessionSpec, sink: Arc<dyn EventSink>) -> Result<()> {
        let generation = {
            let sessions = self.sessions.lock().unwrap();
            let mut starting = self.starting.lock().unwrap();
            if sessions.contains_key(&spec.id) || starting.contains_key(&spec.id) {
                bail!("{} is already running", spec.id);
            }
            let generation = self.next_generation();
            starting.insert(spec.id.clone(), generation);
            generation
        };
        // Taken before the process starts, so edits it makes count as after the run began.
        let started_ms = now_ms();
        let started = self.start_process(&spec, generation);
        let mut sessions = self.sessions.lock().unwrap();
        // A reset while starting clears the reservation (and may let a newer spawn
        // take the id), so only claim the id if the reservation is still ours.
        let reserved = {
            let mut starting = self.starting.lock().unwrap();
            let ours = starting.get(&spec.id) == Some(&generation);
            if ours {
                starting.remove(&spec.id);
            }
            ours
        };
        let (master, mut child, mut reader, writer) = started?;
        let mut process = Process {
            pid: child.process_id(),
            killer: child.clone_killer(),
        };

        let backlog = Arc::new(Mutex::new(Backlog {
            generation,
            running: true,
            started_ms,
            tracker: Tracker::new(&spec.ready_when, spec.service),
            ..Backlog::default()
        }));
        if reserved {
            self.backlogs
                .lock()
                .unwrap()
                .insert(spec.id.clone(), backlog.clone());
            self.watched.lock().unwrap().insert(
                generation,
                Watched {
                    id: spec.id.clone(),
                    backlog: backlog.clone(),
                    sink: sink.clone(),
                    status_file: self.status_file(generation),
                    seen: None,
                },
            );
            sessions.insert(
                spec.id.clone(),
                Session {
                    generation,
                    master,
                    writer,
                    process,
                },
            );
        } else {
            // Its project was closed while it started, and the reset is no longer
            // waiting for it: kill it outright and let the waiter reap it. Its
            // events are at or below the reset's generation floor.
            process.force_kill();
            self.orphans.lock().unwrap().insert(generation, process);
            drop(master);
            drop(writer);
        }
        drop(sessions);
        self.start_monitor();
        sink.emit(TerminalEvent::Started {
            session_id: spec.id.clone(),
            generation,
            started_ms,
        });

        let (done_tx, done_rx) = mpsc::channel();
        {
            let sink = sink.clone();
            let id = spec.id.clone();
            let backlog = backlog.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            // Emit after unlocking; consumers de-duplicate by seq.
                            let seq = {
                                let mut backlog = backlog.lock().unwrap();
                                backlog.tracker.on_output(&buf[..n], now_ms());
                                backlog.append(&buf[..n])
                            };
                            sink.emit(TerminalEvent::Output {
                                session_id: id.clone(),
                                generation,
                                seq,
                                data: buf[..n].to_vec(),
                            });
                        }
                    }
                }
                let _ = done_tx.send(());
            });
        }

        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            let status = child.wait();
            manager.orphans.lock().unwrap().remove(&generation);
            manager.watched.lock().unwrap().remove(&generation);
            remove_status_file(manager.status_file(generation).as_deref());
            // Let the reader drain; on Windows it only sees EOF once the master closes.
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
            let mut sessions = manager.sessions.lock().unwrap();
            // After a reset the id may already belong to a newer session.
            if sessions
                .get(&spec.id)
                .is_some_and(|s| s.generation == generation)
            {
                sessions.remove(&spec.id);
            }
            drop(sessions);
            let exit_code = match status {
                Ok(s) if s.success() => 0,
                Ok(s) => i32::try_from(s.exit_code()).unwrap_or(i32::MAX).max(1),
                Err(_) => 1,
            };
            let exited_ms = now_ms();
            let status = {
                let mut backlog = backlog.lock().unwrap();
                backlog.running = false;
                backlog.exit_code = Some(exit_code);
                backlog.exited_ms = Some(exited_ms);
                backlog.tracker.changed(exited_ms)
            };
            // The monitor stopped watching it, so report e.g. a stop it missed.
            if let Some(status) = status {
                sink.emit(TerminalEvent::Status {
                    session_id: spec.id.clone(),
                    generation,
                    status,
                });
            }
            sink.emit(TerminalEvent::Exited {
                session_id: spec.id,
                generation,
                exit_code,
                exited_ms,
            });
        });
        Ok(())
    }

    /// Where a session incarnation may report its state. Named after the
    /// generation, so an earlier run of the same session can't write to it.
    fn status_file(&self, generation: u64) -> Option<PathBuf> {
        Some(self.status_dir.0.as_ref()?.join(generation.to_string()))
    }

    fn next_generation(&self) -> u64 {
        let mut last = self.generation.lock().unwrap();
        *last += 1;
        *last
    }

    /// One background thread per manager keeps watched sessions' status up to
    /// date; it ends once the manager is dropped.
    fn start_monitor(self: &Arc<Self>) {
        self.monitor_started.get_or_init(|| {
            let manager = Arc::downgrade(self);
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(MONITOR_TICK);
                    let Some(manager) = Weak::upgrade(&manager) else {
                        break;
                    };
                    manager.monitor_tick();
                }
            });
        });
    }

    fn monitor_tick(&self) {
        let now = now_ms();
        let watched: Vec<_> = self
            .watched
            .lock()
            .unwrap()
            .iter()
            .map(|(&generation, w)| {
                let file = w.status_file.clone();
                (
                    generation,
                    w.id.clone(),
                    w.backlog.clone(),
                    w.sink.clone(),
                    file,
                    w.seen,
                )
            })
            .collect();
        let mut events = Vec::new();
        for (generation, id, backlog, sink, file, seen) in watched {
            // Read a changed status file without holding any lock.
            let report = file.as_deref().and_then(|file| {
                let meta = std::fs::metadata(file).ok()?;
                let stamp = (meta.modified().ok()?, meta.len());
                if seen == Some(stamp) {
                    return None;
                }
                let text = std::fs::read_to_string(file).ok()?;
                if let Some(w) = self.watched.lock().unwrap().get_mut(&generation) {
                    w.seen = Some(stamp);
                }
                Some(text)
            });
            let (port, status) = {
                let mut backlog = backlog.lock().unwrap();
                if let Some(text) = report {
                    backlog.tracker.on_report(&text, now);
                }
                (backlog.tracker.due_probe(now), backlog.tracker.changed(now))
            };
            if let Some(port) = port {
                let backlog = backlog.clone();
                std::thread::spawn(move || {
                    let ok = probe(port);
                    backlog.lock().unwrap().tracker.on_probe(ok, now_ms());
                });
            }
            if let Some(status) = status {
                events.push((
                    sink,
                    TerminalEvent::Status {
                        session_id: id,
                        generation,
                        status,
                    },
                ));
            }
        }
        for (sink, event) in events {
            sink.emit(event);
        }
    }

    #[allow(clippy::type_complexity)]
    fn start_process(
        &self,
        spec: &SessionSpec,
        generation: u64,
    ) -> Result<(
        Box<dyn MasterPty + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
        Box<dyn Read + Send>,
        Box<dyn Write + Send>,
    )> {
        let size = self
            .sizes
            .lock()
            .unwrap()
            .get(&spec.id)
            .copied()
            .unwrap_or(DEFAULT_SIZE);
        let pair = native_pty_system().openpty(pty_size(size))?;

        let mut cmd = shell_command(&spec.command);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(status) = self.status_file(generation) {
            cmd.env(STATUS_ENV, status);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        Ok((pair.master, child, reader, writer))
    }

    /// Snapshot retained bytes, including output from completed sessions.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    #[must_use]
    pub fn snapshot(&self, id: &str) -> Option<Snapshot> {
        let backlogs = self.backlogs.lock().unwrap();
        let mut backlog = backlogs.get(id)?.lock().unwrap();
        let status = backlog.tracker.status(now_ms());
        Some(Snapshot {
            data: backlog.data.iter().copied().collect(),
            end: backlog.end,
            generation: backlog.generation,
            running: backlog.running,
            exit_code: backlog.exit_code,
            started_ms: backlog.started_ms,
            exited_ms: backlog.exited_ms,
            status,
        })
    }

    /// # Panics
    /// Panics if an internal lock is poisoned.
    #[must_use]
    pub fn is_running(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    /// # Errors
    /// Fails if the session is not running or the write fails.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        // Before writing, so the echo isn't taken for activity; never while
        // holding `sessions`, which every terminal's input waits on.
        let backlog = self.backlogs.lock().unwrap().get(id).cloned();
        if let Some(backlog) = backlog {
            backlog.lock().unwrap().tracker.on_input(data, now_ms());
        }
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("{id} is not running"))?;
        s.writer.write_all(data)?;
        s.writer.flush()?;
        Ok(())
    }

    /// Remember the size for future sessions and resize the live one, if any.
    ///
    /// # Errors
    /// Fails if the PTY cannot be resized.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.sizes
            .lock()
            .unwrap()
            .insert(id.to_string(), (cols, rows));
        if let Some(s) = self.sessions.lock().unwrap().get(id) {
            s.master.resize(pty_size((cols, rows)))?;
        }
        Ok(())
    }

    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn kill(&self, id: &str) {
        let generation = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get_mut(id) else {
                return;
            };
            s.process.hang_up();
            s.generation
        };
        let backlog = self.backlogs.lock().unwrap().get(id).cloned();
        if let Some(backlog) = backlog {
            let mut backlog = backlog.lock().unwrap();
            if backlog.generation == generation {
                backlog.tracker.on_stop();
            }
        }
    }

    /// Record that a window showed the session to the user. Returns the status
    /// event to broadcast so every window agrees, or `None` for an unknown id.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    #[must_use]
    pub fn mark_seen(&self, id: &str) -> Option<TerminalEvent> {
        let backlog = self.backlogs.lock().unwrap().get(id).cloned()?;
        let mut backlog = backlog.lock().unwrap();
        let now = now_ms();
        backlog.tracker.on_seen(now);
        let status = backlog.tracker.changed(now)?;
        Some(TerminalEvent::Status {
            session_id: id.to_string(),
            generation: backlog.generation,
            status,
        })
    }

    /// Kill every session and forget all retained output, e.g. when another
    /// project is opened or the app exits. Session ids are not project-scoped,
    /// so history must not carry over. Blocks for up to about twice
    /// [`RESET_GRACE`]: processes still alive after the grace period are
    /// force-killed with their process group, so they can't keep ports or files
    /// the next project needs. Returns the last generation issued: every event
    /// from a session started before the reset has a generation at or below it.
    ///
    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn reset(&self) -> u64 {
        let floor = {
            let mut sessions = self.sessions.lock().unwrap();
            self.starting.lock().unwrap().clear();
            let mut orphans = self.orphans.lock().unwrap();
            for (_, mut s) in sessions.drain() {
                s.process.hang_up();
                orphans.insert(s.generation, s.process);
            }
            for generation in self.watched.lock().unwrap().drain().map(|(g, _)| g) {
                remove_status_file(self.status_file(generation).as_deref());
            }
            self.backlogs.lock().unwrap().clear();
            *self.generation.lock().unwrap()
        };
        if !self.wait_for_orphans(RESET_GRACE) {
            for process in self.orphans.lock().unwrap().values_mut() {
                process.force_kill();
            }
            self.wait_for_orphans(RESET_GRACE);
        }
        floor
    }

    /// Whether every orphan exited within `timeout`.
    fn wait_for_orphans(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.orphans.lock().unwrap().is_empty() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Collect(Mutex<Vec<TerminalEvent>>);
    impl EventSink for Collect {
        fn emit(&self, e: TerminalEvent) {
            self.0.lock().unwrap().push(e);
        }
    }

    impl Collect {
        fn wait_for_exit(&self) -> i32 {
            for _ in 0..400 {
                if let Some(code) = self.exit_code() {
                    return code;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("Timed out waiting for terminal exit");
        }

        fn exit_code(&self) -> Option<i32> {
            self.0.lock().unwrap().iter().find_map(|e| match e {
                TerminalEvent::Exited { exit_code, .. } => Some(*exit_code),
                _ => None,
            })
        }

        fn output(&self) -> String {
            let bytes: Vec<u8> = self
                .0
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    TerminalEvent::Output { data, .. } => Some(data.clone()),
                    _ => None,
                })
                .flatten()
                .collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    #[test]
    fn runs_command_and_reports_exit() {
        let pty = Arc::new(PtyManager::new());
        let sink = Arc::new(Collect::default());
        pty.spawn(
            SessionSpec {
                id: "c/t".into(),
                command: "echo $PB_TEST; exit 3".into(),
                cwd: std::env::temp_dir(),
                env: BTreeMap::from([("PB_TEST".into(), "hello".into())]),
                ready_when: String::new(),
                service: false,
            },
            sink.clone(),
        )
        .unwrap();

        assert_eq!(sink.wait_for_exit(), 3);
        assert!(sink.output().contains("hello"), "{}", sink.output());
        assert!(!pty.is_running("c/t"));
        let snapshot = pty.snapshot("c/t").unwrap();
        assert_eq!(String::from_utf8_lossy(&snapshot.data), sink.output());
        assert_eq!(snapshot.end, snapshot.data.len() as u64);
        assert!(!snapshot.running);
        assert_eq!(snapshot.exit_code, Some(3));
        let exited = snapshot.exited_ms.unwrap();
        assert!(snapshot.started_ms > 0 && snapshot.started_ms <= exited);
        let events = sink.0.lock().unwrap();
        let mut end = 0;
        for event in events.iter() {
            if let TerminalEvent::Output { seq, data, .. } = event {
                assert_eq!(*seq, end);
                end += data.len() as u64;
            }
        }
        assert_eq!(snapshot.end, end);
    }

    #[test]
    fn reports_status_from_the_status_file_and_output() {
        use crate::status::AgentState;
        let pty = Arc::new(PtyManager::new());
        let sink = Arc::new(Collect::default());
        pty.spawn(
            SessionSpec {
                id: "c/agent".into(),
                command:
                    "printf 'needs-input\\n{\"message\":\"Allow?\"}' > \"$PATCHBAY_STATUS_FILE\"; \
                          echo 'Local: http://localhost:1/'; echo all set; read line"
                        .into(),
                cwd: std::env::temp_dir(),
                env: BTreeMap::new(),
                ready_when: "ALL SET".into(),
                service: true,
            },
            sink.clone(),
        )
        .unwrap();
        let mut last = None;
        for _ in 0..200 {
            last = sink.0.lock().unwrap().iter().rev().find_map(|e| match e {
                TerminalEvent::Status { status, .. } => Some(status.clone()),
                _ => None,
            });
            if last
                .as_ref()
                .is_some_and(|s| s.agent.is_some() && s.url.is_some())
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let status = last.expect("a status event");
        let agent = status.agent.unwrap();
        assert_eq!(agent.state, AgentState::NeedsInput);
        assert_eq!(agent.message.as_deref(), Some("Allow?"));
        assert_eq!(status.url.as_deref(), Some("http://localhost:1/"));
        assert!(status.ready);
        assert!(pty.snapshot("c/agent").unwrap().status.agent.is_some());
        let file = pty
            .status_file(pty.snapshot("c/agent").unwrap().generation)
            .unwrap();
        assert!(file.exists());
        pty.write("c/agent", b"\n").unwrap();
        assert_eq!(sink.wait_for_exit(), 0);
        assert!(!file.exists());
    }

    #[test]
    fn reset_forgets_history_and_keeps_generations_unique() {
        let pty = Arc::new(PtyManager::new());
        let spec = |command: &str| SessionSpec {
            id: "root/shell".into(),
            command: command.into(),
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            ready_when: String::new(),
            service: false,
        };
        let old = Arc::new(Collect::default());
        pty.spawn(spec("sleep 5"), old.clone()).unwrap();
        let floor = pty.reset();
        assert_eq!(floor, 1);
        assert!(pty.snapshot("root/shell").is_none());
        assert!(!pty.is_running("root/shell"));

        // The id is free immediately, and the old waiter must not evict the new session.
        let new = Arc::new(Collect::default());
        pty.spawn(spec("sleep 1"), new.clone()).unwrap();
        old.wait_for_exit();
        assert!(pty.is_running("root/shell"));
        assert_eq!(pty.snapshot("root/shell").unwrap().generation, 2);
        assert_eq!(new.wait_for_exit(), 0);
    }

    #[test]
    fn reset_force_kills_processes_that_ignore_hangup() {
        let pty = Arc::new(PtyManager::new());
        let sink = Arc::new(Collect::default());
        pty.spawn(
            SessionSpec {
                id: "stubborn".into(),
                command: "trap '' HUP; echo ready; sleep 30".into(),
                cwd: std::env::temp_dir(),
                env: BTreeMap::new(),
                ready_when: String::new(),
                service: false,
            },
            sink.clone(),
        )
        .unwrap();
        for _ in 0..400 {
            if sink.output().contains("ready") {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let started = Instant::now();
        pty.reset();
        assert!(pty.orphans.lock().unwrap().is_empty());
        assert!(started.elapsed() < RESET_GRACE * 2 + Duration::from_millis(500));
        assert_ne!(sink.wait_for_exit(), 0);
    }

    #[test]
    fn respawn_resets_backlog_and_increments_generation() {
        let pty = Arc::new(PtyManager::new());
        assert!(pty.snapshot("restart").is_none());
        for (generation, text) in [(1, "first-output"), (2, "second-output")] {
            let sink = Arc::new(Collect::default());
            pty.spawn(
                SessionSpec {
                    id: "restart".into(),
                    command: format!("echo {text}"),
                    cwd: std::env::temp_dir(),
                    env: BTreeMap::new(),
                    ready_when: String::new(),
                    service: false,
                },
                sink.clone(),
            )
            .unwrap();
            assert_eq!(sink.wait_for_exit(), 0);
            let snapshot = pty.snapshot("restart").unwrap();
            assert_eq!(snapshot.generation, generation);
            assert_eq!(snapshot.end, snapshot.data.len() as u64);
            let output = String::from_utf8_lossy(&snapshot.data);
            assert!(output.contains(text));
            if generation == 2 {
                assert!(!output.contains("first-output"));
            }
        }
    }

    #[test]
    fn concurrent_starts_allow_only_one_running_session() {
        let pty = Arc::new(PtyManager::new());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let sink = Arc::new(Collect::default());
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let pty = pty.clone();
                let barrier = barrier.clone();
                let sink = sink.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    pty.spawn(
                        SessionSpec {
                            id: "concurrent".into(),
                            command: "read line".into(),
                            cwd: std::env::temp_dir(),
                            env: BTreeMap::new(),
                            ready_when: String::new(),
                            service: false,
                        },
                        sink,
                    )
                    .is_ok()
                })
            })
            .collect();
        let successes = threads
            .into_iter()
            .map(|t| usize::from(t.join().unwrap()))
            .sum::<usize>();
        assert_eq!(successes, 1);
        assert!(pty.snapshot("concurrent").unwrap().running);
        pty.write("concurrent", b"done\n").unwrap();
        assert_eq!(sink.wait_for_exit(), 0);
        assert!(!pty.snapshot("concurrent").unwrap().running);
    }
}

#[cfg(test)]
mod backlog_tests {
    use super::*;

    #[test]
    fn retains_only_tail_with_total_byte_offset() {
        let mut backlog = Backlog::default();
        assert_eq!(backlog.append(&vec![1; BACKLOG_CAPACITY]), 0);
        assert_eq!(backlog.append(&[2, 3]), BACKLOG_CAPACITY as u64);
        assert_eq!(backlog.data.len(), BACKLOG_CAPACITY);
        assert_eq!(backlog.end, BACKLOG_CAPACITY as u64 + 2);
        assert_eq!(backlog.data.back(), Some(&3));
    }
}
