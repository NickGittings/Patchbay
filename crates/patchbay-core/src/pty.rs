use crate::events::{EventSink, TerminalEvent};
use anyhow::{Result, anyhow, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime};

const BACKLOG_CAPACITY: usize = 512 * 1024;

/// How long [`PtyManager::reset`] waits for hung-up processes before force-killing them.
const RESET_GRACE: Duration = Duration::from_secs(1);

const DEFAULT_SIZE: (u16, u16) = (120, 30);

const COMMAND_ENV: &str = "PATCHBAY_LAUNCH_COMMAND";

/// What to launch in a terminal session.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub id: String,
    /// Empty for an interactive shell.
    pub command: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    /// A dim line retained and emitted before the process's output.
    pub notice: Option<String>,
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
    /// Last generation handed out. Global rather than per id so generations
    /// stay unique across [`PtyManager::reset`].
    generation: Mutex<u64>,
}

/// Run through the user's login shell so PATH matches their terminal, even when
/// the app is launched from the dock.
fn shell_command(command: &str) -> CommandBuilder {
    if cfg!(windows) {
        windows_shell_command(command)
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

fn windows_shell_command(command: &str) -> CommandBuilder {
    if command.is_empty() {
        return CommandBuilder::new("powershell.exe");
    }
    use base64::Engine as _;
    // portable-pty MSVC-quotes every argument, but cmd.exe expects raw syntax
    // after /C. A constant encoded PowerShell bootstrap starts cmd with a raw
    // Arguments string. The command travels in the environment, so user quotes
    // are never parsed as PowerShell and cmd still expands the user's %VAR%.
    let bootstrap = format!(
        "$ErrorActionPreference = 'Stop'; \
         $p = New-Object System.Diagnostics.ProcessStartInfo; \
         $p.FileName = 'cmd.exe'; \
         $p.Arguments = '/V:OFF /S /C \"' + $env:{COMMAND_ENV} + '\"'; \
         $p.UseShellExecute = $false; \
         $child = [System.Diagnostics.Process]::Start($p); \
         $child.WaitForExit(); exit $child.ExitCode"
    );
    let bytes: Vec<_> = bootstrap
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-EncodedCommand", &encoded]);
    cmd.env(COMMAND_ENV, command);
    cmd
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
        let started = self.start_process(&spec);
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
            ..Backlog::default()
        }));
        if reserved {
            self.backlogs
                .lock()
                .unwrap()
                .insert(spec.id.clone(), backlog.clone());
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
        sink.emit(TerminalEvent::Started {
            session_id: spec.id.clone(),
            generation,
            started_ms,
        });

        if let Some(notice) = &spec.notice {
            let data = format!(
                "\x1b[2m[patchbay] {}\x1b[0m\r\n",
                notice.replace(['\r', '\n', '\x1b'], " ")
            )
            .into_bytes();
            let seq = backlog.lock().unwrap().append(&data);
            sink.emit(TerminalEvent::Output {
                session_id: spec.id.clone(),
                generation,
                seq,
                data,
            });
        }

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
                            let seq = backlog.lock().unwrap().append(&buf[..n]);
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
            {
                let mut backlog = backlog.lock().unwrap();
                backlog.running = false;
                backlog.exit_code = Some(exit_code);
                backlog.exited_ms = Some(exited_ms);
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

    fn next_generation(&self) -> u64 {
        let mut last = self.generation.lock().unwrap();
        *last += 1;
        *last
    }

    #[allow(clippy::type_complexity)]
    fn start_process(
        &self,
        spec: &SessionSpec,
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
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        // A spec must not replace the private command transport variable.
        if cfg!(windows) && !spec.command.is_empty() {
            cmd.env(COMMAND_ENV, &spec.command);
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
        let backlog = backlogs.get(id)?.lock().unwrap();
        Some(Snapshot {
            data: backlog.data.iter().copied().collect(),
            end: backlog.end,
            generation: backlog.generation,
            running: backlog.running,
            exit_code: backlog.exit_code,
            started_ms: backlog.started_ms,
            exited_ms: backlog.exited_ms,
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
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.process.hang_up();
        }
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
    fn notice_precedes_process_output_in_backlog_and_events() {
        let pty = Arc::new(PtyManager::new());
        let sink = Arc::new(Collect::default());
        pty.spawn(
            SessionSpec {
                id: "notice".into(),
                command: "printf process-output".into(),
                cwd: std::env::temp_dir(),
                env: BTreeMap::new(),
                notice: Some("Briefing is in $PATCHBAY_CONTEXT_FILE.".into()),
            },
            sink.clone(),
        )
        .unwrap();
        assert_eq!(sink.wait_for_exit(), 0);
        let snapshot = pty.snapshot("notice").unwrap();
        let expected = "\x1b[2m[patchbay] Briefing is in $PATCHBAY_CONTEXT_FILE.\x1b[0m\r\n";
        assert!(snapshot.data.starts_with(expected.as_bytes()));
        assert!(String::from_utf8_lossy(&snapshot.data).contains("process-output"));
        assert_eq!(String::from_utf8_lossy(&snapshot.data), sink.output());
        let events = sink.0.lock().unwrap();
        let mut end = 0;
        for event in events.iter() {
            if let TerminalEvent::Output { seq, data, .. } = event {
                assert_eq!(*seq, end);
                if end == 0 {
                    assert_eq!(data, expected.as_bytes());
                }
                end += data.len() as u64;
            }
        }
        assert_eq!(end, snapshot.end);
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
                notice: None,
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
    fn reset_forgets_history_and_keeps_generations_unique() {
        let pty = Arc::new(PtyManager::new());
        let spec = |command: &str| SessionSpec {
            id: "root/shell".into(),
            command: command.into(),
            cwd: std::env::temp_dir(),
            env: BTreeMap::new(),
            notice: None,
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
                notice: None,
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
                    notice: None,
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
                            notice: None,
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
    fn windows_command_syntax_bypasses_msvc_argument_requoting() {
        use base64::Engine as _;
        let command = r#""C:\Program Files\codex.cmd" -c "developer_instructions=\"some text\"""#;
        let cmd = windows_shell_command(command);
        assert_eq!(
            &cmd.get_argv()[..4],
            &["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand"]
                .map(std::ffi::OsString::from)
        );
        let encoded = cmd.get_argv()[4].to_str().unwrap();
        assert!(!encoded.contains(['"', ' ', '%', '&']));
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<_> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let bootstrap = String::from_utf16(&units).unwrap();
        assert!(
            bootstrap
                .contains("$p.Arguments = '/V:OFF /S /C \"' + $env:PATCHBAY_LAUNCH_COMMAND + '\"'")
        );
        assert!(!bootstrap.contains(command));
        assert_eq!(
            cmd.get_env(COMMAND_ENV),
            Some(std::ffi::OsStr::new(command))
        );
        assert_eq!(
            windows_shell_command("").get_argv(),
            &[std::ffi::OsString::from("powershell.exe")]
        );
    }

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
