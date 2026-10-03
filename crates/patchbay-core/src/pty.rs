use crate::events::{EventSink, TerminalEvent};
use anyhow::{Result, anyhow, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

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

/// Long-lived PTY sessions keyed by session id. Output and exit are reported
/// through an [`EventSink`]; nothing here blocks the caller.
#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
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
        if self.is_running(&spec.id) {
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

        self.sessions.lock().unwrap().insert(
            spec.id.clone(),
            Session {
                master: pair.master,
                writer,
                killer,
            },
        );
        sink.emit(TerminalEvent::Started {
            session_id: spec.id.clone(),
        });

        let (done_tx, done_rx) = mpsc::channel();
        {
            let sink = sink.clone();
            let id = spec.id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => sink.emit(TerminalEvent::Output {
                            session_id: id.clone(),
                            data: buf[..n].to_vec(),
                        }),
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
            manager.sessions.lock().unwrap().remove(&spec.id);
            let exit_code = match status {
                Ok(s) if s.success() => 0,
                Ok(s) => i32::try_from(s.exit_code()).unwrap_or(i32::MAX).max(1),
                Err(_) => 1,
            };
            sink.emit(TerminalEvent::Exited {
                session_id: spec.id,
                exit_code,
            });
        });
        Ok(())
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

        let mut code = None;
        for _ in 0..400 {
            code = sink.exit_code();
            if code.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(code, Some(3));
        assert!(sink.output().contains("hello"), "{}", sink.output());
        assert!(!pty.is_running("c/t"));
    }
}
