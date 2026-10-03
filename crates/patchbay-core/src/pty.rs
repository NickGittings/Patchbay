use crate::events::{EventSink, TerminalEvent};
use anyhow::{Result, anyhow, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

const BACKLOG_CAPACITY: usize = 512 * 1024;

const DEFAULT_SIZE: (u16, u16) = (120, 30);

/// What to launch in a terminal session.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub id: String,
    /// Empty for an interactive shell.
    pub command: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct Backlog {
    data: VecDeque<u8>,
    end: u64,
    generation: u64,
    running: bool,
    exit_code: Option<i32>,
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
    pub data: Vec<u8>,
    pub end: u64,
    pub generation: u64,
    pub running: bool,
    pub exit_code: Option<i32>,
}

/// Long-lived PTY sessions keyed by session id. Output and exit are reported
/// through an [`EventSink`]; nothing here blocks the caller.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
    backlogs: Mutex<HashMap<String, Arc<Mutex<Backlog>>>>,
    sizes: Mutex<HashMap<String, (u16, u16)>>,
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
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&spec.id) {
            bail!("{} is already running", spec.id);
        }
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

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let killer = child.clone_killer();

        let mut backlogs = self.backlogs.lock().unwrap();
        let generation = backlogs
            .get(&spec.id)
            .map_or(1, |b| b.lock().unwrap().generation + 1);
        let backlog = Arc::new(Mutex::new(Backlog {
            generation,
            running: true,
            ..Backlog::default()
        }));
        backlogs.insert(spec.id.clone(), backlog.clone());
        drop(backlogs);
        sessions.insert(
            spec.id.clone(),
            Session {
                master: pair.master,
                writer,
                killer,
            },
        );
        sink.emit(TerminalEvent::Started {
            session_id: spec.id.clone(),
            generation,
        });
        drop(sessions);

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
                            let mut backlog = backlog.lock().unwrap();
                            let seq = backlog.append(&buf[..n]);
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
            // Let the reader drain; on Windows it only sees EOF once the master closes.
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
            let mut sessions = manager.sessions.lock().unwrap();
            sessions.remove(&spec.id);
            let exit_code = match status {
                Ok(s) if s.success() => 0,
                Ok(s) => i32::try_from(s.exit_code()).unwrap_or(i32::MAX).max(1),
                Err(_) => 1,
            };
            let mut backlog = backlog.lock().unwrap();
            backlog.running = false;
            backlog.exit_code = Some(exit_code);
            sink.emit(TerminalEvent::Exited {
                session_id: spec.id,
                generation,
                exit_code,
            });
        });
        Ok(())
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
            let _ = s.killer.kill();
        }
    }

    /// # Panics
    /// Panics if an internal lock is poisoned.
    pub fn kill_all(&self) {
        for s in self.sessions.lock().unwrap().values_mut() {
            let _ = s.killer.kill();
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
