//! Local subscription usage snapshots and opt-in Claude status-line capture.
use crate::{adapters::Adapter, agent_hooks};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const TAIL_BYTES: u64 = 256 * 1024;
const INPUT_LIMIT: u64 = 1024 * 1024;
/// Session logs selected by modification time, regardless of their start date.
const CODEX_FILES: usize = 8;
/// Codex windows shorter than this (about the geometric mean of 5 hours and a week) are
/// the 5-hour window, longer ones the weekly window.
const WINDOW_SPLIT_MINUTES: u64 = 1739;
/// A capture with unchanged values still refreshes `observed_ms` this often.
const OBSERVED_REFRESH_MS: u64 = 60_000;
const RESET_ROUND_MS: u64 = 60_000;
/// After the chained shell exits, how long a background child may keep its output open.
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(200);
/// File names of the executables Patchbay installs as a status-line reporter.
const REPORTER_NAMES: [&str; 4] = [
    "patchbay-status-v1",
    "patchbay-status-v1.exe",
    "patchbay-sessiond",
    "patchbay-sessiond.exe",
];
/// Set on a chained status line, so a Patchbay reporter it runs never chains again.
const CHAINED_ENV: &str = "PATCHBAY_STATUS_LINE_CHAINED";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: f64,
    pub resets_at_ms: u64,
    pub window_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider: Adapter,
    pub five_hour: Option<Window>,
    pub weekly: Option<Window>,
    pub observed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLine {
    pub installed: bool,
    pub chained: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub claude: Option<ProviderUsage>,
    pub codex: Option<ProviderUsage>,
    /// Absent when Claude's settings can't be read; `claude_error` says why.
    pub claude_capture: Option<StatusLine>,
    /// Each provider fails on its own, so one bad configuration never hides the other.
    pub claude_error: Option<String>,
    pub codex_error: Option<String>,
}

impl ProviderUsage {
    fn expire(&mut self, now_ms: u64) {
        for window in [&mut self.five_hour, &mut self.weekly] {
            if window.as_ref().is_some_and(|w| w.resets_at_ms <= now_ms) {
                *window = None;
            }
        }
    }
}

fn usage_dir() -> Result<PathBuf> {
    Ok(crate::workspace::home()?.join("usage"))
}

/// `base_ms` is when the report was made, for a reset given in seconds from then.
fn window(value: &Value, percent: &str, minutes: u32, base_ms: Option<u64>) -> Option<Window> {
    let used_percent = value.get(percent)?.as_f64()?;
    if !used_percent.is_finite() || used_percent < 0.0 {
        return None;
    }
    let resets_at_ms = match value.get("resets_at").and_then(Value::as_u64) {
        Some(at) => at.checked_mul(1000)?,
        None => base_ms?.checked_add(
            value
                .get("resets_in_seconds")?
                .as_u64()?
                .checked_mul(1000)?,
        )?,
    };
    Some(Window {
        // An exhausted or overage window must still read as at its limit.
        used_percent: used_percent.min(100.0),
        // A reset relative to each event drifts by seconds between reports; whole minutes keep
        // the same window's alerts and display stable.
        resets_at_ms: resets_at_ms.checked_add(RESET_ROUND_MS / 2)? / RESET_ROUND_MS
            * RESET_ROUND_MS,
        window_minutes: minutes,
    })
}

fn claude_input(input: &Value, observed_ms: u64) -> Option<ProviderUsage> {
    let limits = input.get("rate_limits")?.as_object()?;
    Some(ProviderUsage {
        provider: Adapter::Claude,
        five_hour: limits
            .get("five_hour")
            .and_then(|v| window(v, "used_percentage", 300, None)),
        weekly: limits
            .get("seven_day")
            .and_then(|v| window(v, "used_percentage", 10080, None)),
        observed_ms,
    })
}

fn codex_tail(bytes: &[u8], fallback_ms: u64) -> Option<ProviderUsage> {
    // A partial first line, a concurrent partial last write, or an unrelated event is harmless.
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .find_map(|line| {
            let event: Value = serde_json::from_str(line).ok()?;
            if event.get("type")?.as_str()? != "event_msg" {
                return None;
            }
            let payload = event.get("payload")?;
            if payload.get("type")?.as_str()? != "token_count" {
                return None;
            }
            let limits = payload.get("rate_limits")?;
            // Other limits (e.g. premium models) are separate; older logs name none.
            if !limits
                .get("limit_id")
                .is_none_or(|id| id.is_null() || id.as_str() == Some("codex"))
            {
                return None;
            }
            let mut usage = ProviderUsage {
                provider: Adapter::Codex,
                five_hour: None,
                weekly: None,
                observed_ms: event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .and_then(|t| u64::try_from(t.timestamp_millis()).ok())
                    .unwrap_or(fallback_ms),
            };
            for key in ["primary", "secondary"] {
                let Some(value) = limits.get(key) else {
                    continue;
                };
                let Some(minutes) = value
                    .get("window_minutes")
                    .and_then(Value::as_u64)
                    .filter(|&m| m > 0)
                    .and_then(|m| u32::try_from(m).ok())
                else {
                    continue;
                };
                let slot = if u64::from(minutes) < WINDOW_SPLIT_MINUTES {
                    &mut usage.five_hour
                } else {
                    &mut usage.weekly
                };
                if slot.is_none() {
                    *slot = window(value, "used_percent", minutes, Some(usage.observed_ms));
                }
            }
            (usage.five_hour.is_some() || usage.weekly.is_some()).then_some(usage)
        })
}

type Stamped = (std::time::SystemTime, PathBuf);

fn jsonl_files(dir: &Path, files: &mut Vec<Stamped>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_file())
            && entry.path().extension().is_some_and(|s| s == "jsonl")
            && let Ok(modified) = entry.metadata().and_then(|m| m.modified())
        {
            files.push((modified, entry.path()));
        }
    }
}

/// Subfolders named by a zero-padded date part (`2026`, `03`), newest first.
fn dated_dirs(dir: &Path, digits: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            (name.len() == digits && name.bytes().all(|b| b.is_ascii_digit()))
                .then(|| (name, entry.path()))
        })
        .collect();
    dirs.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    dirs.into_iter().map(|(_, path)| path).collect()
}

/// Codex files logs under `YYYY/MM/DD` by start date, but an old session can still be
/// active. Stat every date before choosing the most recently modified logs, including flat logs.
fn session_files(dir: &Path) -> Vec<Stamped> {
    let mut files = Vec::new();
    jsonl_files(dir, &mut files);
    let mut dated = Vec::new();
    for year in dated_dirs(dir, 4) {
        for month in dated_dirs(&year, 2) {
            for day in dated_dirs(&month, 2) {
                jsonl_files(&day, &mut dated);
            }
        }
    }
    files.append(&mut dated);
    files.sort_unstable_by_key(|a| std::cmp::Reverse(a.0));
    files.truncate(CODEX_FILES);
    files
}

type Parsed = (u64, std::time::SystemTime, Option<ProviderUsage>);

/// Parsed tails by file, valid while its length and mtime are unchanged.
static CODEX_CACHE: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, Parsed>>> =
    std::sync::Mutex::new(None);

fn codex_file(path: &Path, mtime: std::time::SystemTime) -> Option<ProviderUsage> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if let Some((_, _, parsed)) = CODEX_CACHE
        .lock()
        .ok()?
        .get_or_insert_default()
        .get(path)
        .filter(|(l, m, _)| *l == len && *m == mtime)
    {
        return parsed.clone();
    }
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let parsed = codex_tail(&bytes, unix_ms(mtime)?);
    if let Ok(mut cache) = CODEX_CACHE.lock() {
        cache
            .get_or_insert_default()
            .insert(path.to_owned(), (len, mtime, parsed.clone()));
    }
    parsed
}

fn unix_ms(time: std::time::SystemTime) -> Option<u64> {
    u64::try_from(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis()).ok()
}

fn read_codex(dir: &Path) -> Option<ProviderUsage> {
    let files = session_files(dir);
    if let Ok(mut cache) = CODEX_CACHE.lock() {
        // Only the files still among the newest stay cached.
        cache
            .get_or_insert_default()
            .retain(|path, _| files.iter().any(|(_, p)| p == path));
    }
    let mut best: Option<ProviderUsage> = None;
    // Newest first: a file last written before the best report can't hold a newer one.
    for (mtime, path) in files {
        if best
            .as_ref()
            .is_some_and(|b| unix_ms(mtime).is_some_and(|ms| ms < b.observed_ms))
        {
            break;
        }
        if let Some(usage) = codex_file(&path, mtime)
            && best
                .as_ref()
                .is_none_or(|b| usage.observed_ms > b.observed_ms)
        {
            best = Some(usage);
        }
    }
    best
}

/// Read local provider snapshots; expired windows are omitted, never used to gate launches.
/// A provider whose configuration can't be read reports its error and no usage.
#[must_use]
pub fn read(now_ms: u64) -> Usage {
    let claude = usage_dir().map(|dir| {
        std::fs::read(dir.join("claude.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(|u: &ProviderUsage| u.provider == Adapter::Claude)
    });
    let capture = inspect_status_line(None);
    // Only the folder is needed; a malformed config.toml must not hide Codex's own logs.
    let codex = agent_hooks::user_dir(Adapter::Codex).map(|dir| read_codex(&dir.join("sessions")));
    let error = |e: &anyhow::Error| format!("{e:#}");
    let claude_error = claude
        .as_ref()
        .err()
        .or_else(|| capture.as_ref().err())
        .map(error);
    let codex_error = codex.as_ref().err().map(error);
    let mut claude = claude.ok().flatten();
    let mut codex = codex.ok().flatten();
    for provider in [&mut claude, &mut codex].into_iter().flatten() {
        provider.expire(now_ms);
    }
    Usage {
        claude,
        codex,
        claude_capture: capture.ok(),
        claude_error,
        codex_error,
    }
}

fn quoted(path: &Path) -> Result<String> {
    let path = path.to_str().context("Status-line paths must be UTF-8")?;
    // Claude uses a POSIX shell on every platform, including Git Bash on Windows.
    let path = if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    Ok(crate::context::sh_quote(&path))
}

/// The installed command names its usage folder, so the reporter finds the capture and chain
/// that install saved whatever Claude's environment says (`PATCHBAY_STATE_DIR`, config folder).
/// `dir: None` is the form installed before it did.
fn status_command(reporter: &Path, dir: Option<&Path>) -> Result<Value> {
    let mut command = format!("{} status-line", quoted(reporter)?);
    if let Some(dir) = dir {
        command = format!("{command} {}", quoted(dir)?);
    }
    Ok(json!({"type":"command", "command":command}))
}

fn owned(value: Option<&Value>, reporter: &Path, dir: &Path) -> bool {
    [Some(dir), None].into_iter().any(|dir| {
        status_command(reporter, dir).ok().is_some_and(|expected| {
            value.is_some_and(|v| {
                v.get("type") == expected.get("type")
                    && (v.get("command") == expected.get("command")
                        || v.get("command")
                            .and_then(Value::as_str)
                            .and_then(crate::context::sh_words)
                            .is_some_and(|words| {
                                // Recognize earlier Windows installs that used double quotes.
                                Some(words)
                                    == expected
                                        .get("command")
                                        .and_then(Value::as_str)
                                        .and_then(crate::context::sh_words)
                            }))
            })
        })
    })
}

/// Whether a status-line command runs a Patchbay reporter, from any state directory.
/// Chaining to one would make it call itself.
fn is_reporter(command: &str) -> bool {
    // Claude runs status lines in a POSIX shell, Git Bash included.
    let Some(tokens) = crate::context::sh_words(command) else {
        return false;
    };
    let [program, mode, ..] = tokens.as_slice() else {
        return false;
    };
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    mode == "status-line"
        && REPORTER_NAMES
            .iter()
            .any(|reporter| name.eq_ignore_ascii_case(reporter))
}

/// A status line Patchbay may run after its own: anything but another reporter.
fn chainable(value: &Value) -> bool {
    !value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(is_reporter)
}

/// The status line saved at install; `source: None` (the reporter at run time) trusts the
/// folder alone, since Claude's environment may name its settings by another path.
/// Setup compares resolved paths so aliases of the same settings share their saved line.
fn saved_chain(dir: &Path, source: Option<&Path>) -> Option<Value> {
    let saved: Value =
        serde_json::from_slice(&std::fs::read(dir.join("statusline-chain.json")).ok()?).ok()?;
    if source.is_some_and(|source| {
        saved
            .get("source")
            .and_then(Value::as_str)
            .is_none_or(|saved| {
                let saved = Path::new(saved);
                saved != source
                    && !std::fs::canonicalize(saved).ok().is_some_and(|resolved| {
                        std::fs::canonicalize(source).ok().as_ref() == Some(&resolved)
                    })
            })
    }) || saved.get("present").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    saved.get("statusLine").filter(|v| chainable(v)).cloned()
}

/// Take over the original line saved by another install, never the reporter itself.
fn replaced_chain(value: &Value, source: &Path) -> Option<Value> {
    let Some(command) = value.get("command").and_then(Value::as_str) else {
        return Some(value.clone());
    };
    if !is_reporter(command) {
        return Some(value.clone());
    }
    let tokens = crate::context::sh_words(command)?;
    let dir = tokens.get(2).map(PathBuf::from).or_else(|| {
        // Legacy reporter commands did not name their usage folder.
        Some(Path::new(tokens.first()?).parent()?.parent()?.join("usage"))
    })?;
    dir.is_absolute()
        .then(|| saved_chain(&dir, Some(source)))
        .flatten()
}

fn inspect_at(source: &Path, reporter: &Path, dir: &Path) -> Result<StatusLine> {
    anyhow::ensure!(source.is_absolute(), "Status-line source must be absolute");
    let value = agent_hooks::read_json(source, Adapter::Claude)?;
    let installed = owned(value.get("statusLine"), reporter, dir);
    let chain = if installed {
        saved_chain(dir, Some(source))
    } else {
        value.get("statusLine").filter(|v| chainable(v)).cloned()
    };
    Ok(StatusLine {
        installed,
        chained: chain
            .as_ref()
            .and_then(|v| v.get("command"))
            .and_then(Value::as_str)
            .map(Into::into),
        source: source.display().to_string(),
    })
}

/// Inspect Claude's effective user status-line configuration without changing it.
///
/// # Errors
/// Fails for malformed or inaccessible settings or invalid source paths.
pub fn inspect_status_line(source_override: Option<&Path>) -> Result<StatusLine> {
    let source = source_override.map_or_else(
        || agent_hooks::user_source(Adapter::Claude),
        |p| Ok(p.to_owned()),
    )?;
    inspect_at(&source, &agent_hooks::stable_reporter()?, &usage_dir()?)
}

fn configure_at(
    source: &Path,
    helper: &Path,
    reporter: &Path,
    dir: &Path,
    install: bool,
) -> Result<StatusLine> {
    anyhow::ensure!(source.is_absolute(), "Status-line source must be absolute");
    // Resolve an existing settings symlink before atomic replacement; replacing the alias
    // would either fail or disconnect it from the provider's actual settings.
    let resolved = match std::fs::canonicalize(source) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => source.to_owned(),
        Err(e) => return Err(e.into()),
    };
    let source = resolved.as_path();
    let before = agent_hooks::read_optional(source)?;
    let mut value = agent_hooks::read_json(source, Adapter::Claude)?;
    let ours = owned(value.get("statusLine"), reporter, dir);
    let chain = if install && !ours {
        value
            .get("statusLine")
            .and_then(|v| replaced_chain(v, source))
    } else {
        saved_chain(dir, Some(source))
    };
    if install {
        value["statusLine"] = status_command(reporter, Some(dir))?;
        agent_hooks::deploy_helper(helper, reporter)?;
    } else if ours {
        if let Some(saved) = &chain {
            value["statusLine"] = saved.clone();
        } else {
            value
                .as_object_mut()
                .context("Expected settings object")?
                .remove("statusLine");
        }
    }
    let bytes = serde_json::to_vec_pretty(&value)?;
    anyhow::ensure!(
        agent_hooks::read_optional(source)? == before,
        "Provider configuration changed during setup; check capture and retry"
    );
    if install && !ours {
        crate::workspace::private_dir(dir)?;
        agent_hooks::atomic_replace(
            &dir.join("statusline-chain.json"),
            &serde_json::to_vec(
                &json!({"source":source, "present":chain.is_some(), "statusLine":chain}),
            )?,
            false,
        )?;
    }
    anyhow::ensure!(
        agent_hooks::read_optional(source)? == before,
        "Provider configuration changed during setup; check capture and retry"
    );
    if (install || ours) && serde_json::from_str::<Value>(&before).ok().as_ref() != Some(&value) {
        agent_hooks::atomic_replace(source, &bytes, false)?;
    }
    // Keep the saved line until settings have committed, including after a failed write.
    if !install && ours {
        let _ = std::fs::remove_file(dir.join("statusline-chain.json"));
    }
    inspect_at(source, reporter, dir)
}

/// Install capture, wrapping an existing status line, or restore it if still owned by Patchbay.
///
/// # Errors
/// Fails for malformed/changed settings, a missing helper, or filesystem errors.
pub fn configure_status_line(
    source_override: Option<&Path>,
    helper: &Path,
    install: bool,
) -> Result<StatusLine> {
    let source = source_override.map_or_else(
        || agent_hooks::user_source(Adapter::Claude),
        |p| Ok(p.to_owned()),
    )?;
    let _lock = agent_hooks::setup_lock()?;
    configure_at(
        &source,
        helper,
        &agent_hooks::stable_reporter()?,
        &usage_dir()?,
        install,
    )
}

fn save_capture(dir: &Path, input: &Value, now_ms: u64) -> Result<Option<ProviderUsage>> {
    let Some(mut usage) = claude_input(input, now_ms) else {
        return Ok(None);
    };
    crate::workspace::private_dir(dir)?;
    let lock = crate::workspace::lock(&dir.join("capture.lock"))?;
    // Parallel Claude sessions must never wait on another capture.
    if lock.try_lock().is_err() {
        return Ok(Some(usage));
    }
    let path = dir.join("claude.json");
    let previous: Option<ProviderUsage> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(previous) = previous.as_ref().filter(|p| p.provider == Adapter::Claude) {
        for (incoming, saved) in [
            (&mut usage.five_hour, &previous.five_hour),
            (&mut usage.weekly, &previous.weekly),
        ] {
            if let (Some(incoming), Some(saved)) = (incoming, saved)
                && saved.resets_at_ms > now_ms
                && (saved.resets_at_ms > incoming.resets_at_ms
                    || (saved.resets_at_ms == incoming.resets_at_ms
                        && saved.used_percent > incoming.used_percent))
            {
                // An idle session may redraw an old reading after a busier one.
                *incoming = saved.clone();
            }
        }
    }
    // Unchanged values are still rewritten now and then, so the snapshot's age stays honest.
    if !previous.is_some_and(|p| {
        p.five_hour == usage.five_hour
            && p.weekly == usage.weekly
            && now_ms.abs_diff(p.observed_ms) < OBSERVED_REFRESH_MS
    }) {
        agent_hooks::atomic_replace(&path, &serde_json::to_vec(&usage)?, false)?;
    }
    Ok(Some(usage))
}

/// The shell that runs a chained status line, and its command flag.
#[cfg(windows)]
fn chain_shell() -> (std::ffi::OsString, &'static str) {
    // Claude runs status lines in Git Bash on Windows, and a POSIX `$SHELL` path such as
    // `/usr/bin/bash` can't be spawned natively. System32's bash would start WSL instead.
    let system = |p: &Path| {
        p.to_string_lossy()
            .to_ascii_lowercase()
            .replace('/', "\\")
            .contains("\\windows\\system32\\")
    };
    let bash = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .or_else(|| {
            crate::navigation::find_program("bash", &std::env::var_os("PATH").unwrap_or_default())
        })
        .filter(|p| !system(p));
    match bash {
        Some(bash) => (bash.into(), "-c"),
        None => ("cmd.exe".into(), "/C"),
    }
}

/// Claude runs status lines with `/bin/sh` (Node's `shell: true`), whatever the login shell.
#[cfg(not(windows))]
fn chain_shell() -> (std::ffi::OsString, &'static str) {
    ("/bin/sh".into(), "-c")
}

/// Ends the shell and everything it started, since descendants may outlive it.
fn kill_tree(child: &mut std::process::Child) {
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs the wrapped status line with Claude's input; true once it printed something.
fn chained_output(command: &str, bytes: &[u8]) -> Result<bool> {
    use std::process::{Command, Stdio};
    let (shell, flag) = chain_shell();
    let mut process = Command::new(shell);
    process.arg(flag);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        if flag == "/C" {
            // cmd doesn't parse the MSVC quoting Rust applies; `/S` strips the outer quotes.
            process.arg("/S").raw_arg(format!("\"{command}\""));
        } else {
            process.arg(command);
        }
    }
    #[cfg(not(windows))]
    process.arg(command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        process.process_group(0);
    }
    let mut child = process
        .env(CHAINED_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let input = bytes.to_vec();
    // Feed/drain concurrently: neither a full pipe nor a command ignoring stdin can block the deadline.
    std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&input);
        }
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(INPUT_LIMIT).read_to_end(&mut bytes);
        }
        let _ = sender.send(bytes);
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if child.try_wait()?.is_some() {
            // A background child may keep the pipe open: end it shortly, then take what was
            // written. Never join a reader that is still waiting on it.
            let wait =
                EXIT_GRACE.min(deadline.saturating_duration_since(std::time::Instant::now()));
            let bytes = receiver.recv_timeout(wait).ok().or_else(|| {
                kill_tree(&mut child);
                receiver.recv_timeout(EXIT_GRACE).ok()
            });
            if let Some(bytes) = bytes
                && !bytes.iter().all(u8::is_ascii_whitespace)
            {
                std::io::stdout().write_all(&bytes)?;
                return Ok(true);
            }
            return Ok(false);
        }
        if std::time::Instant::now() >= deadline {
            kill_tree(&mut child);
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Sessiond's fail-open status-line entry point. Never writes a hook journal or returns an error.
/// `dir` is the usage folder the installed command names; older installs name none.
pub fn capture_status_line(dir: Option<&Path>) {
    let mut bytes = Vec::new();
    let _ = std::io::stdin()
        .take(INPUT_LIMIT + 1)
        .read_to_end(&mut bytes);
    if bytes.len() as u64 > INPUT_LIMIT {
        return;
    }
    let dir = dir
        .filter(|d| d.is_absolute())
        .map(Path::to_owned)
        .or_else(|| usage_dir().ok());
    let usage = (|| -> Result<Option<ProviderUsage>> {
        save_capture(
            dir.as_deref().context("No usage folder")?,
            &serde_json::from_slice(&bytes)?,
            crate::pty::now_ms(),
        )
    })()
    .ok()
    .flatten();
    // Run from a chained line, this reporter only reports: chaining again could recurse.
    let chain = dir
        .as_deref()
        .filter(|_| std::env::var_os(CHAINED_ENV).is_none())
        .and_then(|dir| saved_chain(dir, None))
        .and_then(|v| v.get("command").and_then(Value::as_str).map(String::from));
    // A chained line that fails or prints nothing leaves Patchbay's own line in its place.
    if chain.is_some_and(|command| chained_output(&command, &bytes).unwrap_or(false)) {
        return;
    }
    let mut parts = Vec::new();
    if let Some(mut usage) = usage {
        usage.expire(crate::pty::now_ms());
        for (name, w) in [("5h", usage.five_hour), ("7d", usage.weekly)] {
            if let Some(w) = w {
                parts.push(format!("{name} {:.0}%", w.used_percent));
            }
        }
    }
    let line = if parts.is_empty() {
        "Usage unavailable".to_string()
    } else {
        parts.join(" · ")
    };
    let _ = writeln!(std::io::stdout(), "{line}");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-usage-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn claude_parses_optional_windows_and_ignores_missing_limits() {
        let mut input = json!({"rate_limits": {
            "five_hour":{"used_percentage":23.5,"resets_at":100},
            "seven_day":{"used_percentage":41,"resets_at":200}
        }});
        let usage = claude_input(&input, 123).unwrap();
        assert_eq!(usage.five_hour.as_ref().unwrap().used_percent, 23.5);
        assert_eq!(usage.weekly.as_ref().unwrap().window_minutes, 10080);
        assert_eq!(usage.observed_ms, 123);
        input["rate_limits"]
            .as_object_mut()
            .unwrap()
            .remove("seven_day");
        assert!(claude_input(&input, 123).unwrap().weekly.is_none());
        assert!(claude_input(&json!({}), 123).is_none());
        input["rate_limits"]["five_hour"]["used_percentage"] = json!(101);
        assert_eq!(
            claude_input(&input, 123)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percent,
            100.0
        );
        input["rate_limits"]["five_hour"]["used_percentage"] = json!(-1);
        assert!(claude_input(&input, 123).unwrap().five_hour.is_none());
    }

    fn codex_event(percent: u32) -> Value {
        json!({"type":"event_msg", "timestamp":"2026-10-27T12:00:00.000Z", "payload":{
            "type":"token_count", "rate_limits":{"limit_id":"codex",
                "primary":{"used_percent":20,"window_minutes":10080,"resets_at":240},
                "secondary":{"used_percent":percent,"window_minutes":300,"resets_at":120}
            }
        }})
    }

    #[test]
    fn codex_uses_last_populated_codex_event_and_maps_windows_by_minutes() {
        let mut premium = codex_event(99);
        premium["payload"]["rate_limits"] =
            json!({"limit_id":"premium", "primary":null,"secondary":null});
        let null_codex = json!({"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":null,"secondary":null}}});
        let tail = format!(
            "partial\n{}\n{}\n{}\n{}\n{{",
            codex_event(10),
            codex_event(26),
            premium,
            null_codex
        );
        let usage = codex_tail(tail.as_bytes(), 1).unwrap();
        assert_eq!(usage.five_hour.unwrap().used_percent, 26.0);
        assert_eq!(usage.weekly.unwrap().used_percent, 20.0);
        assert_eq!(usage.observed_ms, 1793102400000);
        assert!(codex_tail(premium.to_string().as_bytes(), 1).is_none());
    }

    #[test]
    fn codex_tolerates_missing_limit_id_relative_resets_and_nearby_durations() {
        let event = json!({"type":"event_msg", "timestamp":"2026-10-27T12:00:00.000Z", "payload":{
            "type":"token_count", "rate_limits":{
                "primary":{"used_percent":130,"window_minutes":299,"resets_in_seconds":60},
                "secondary":{"used_percent":20,"window_minutes":10079,"resets_at":240}
            }
        }});
        let usage = codex_tail(event.to_string().as_bytes(), 1).unwrap();
        let five_hour = usage.five_hour.unwrap();
        assert_eq!(five_hour.used_percent, 100.0);
        assert_eq!(five_hour.window_minutes, 299);
        assert_eq!(five_hour.resets_at_ms, 1_793_102_400_000 + 60_000);
        assert_eq!(usage.weekly.unwrap().resets_at_ms, 240_000);
    }

    #[test]
    fn codex_walk_selects_recently_modified_logs_even_from_older_days() {
        let fixture = Fixture::new();
        let at = |secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        let write = |rel: &str, secs: u64| {
            let path = fixture.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(at(secs))
                .unwrap();
        };
        for i in 0..CODEX_FILES as u64 {
            write(&format!("2026/10/27/new-{i}.jsonl"), 1000 + i);
        }
        // Long-running sessions in older days must compete by mtime, not start date.
        write("2026/10/26/old.jsonl", 5000);
        write("2025/12/31/older.jsonl", 6000);
        write("flat.jsonl", 7000);
        write("2026/10/27/notes.txt", 8000);
        let names: Vec<String> = session_files(&fixture.0)
            .into_iter()
            .map(|(_, p)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), CODEX_FILES);
        assert_eq!(names[0], "flat.jsonl");
        assert_eq!(&names[1..3], &["older.jsonl", "old.jsonl"]);
        assert!(names[3..].iter().all(|n| n.starts_with("new-")));
    }

    #[test]
    fn patchbay_reporters_are_recognised_from_any_state_directory() {
        assert!(is_reporter(
            "'/Users/me/.patchbay-dev/reporters/patchbay-status-v1' status-line"
        ));
        assert!(is_reporter(
            r#""C:\Users\me\.patchbay\reporters\patchbay-status-v1.exe" status-line"#
        ));
        assert!(is_reporter(
            r#""C:/Users/me/.patchbay/reporters/patchbay-status-v1.exe" status-line "C:/u""#
        ));
        assert!(is_reporter("patchbay-sessiond status-line '/state/usage'"));
        assert!(!is_reporter("~/.claude/statusline.sh"));
        assert!(!is_reporter("patchbay-status-v1 report-status claude"));
        // Only the installed executables count, never a user script with a similar name.
        assert!(!is_reporter("~/bin/patchbay-status-line.sh"));
        assert!(!is_reporter("~/bin/patchbay-status-v1.sh status-line"));
        assert!(!is_reporter("/opt/my-patchbay-sessiond status-line"));
    }

    #[test]
    fn legacy_installs_stay_owned_and_reinstall_names_the_usage_folder() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        let helper = fixture.0.join("helper");
        let reporter = fixture.0.join("reporter");
        std::fs::write(&helper, b"helper").unwrap();
        let legacy = status_command(&reporter, None).unwrap();
        std::fs::write(
            &source,
            serde_json::to_vec(&json!({ "statusLine": legacy })).unwrap(),
        )
        .unwrap();
        assert!(
            inspect_at(&source, &reporter, &fixture.0)
                .unwrap()
                .installed
        );
        configure_at(&source, &helper, &reporter, &fixture.0, true).unwrap();
        assert_eq!(
            agent_hooks::read_json(&source, Adapter::Claude).unwrap()["statusLine"],
            status_command(&reporter, Some(&fixture.0)).unwrap()
        );
    }

    #[test]
    fn the_reporter_finds_its_chain_whatever_settings_path_it_sees() {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.0.join("statusline-chain.json"),
            serde_json::to_vec(&json!({"source":"/installed/settings.json", "present":true,
                "statusLine":{"type":"command","command":"cat"}}))
            .unwrap(),
        )
        .unwrap();
        assert!(saved_chain(&fixture.0, Some(Path::new("/other/settings.json"))).is_none());
        assert_eq!(saved_chain(&fixture.0, None).unwrap()["command"], "cat");
    }

    #[test]
    fn relative_resets_round_to_the_same_minute_across_events() {
        let at = |timestamp: &str, seconds: u64| {
            let event = json!({"type":"event_msg", "timestamp":timestamp, "payload":{
                "type":"token_count", "rate_limits":{
                    "primary":{"used_percent":10,"window_minutes":300,"resets_in_seconds":seconds}
                }
            }});
            codex_tail(event.to_string().as_bytes(), 1)
                .unwrap()
                .five_hour
                .unwrap()
                .resets_at_ms
        };
        let first = at("2026-10-27T12:00:00.000Z", 3600);
        assert_eq!(first % 60_000, 0);
        assert_eq!(at("2026-10-27T12:00:07.300Z", 3593), first);
    }

    #[test]
    fn codex_tails_are_cached_until_the_file_changes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("2026/10/27/a.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let write = |percent: u32| {
            std::fs::write(&path, format!("{}\n", codex_event(percent))).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1000))
                .unwrap();
        };
        let percent = || {
            read_codex(&fixture.0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percent
        };
        write(26);
        assert_eq!(percent(), 26.0);
        // Same length and mtime: the cached parse stands.
        write(27);
        assert_eq!(percent(), 26.0);
        write(5);
        assert_eq!(percent(), 5.0);
    }

    #[test]
    fn install_never_chains_another_patchbay_reporter() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        let helper = fixture.0.join("helper");
        std::fs::write(&helper, b"helper").unwrap();
        let other = json!({"statusLine":{"type":"command",
            "command":"'/elsewhere/reporters/patchbay-status-v1' status-line"}});
        std::fs::write(&source, serde_json::to_vec(&other).unwrap()).unwrap();
        let reporter = fixture.0.join("reporter");
        assert!(
            inspect_at(&source, &reporter, &fixture.0)
                .unwrap()
                .chained
                .is_none()
        );
        let installed = configure_at(&source, &helper, &reporter, &fixture.0, true).unwrap();
        assert!(installed.installed);
        assert!(installed.chained.is_none());
        assert!(saved_chain(&fixture.0, Some(&source)).is_none());
    }

    #[test]
    fn expired_windows_are_dropped_at_the_reset_boundary() {
        let mut usage = codex_tail(codex_event(26).to_string().as_bytes(), 1).unwrap();
        usage.expire(120_000);
        assert!(usage.five_hour.is_none());
        assert!(usage.weekly.is_some());
        usage.expire(240_000);
        assert!(usage.weekly.is_none());
    }

    #[test]
    fn idle_captures_cannot_lower_usage_in_the_same_window() {
        let fixture = Fixture::new();
        let input = |five, weekly, reset| {
            json!({"rate_limits": {
                "five_hour":{"used_percentage":five,"resets_at":reset},
                "seven_day":{"used_percentage":weekly,"resets_at":600}
            }})
        };
        save_capture(&fixture.0, &input(96, 40, 300), 10).unwrap();
        let merged = save_capture(&fixture.0, &input(50, 85, 300), 20)
            .unwrap()
            .unwrap();
        assert_eq!(merged.five_hour.unwrap().used_percent, 96.0);
        assert_eq!(merged.weekly.unwrap().used_percent, 85.0);
        let saved: ProviderUsage =
            serde_json::from_slice(&std::fs::read(fixture.0.join("claude.json")).unwrap()).unwrap();
        assert_eq!(saved.five_hour.unwrap().used_percent, 96.0);
        // A new reset permits a lower reading. A subsequent stale redraw cannot revert it.
        save_capture(&fixture.0, &input(5, 85, 900), 300_000).unwrap();
        let stale = save_capture(&fixture.0, &input(96, 85, 300), 300_001)
            .unwrap()
            .unwrap();
        let window = stale.five_hour.unwrap();
        assert_eq!(window.used_percent, 5.0);
        assert_eq!(window.resets_at_ms, 900_000);
    }

    #[test]
    fn codex_reads_an_active_session_started_before_eight_newer_sessions() {
        let fixture = Fixture::new();
        let write = |rel: &str, percent, timestamp: &str| {
            let path = fixture.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut event = codex_event(percent);
            event["timestamp"] = json!(timestamp);
            std::fs::write(&path, event.to_string()).unwrap();
            let timestamp_ms = chrono::DateTime::parse_from_rfc3339(timestamp)
                .unwrap()
                .timestamp_millis();
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(
                    std::time::UNIX_EPOCH
                        + std::time::Duration::from_millis(u64::try_from(timestamp_ms).unwrap()),
                )
                .unwrap();
        };
        for i in 0..CODEX_FILES {
            write(
                &format!("2026/10/27/new-{i}.jsonl"),
                50,
                "2026-10-27T12:00:00Z",
            );
        }
        write("2026/10/20/active.jsonl", 96, "2026-10-27T12:01:00Z");
        assert_eq!(
            read_codex(&fixture.0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percent,
            96.0
        );
    }

    #[test]
    fn ownership_recognizes_earlier_double_quoted_commands() {
        let reporter = Path::new("/tools/$cash/patchbay-status-v1");
        let dir = Path::new("/state/$cash/usage");
        for suffix in [String::new(), format!(" \"{}\"", dir.display())] {
            let value = json!({"type":"command", "command":
                format!("\"{}\" status-line{suffix}", reporter.display())});
            assert!(owned(Some(&value), reporter, dir));
        }
    }

    #[test]
    fn status_command_quotes_shell_metacharacters_literally() {
        let reporter = Path::new("/tools/$cash `echo bad`/it's/patchbay-status-v1");
        let dir = Path::new("/state/$HOME/it's usage");
        let command = status_command(reporter, Some(dir)).unwrap();
        assert_eq!(
            crate::context::sh_words(command["command"].as_str().unwrap()).unwrap(),
            [
                reporter.to_str().unwrap(),
                "status-line",
                dir.to_str().unwrap()
            ]
        );
    }

    #[test]
    fn installs_transfer_the_original_status_line_between_state_folders() {
        for legacy in [false, true] {
            let fixture = Fixture::new();
            let source = fixture.0.join("settings.json");
            let helper = fixture.0.join("helper");
            let first_dir = fixture.0.join("first/usage");
            let first = fixture.0.join("first/reporters/patchbay-status-v1");
            let second_dir = fixture.0.join("second/usage");
            let second = fixture.0.join("second/reporters/patchbay-status-v1");
            std::fs::write(&helper, b"helper").unwrap();
            let original = json!({"theme":"dark", "statusLine": {
                "type":"command", "command":"cat", "padding":2
            }});
            std::fs::write(&source, serde_json::to_vec(&original).unwrap()).unwrap();
            configure_at(&source, &helper, &first, &first_dir, true).unwrap();
            if legacy {
                std::fs::write(
                    &source,
                    serde_json::to_vec(&json!({
                        "theme":"dark", "statusLine":status_command(&first, None).unwrap()
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            let installed = configure_at(&source, &helper, &second, &second_dir, true).unwrap();
            assert_eq!(installed.chained.as_deref(), Some("cat"));
            // Removing the previous install must leave the new capture intact.
            configure_at(&source, &helper, &first, &first_dir, false).unwrap();
            assert!(inspect_at(&source, &second, &second_dir).unwrap().installed);
            // Moving back also preserves the user's full original object.
            configure_at(&source, &helper, &first, &first_dir, true).unwrap();
            configure_at(&source, &helper, &first, &first_dir, false).unwrap();
            assert_eq!(
                agent_hooks::read_json(&source, Adapter::Claude).unwrap(),
                original
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn capture_removed_through_settings_alias_restores_the_original_line() {
        use std::os::unix::fs::symlink;
        for file_alias in [false, true] {
            let fixture = Fixture::new();
            let actual = fixture.0.join("actual");
            std::fs::create_dir_all(&actual).unwrap();
            let source = actual.join("settings.json");
            let alias = if file_alias {
                let alias = fixture.0.join("settings-alias.json");
                symlink(&source, &alias).unwrap();
                alias
            } else {
                let alias = fixture.0.join("alias");
                symlink(&actual, &alias).unwrap();
                alias.join("settings.json")
            };
            let helper = fixture.0.join("helper");
            let reporter = fixture.0.join("reporter");
            let dir = fixture.0.join("usage");
            std::fs::write(&helper, b"helper").unwrap();
            let original = json!({"statusLine":{"type":"command", "command":"cat"}});
            std::fs::write(&source, serde_json::to_vec(&original).unwrap()).unwrap();
            // Exercise a backup made before source paths were canonicalized.
            configure_at(&alias, &helper, &reporter, &dir, true).unwrap();
            let mut saved: Value =
                serde_json::from_slice(&std::fs::read(dir.join("statusline-chain.json")).unwrap())
                    .unwrap();
            saved["source"] = json!(alias);
            std::fs::write(
                dir.join("statusline-chain.json"),
                serde_json::to_vec(&saved).unwrap(),
            )
            .unwrap();
            assert_eq!(
                inspect_at(&source, &reporter, &dir)
                    .unwrap()
                    .chained
                    .as_deref(),
                Some("cat")
            );
            configure_at(&source, &helper, &reporter, &dir, false).unwrap();
            assert_eq!(
                agent_hooks::read_json(&source, Adapter::Claude).unwrap(),
                original
            );
            configure_at(&source, &helper, &reporter, &dir, true).unwrap();
            configure_at(&alias, &helper, &reporter, &dir, false).unwrap();
            assert_eq!(
                agent_hooks::read_json(&source, Adapter::Claude).unwrap(),
                original
            );
            assert_eq!(
                agent_hooks::read_json(&alias, Adapter::Claude).unwrap(),
                original
            );
        }
    }

    #[test]
    fn capture_skips_recent_unchanged_values_and_absent_limits() {
        let fixture = Fixture::new();
        let saved = || -> ProviderUsage {
            serde_json::from_slice(&std::fs::read(fixture.0.join("claude.json")).unwrap()).unwrap()
        };
        let input = json!({"rate_limits":{"five_hour":{"used_percentage":23,"resets_at":100}}});
        save_capture(&fixture.0, &input, 10).unwrap();
        save_capture(&fixture.0, &input, 20).unwrap();
        save_capture(&fixture.0, &json!({}), 30).unwrap();
        assert_eq!(saved().observed_ms, 10);
        // Unchanged values still refresh the snapshot's age once it is old enough.
        save_capture(&fixture.0, &input, 10 + OBSERVED_REFRESH_MS).unwrap();
        assert_eq!(saved().observed_ms, 10 + OBSERVED_REFRESH_MS);
        let updated = json!({"rate_limits":{"seven_day":{"used_percentage":41,"resets_at":200}}});
        save_capture(&fixture.0, &updated, OBSERVED_REFRESH_MS + 40).unwrap();
        assert!(saved().five_hour.is_none());
        assert_eq!(saved().observed_ms, OBSERVED_REFRESH_MS + 40);
    }

    #[test]
    fn install_and_uninstall_preserve_settings_and_existing_status_line() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        let reporter = fixture.0.join("reporter");
        let helper = fixture.0.join("helper");
        let usage = fixture.0.join("usage");
        std::fs::write(&helper, b"helper").unwrap();
        for original in [
            json!({"theme":"dark","hooks":{}}),
            json!({"theme":"dark","statusLine":null}),
            json!({"theme":"dark","statusLine":{"type":"command","command":"cat", "padding":2}}),
        ] {
            std::fs::write(&source, serde_json::to_vec(&original).unwrap()).unwrap();
            for _ in 0..2 {
                let installed = configure_at(&source, &helper, &reporter, &usage, true).unwrap();
                assert!(installed.installed);
                assert_eq!(
                    installed.chained.as_deref(),
                    original
                        .get("statusLine")
                        .and_then(|v| v.get("command"))
                        .and_then(Value::as_str)
                );
                assert_eq!(
                    agent_hooks::read_json(&source, Adapter::Claude).unwrap()["theme"],
                    "dark"
                );
            }
            for _ in 0..2 {
                assert!(
                    !configure_at(&source, &helper, &reporter, &usage, false)
                        .unwrap()
                        .installed
                );
                assert_eq!(
                    agent_hooks::read_json(&source, Adapter::Claude).unwrap(),
                    original
                );
            }
        }
    }

    #[test]
    fn uninstall_never_overwrites_a_user_changed_status_line() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        let helper = fixture.0.join("helper");
        let reporter = fixture.0.join("reporter");
        std::fs::write(&helper, b"helper").unwrap();
        configure_at(&source, &helper, &reporter, &fixture.0, true).unwrap();
        let changed = json!({"statusLine":{"type":"command","command":"echo new"},"theme":"light"});
        std::fs::write(&source, serde_json::to_vec(&changed).unwrap()).unwrap();
        configure_at(&source, &helper, &reporter, &fixture.0, false).unwrap();
        assert_eq!(
            agent_hooks::read_json(&source, Adapter::Claude).unwrap(),
            changed
        );
    }

    #[test]
    fn malformed_settings_are_never_replaced() {
        let fixture = Fixture::new();
        let source = fixture.0.join("settings.json");
        std::fs::write(&source, b"broken").unwrap();
        assert!(
            configure_at(
                &source,
                &source,
                &fixture.0.join("reporter"),
                &fixture.0,
                true
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(source).unwrap(), "broken");
    }
}
