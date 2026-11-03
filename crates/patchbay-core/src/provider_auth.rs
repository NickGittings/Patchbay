//! CLI-owned authentication. Output is transient and never enters the session service.
use crate::{adapters::Adapter, context, events::TerminalEvent};
use anyhow::{Result, anyhow};
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    pub provider: Adapter,
    pub command: String,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthState {
    SignedIn,
    SignedOut,
    CliMissing,
    Unknown,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub provider: Adapter,
    pub state: AuthState,
    pub message: String,
    pub login_supported: bool,
}
impl AuthStatus {
    fn new(provider: Adapter, state: AuthState, message: &str) -> Self {
        Self {
            provider,
            state,
            message: message.into(),
            login_supported: true,
        }
    }
}

// Deliberately no Debug: launch environments can contain credentials.
struct Login {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}
impl Login {
    fn cancel(&mut self) {
        let _ = self.killer.kill();
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}
#[derive(Default)]
pub struct AuthManager {
    logins: Mutex<HashMap<String, Login>>,
    cache: Mutex<HashMap<String, (Instant, AuthStatus)>>,
    revision: AtomicU64,
}
const MISSING: &str = "PATCHBAY_AUTH_CLI_MISSING";
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

impl LaunchContext {
    /// Replace the interactive invocation with an auth command, preserving its executable,
    /// assignment prefixes and configuration options. Custom wrappers cannot be verified.
    fn auth_command(&self, login: bool) -> Option<String> {
        if context::command_provider(&self.command) != Some(self.provider) {
            return None;
        }
        let words = context::launch_words(&self.command)?;
        let (index, range) = context::launch_program(&self.command)?;
        let raw = context::launch_raw_words(&self.command)?;
        let mut options = String::new();
        let mut args = words.iter().zip(raw.iter()).skip(index + 1);
        while let Some((arg, original)) = args.next() {
            let flag = arg.split('=').next()?;
            let config = match self.provider {
                Adapter::Claude => matches!(flag, "--settings" | "--setting-sources"),
                Adapter::Codex => {
                    matches!(flag, "-c" | "--config" | "-p" | "--profile" | "-C" | "--cd")
                }
            };
            if config {
                options.push(' ');
                options.push_str(original);
                if !arg.contains('=') {
                    options.push(' ');
                    options.push_str(args.next()?.1);
                }
            }
        }
        let program = &self.command[range.clone()];
        let suffix = match (self.provider, login) {
            (Adapter::Claude, true) => " auth login",
            (Adapter::Claude, false) => " auth status",
            (Adapter::Codex, true) => " login",
            (Adapter::Codex, false) => " login status",
        };
        let invocation = format!("{program}{options}{suffix}");
        #[cfg(unix)]
        {
            // Stay in the launch's login shell, including aliases/functions. A leading `env`
            // still bypasses those, just as it does for the actual agent invocation.
            let uses_env = words.first().is_some_and(|word| word == "env");
            let assignments = raw[usize::from(uses_env)..index].join(" ");
            let export = if assignments.is_empty() {
                String::new()
            } else {
                format!("export {assignments}; ")
            };
            let runner = if uses_env { "env " } else { "" };
            Some(format!(
                "( {export}command -v {program} >/dev/null 2>&1 || {{ printf '{MISSING}\\n'; exit 127; }}; {runner}{invocation} )"
            ))
        }
        #[cfg(windows)]
        {
            let prefix = if crate::profiles::from_command(&self.command)
                .ok()
                .flatten()
                .is_some()
            {
                ""
            } else {
                &self.command[..range.start]
            };
            Some(format!(
                "{prefix}where {program} >nul 2>&1 || (echo {MISSING} & exit /b 127) & {invocation}"
            ))
        }
    }
}

impl AuthManager {
    /// Returns only safe classifications; never returns a CLI's raw authentication output.
    pub fn check(self: &Arc<Self>, context: &LaunchContext, force: bool) -> AuthStatus {
        self.check_with_timeout(context, force, CHECK_TIMEOUT)
    }
    fn check_with_timeout(
        self: &Arc<Self>,
        context: &LaunchContext,
        force: bool,
        timeout: Duration,
    ) -> AuthStatus {
        let revision = self.revision.load(Ordering::Acquire);
        let key = serde_json::to_string(context).unwrap_or_default();
        if !force
            && let Some((at, result)) = self.cache.lock().unwrap().get(&key)
            && at.elapsed() < Duration::from_secs(30)
        {
            return result.clone();
        }
        let unknown = |message| AuthStatus::new(context.provider, AuthState::Unknown, message);
        let result = if let Some(command) = context.auth_command(false) {
            let id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = mpsc::channel();
            let failed = tx.clone();
            let output = Arc::new(Mutex::new(Vec::<u8>::new()));
            let buffer = output.clone();
            let sink = Arc::new(move |event| match event {
                TerminalEvent::Output { data, .. } => {
                    let mut buffer = buffer.lock().unwrap();
                    let remaining = 65536_usize.saturating_sub(buffer.len());
                    buffer.extend(data.into_iter().take(remaining));
                }
                TerminalEvent::Exited { exit_code, .. } => {
                    let _ = tx.send(Ok(exit_code));
                }
                _ => {}
            });
            // The deadline includes shell startup and profile credential resolution. If either
            // finishes after cancellation, the worker immediately reaps the temporary process.
            let canceled = Arc::new(AtomicBool::new(false));
            let worker_canceled = canceled.clone();
            let worker = self.clone();
            let worker_id = id.clone();
            let launch = context.clone();
            std::thread::spawn(move || {
                if worker.spawn(&worker_id, &launch, &command, sink).is_err() {
                    let _ = failed.send(Err(()));
                }
                if worker_canceled.load(Ordering::Acquire) {
                    worker.cancel(&worker_id);
                }
            });
            let result = match rx.recv_timeout(timeout) {
                Ok(Ok(code)) => classify(context.provider, code, &output.lock().unwrap()),
                Ok(Err(())) => unknown(
                    "The authentication check could not start. Retry or check the CLI in a terminal.",
                ),
                Err(_) => unknown(
                    "The authentication check timed out after 10 seconds. Retry or continue anyway.",
                ),
            };
            canceled.store(true, Ordering::Release);
            let manager = self.clone();
            std::thread::spawn(move || manager.cancel(&id));
            result
        } else {
            let mut result = unknown(
                "This custom command cannot be verified. Sign in through its provider or wrapper, then choose Continue anyway.",
            );
            result.login_supported = false;
            result
        };
        let mut cache = self.cache.lock().unwrap();
        if revision == self.revision.load(Ordering::Acquire) {
            cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(30));
            cache.insert(key, (Instant::now(), result.clone()));
        }
        result
    }
    pub fn invalidate(&self) {
        let mut cache = self.cache.lock().unwrap();
        self.revision.fetch_add(1, Ordering::AcqRel);
        cache.clear();
    }
    /// Starts a temporary PTY with no briefing, hooks, transcript or persisted metadata.
    pub fn login(
        self: &Arc<Self>,
        id: &str,
        context: &LaunchContext,
        sink: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
    ) -> Result<()> {
        let command = context
            .auth_command(true)
            .ok_or_else(|| anyhow!("Sign in using the custom wrapper's own instructions"))?;
        self.invalidate();
        let manager = self.clone();
        self.spawn(
            id,
            context,
            &command,
            Arc::new(move |event| {
                if matches!(event, TerminalEvent::Exited { .. }) {
                    manager.invalidate();
                }
                sink(event);
            }),
        )
    }
    fn spawn(
        self: &Arc<Self>,
        id: &str,
        context: &LaunchContext,
        command: &str,
        sink: Arc<dyn Fn(TerminalEvent) + Send + Sync>,
    ) -> Result<()> {
        let profile_token = crate::profiles::launch_token(&context.command)?;
        let mut logins = self.logins.lock().unwrap();
        anyhow::ensure!(!logins.contains_key(id), "A login is already active");
        let pair = native_pty_system().openpty(PtySize {
            rows: 18,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = crate::pty::shell_command(command);
        cmd.cwd(&context.cwd);
        cmd.env("TERM", "xterm-256color");
        if cfg!(windows) && crate::profiles::from_command(&context.command)?.is_some() {
            for word in context::launch_words(&context.command).unwrap_or_default() {
                let Some((key, value)) = word.split_once('=') else {
                    break;
                };
                if !key.starts_with("PATCHBAY_") {
                    cmd.env(key, value);
                }
            }
        }
        for (key, value) in &context.env {
            if !key.starts_with("PATCHBAY_") {
                cmd.env(key, value);
            }
        }
        for key in crate::agent_bridge::BRIDGE_ENV.iter().copied().chain([
            crate::status::STATUS_ENV,
            crate::agent_hooks::SESSION_ENV,
            crate::agent_hooks::GENERATION_ENV,
            crate::agent_hooks::PROVIDER_ENV,
            crate::agent_hooks::JOURNAL_ENV,
            crate::context::CONTEXT_ENV,
            "PATCHBAY_PROFILE_TOKEN",
        ]) {
            cmd.env_remove(key);
        }
        if let Some(token) = profile_token {
            cmd.env("ANTHROPIC_AUTH_TOKEN", &token);
            cmd.env("PATCHBAY_PROFILE_TOKEN", token);
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        logins.insert(
            id.into(),
            Login {
                master: pair.master,
                writer,
                killer: child.clone_killer(),
                pid: child.process_id(),
            },
        );
        drop(logins);
        let session_id = id.to_string();
        let output_sink = sink.clone();
        let output_id = session_id.clone();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            let mut seq = 0;
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                output_sink(TerminalEvent::Output {
                    session_id: output_id.clone(),
                    generation: 1,
                    seq,
                    data: buf[..n].to_vec(),
                });
                seq += n as u64;
            }
            let _ = done_tx.send(());
        });
        let manager = self.clone();
        std::thread::spawn(move || {
            let code = child
                .wait()
                .map_or(-1, |s| i32::try_from(s.exit_code()).unwrap_or(-1));
            // Readers normally drain before exit; never let an inherited descriptor hang a check.
            let _ = done_rx.recv_timeout(Duration::from_millis(100));
            manager.cancel(&session_id);
            sink(TerminalEvent::Exited {
                session_id,
                generation: 1,
                exit_code: code,
                exited_ms: crate::pty::now_ms(),
            });
        });
        Ok(())
    }
    pub fn cancel(&self, id: &str) {
        if let Some(mut login) = self.logins.lock().unwrap().remove(id) {
            login.cancel();
        }
    }
    pub fn cancel_prefix(&self, prefix: &str) {
        let ids: Vec<_> = self
            .logins
            .lock()
            .unwrap()
            .keys()
            .filter(|id| id.starts_with(prefix))
            .cloned()
            .collect();
        for id in ids {
            self.cancel(&id);
        }
    }
    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        self.logins
            .lock()
            .unwrap()
            .get_mut(id)
            .ok_or_else(|| anyhow!("Login has ended"))?
            .writer
            .write_all(data)?;
        Ok(())
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.logins
            .lock()
            .unwrap()
            .get(id)
            .ok_or_else(|| anyhow!("Login has ended"))?
            .master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }
}
fn classify(provider: Adapter, code: i32, bytes: &[u8]) -> AuthStatus {
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_ascii_lowercase();
    let (state, message) = if code == 127 && text.lines().any(|l| l.trim() == MISSING) {
        (
            AuthState::CliMissing,
            "The provider CLI is missing from the launch environment. Install it, then check status again.",
        )
    } else if provider == Adapter::Claude
        && let Some(value) = text
            .find('{')
            .zip(text.rfind('}'))
            .and_then(|(a, b)| serde_json::from_str::<serde_json::Value>(&text[a..=b]).ok())
        && let Some(logged_in) = value.get("loggedIn").and_then(serde_json::Value::as_bool)
        && ((logged_in && code == 0) || (!logged_in && code == 1))
    {
        if logged_in {
            (AuthState::SignedIn, "Signed in through the provider CLI.")
        } else {
            (
                AuthState::SignedOut,
                "Sign in before starting this provider.",
            )
        }
    } else if provider == Adapter::Codex
        && code == 0
        && lower
            .lines()
            .any(|l| l.trim().starts_with("logged in using "))
    {
        (AuthState::SignedIn, "Signed in through the provider CLI.")
    } else if provider == Adapter::Codex
        && code == 1
        && lower.lines().any(|l| l.trim() == "not logged in")
    {
        (
            AuthState::SignedOut,
            "Sign in before starting this provider.",
        )
    } else if [
        "unexpected argument",
        "unknown command",
        "unrecognized subcommand",
        "unknown subcommand",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        (
            AuthState::Unknown,
            "This CLI version does not support authentication status. Update it, retry, or continue anyway.",
        )
    } else {
        (
            AuthState::Unknown,
            "The CLI could not confirm authentication. Retry or continue anyway.",
        )
    };
    AuthStatus::new(provider, state, message)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-auth-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn context(&self, provider: Adapter, body: &str) -> LaunchContext {
            let exe = self.0.join(match provider {
                Adapter::Claude => "claude",
                Adapter::Codex => "codex",
            });
            std::fs::write(&exe, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
            LaunchContext {
                provider,
                command: context::quote_argument(exe.to_str().unwrap()),
                cwd: self.0.clone(),
                env: BTreeMap::new(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn signed_in_and_out_are_confirmed_by_each_cli() {
        let fixture = Fixture::new();
        let manager = Arc::new(AuthManager::default());
        for (provider, body, expected) in [
            (
                Adapter::Claude,
                "printf '{\"loggedIn\":true,\"apiKey\":\"secret-canary\"}'",
                AuthState::SignedIn,
            ),
            (
                Adapter::Claude,
                "printf '{\"loggedIn\":false}'; exit 1",
                AuthState::SignedOut,
            ),
            (
                Adapter::Codex,
                "printf 'Logged in using an API key: secret-canary\\n' >&2",
                AuthState::SignedIn,
            ),
            (
                Adapter::Codex,
                "printf 'Not logged in\\n' >&2; exit 1",
                AuthState::SignedOut,
            ),
        ] {
            let context = fixture.context(provider, body);
            let result = manager.check(&context, true);
            assert_eq!(result.state, expected, "{result:?}");
            assert!(
                !serde_json::to_string(&result)
                    .unwrap()
                    .contains("secret-canary")
            );
        }
    }
    #[test]
    fn failures_and_unsupported_commands_are_never_signed_out() {
        let fixture = Fixture::new();
        let manager = Arc::new(AuthManager::default());
        for (body, guidance) in [
            (
                "echo 'error: unrecognized subcommand status'; exit 2",
                "does not support",
            ),
            (
                "echo 'secret-canary: cannot read credentials'; exit 1",
                "could not confirm",
            ),
            (
                "echo 'Logged in using secret-canary'; exit 1",
                "could not confirm",
            ),
            ("echo help; exit 0", "could not confirm"),
        ] {
            let result = manager.check(&fixture.context(Adapter::Codex, body), true);
            assert_eq!(result.state, AuthState::Unknown);
            assert!(result.message.contains(guidance));
            assert!(!result.message.contains("secret-canary"));
        }
        let mut context = fixture.context(Adapter::Claude, "exit 0");
        std::fs::remove_file(fixture.0.join("claude")).unwrap();
        assert_eq!(manager.check(&context, true).state, AuthState::CliMissing);
        context.command = "my-wrapper".into();
        let result = manager.check(&context, true);
        assert_eq!(result.state, AuthState::Unknown);
        assert!(!result.login_supported);
    }
    #[test]
    fn preserves_executable_cwd_environment_and_config_options() {
        let fixture = Fixture::new();
        let manager = Arc::new(AuthManager::default());
        let mut context = fixture.context(
            Adapter::Codex,
            r#"
[ "$CODEX_HOME" = "$EXPECTED_CONFIG" ] || exit 5
[ "$(pwd -P)" = "$EXPECTED_CWD" ] || exit 10
[ "$INJECTED" = configured ] || exit 6
[ -z "$PATCHBAY_REPORT_DIR$PATCHBAY_CONTEXT_FILE$PATCHBAY_REPORT_PROVIDER" ] || exit 7
[ "$1" = '-c' ] && [ "$2" = 'model_provider="enterprise"' ] || exit 8
[ "$3" = '--profile=work' ] && [ "$4 $5" = 'login status' ] || exit 9
printf 'Logged in using Agent Identity\n'
"#,
        );
        context.command = format!(
            "env CODEX_HOME={} {} --model ignored -c 'model_provider=\"enterprise\"' --profile=work",
            context::quote_argument(fixture.0.join("custom home").to_str().unwrap()),
            context.command
        );
        context.env.insert(
            "EXPECTED_CONFIG".into(),
            fixture.0.join("custom home").display().to_string(),
        );
        context.env.insert(
            "EXPECTED_CWD".into(),
            fixture.0.canonicalize().unwrap().display().to_string(),
        );
        context.env.insert("INJECTED".into(), "configured".into());
        context
            .env
            .insert("PATCHBAY_REPORT_DIR".into(), "must-not-inherit".into());
        assert_eq!(manager.check(&context, true).state, AuthState::SignedIn);
        context.env.insert("INJECTED".into(), "other-config".into());
        assert_eq!(manager.check(&context, false).state, AuthState::Unknown);
    }
    #[test]
    fn status_is_cached_by_context_and_login_invalidates_it() {
        let fixture = Fixture::new();
        let manager = Arc::new(AuthManager::default());
        let context = fixture.context(Adapter::Claude, "printf '{\"loggedIn\":false}'; exit 1");
        assert_eq!(manager.check(&context, false).state, AuthState::SignedOut);
        fixture.context(Adapter::Claude, "printf '{\"loggedIn\":true}'");
        assert_eq!(manager.check(&context, false).state, AuthState::SignedOut);
        let (tx, rx) = mpsc::channel();
        manager
            .login(
                "login",
                &context,
                Arc::new(move |e| {
                    if matches!(e, TerminalEvent::Exited { .. }) {
                        let _ = tx.send(());
                    }
                }),
            )
            .unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(manager.check(&context, false).state, AuthState::SignedIn);
    }
    #[test]
    fn status_timeout_and_login_cancel_reap_processes_without_history() {
        let fixture = Fixture::new();
        let manager = Arc::new(AuthManager::default());
        let context = fixture.context(Adapter::Claude, "echo waiting; exec sleep 60");
        let start = Instant::now();
        let result = manager.check_with_timeout(&context, true, Duration::from_millis(100));
        assert_eq!(result.state, AuthState::Unknown);
        assert!(result.message.contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(3));
        let (tx, rx) = mpsc::channel();
        manager
            .login(
                "webview/login",
                &context,
                Arc::new(move |e| {
                    if matches!(e, TerminalEvent::Exited { .. }) {
                        let _ = tx.send(());
                    }
                }),
            )
            .unwrap();
        manager.cancel_prefix("webview/");
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(manager.logins.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
        assert!(manager.write("webview/login", b"secret").is_err());
    }
}
