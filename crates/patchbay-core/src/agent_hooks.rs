//! Opt-in provider hook configuration and a silent, portable native reporter.
//! Reporting is passive: no provider decisions, stdout, or trust bypasses.
use crate::adapters::Adapter;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const SESSION_ENV: &str = "PATCHBAY_REPORT_SESSION";
pub const GENERATION_ENV: &str = "PATCHBAY_REPORT_GENERATION";
pub const PROVIDER_ENV: &str = "PATCHBAY_REPORT_PROVIDER";
pub const JOURNAL_ENV: &str = "PATCHBAY_REPORT_DIR";
const MARKER: &str = "Patchbay status v1";
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "SessionEnd",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub session: String,
    pub generation: u64,
    pub provider: Adapter,
    pub sequence: u64,
    pub at_ms: u64,
    pub event: String,
    pub conversation: String,
    pub turn: Option<String>,
    pub prompt: Option<String>,
    pub message: Option<String>,
    /// Why a session started (`startup`, `resume`, `clear`, `compact`).
    #[serde(default)]
    pub source: Option<String>,
}

/// Isolate and bound provider payloads. Ignore subagents and unrelated notifications.
fn normalize(provider: Adapter, input: &Value) -> Option<HookEvent> {
    let event = input.get("hook_event_name")?.as_str()?;
    if input
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return None;
    }
    let supported = EVENTS.contains(&event)
        || (provider == Adapter::Codex && event == "Interrupt")
        || (provider == Adapter::Claude
            && matches!(event, "Notification" | "StopFailure" | "PostToolUseFailure"));
    if !supported {
        return None;
    }
    if event == "Notification"
        && input.get("notification_type").and_then(Value::as_str) != Some("permission_prompt")
    {
        return None;
    }
    let conversation = input.get("session_id")?.as_str()?;
    if !crate::adapters::valid_id(conversation) {
        return None;
    }
    let field = |name: &str| {
        input
            .get(name)
            .and_then(Value::as_str)
            .map(|s| s.chars().take(200).collect())
    };
    let turn = input
        .get("turn_id")
        .or_else(|| input.get("prompt_id"))
        .and_then(Value::as_str)
        .filter(|id| crate::adapters::valid_id(id))
        .map(str::to_string);
    // Older providers without turn identity retain Active/Quiet fallback.
    if !matches!(event, "SessionStart" | "SessionEnd" | "UserPromptSubmit") && turn.is_none() {
        return None;
    }
    Some(HookEvent {
        session: String::new(),
        generation: 0,
        provider,
        sequence: 0,
        at_ms: crate::pty::now_ms(),
        event: event.into(),
        conversation: conversation.into(),
        turn,
        prompt: field("prompt"),
        source: field("source"),
        message: field("message").or_else(|| {
            input
                .get("tool_input")
                .and_then(|v| v.get("description"))
                .and_then(Value::as_str)
                .map(|s| s.chars().take(200).collect())
        }),
    })
}

/// Called by packaged sessiond before daemon initialization. Always silent and fail-open.
pub fn reporter(provider: &str) {
    let _ = (|| -> Result<()> {
        let provider = match provider {
            "claude" => Adapter::Claude,
            "codex" => Adapter::Codex,
            _ => return Ok(()),
        };
        if std::env::var(PROVIDER_ENV).ok().as_deref() != Some(provider_name(provider)) {
            return Ok(());
        }
        let Some(session) = std::env::var(SESSION_ENV).ok().filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        let Some(generation) = std::env::var(GENERATION_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
        else {
            return Ok(());
        };
        let Some(dir) = std::env::var_os(JOURNAL_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        else {
            return Ok(());
        };
        let meta = std::fs::symlink_metadata(&dir)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Ok(());
        }
        let invoked_ms = crate::pty::now_ms();
        // Do not create a journal: only a running Patchbay process supplies it.
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            return Ok(());
        }
        let input: Value = serde_json::from_slice(&bytes)?;
        let Some(mut event) = normalize(provider, &input) else {
            return Ok(());
        };
        event.at_ms = invoked_ms;
        event.session = session;
        event.generation = generation;
        // Serialize commits so the monitor can consume prompt/progress/completion in order.
        let lock = crate::workspace::lock(&dir.join("report.lock"))?;
        let mut locked = false;
        for _ in 0..100 {
            if lock.try_lock().is_ok() {
                locked = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if !locked {
            return Ok(());
        }
        let counter = dir.join("sequence");
        let previous = std::fs::read_to_string(&counter)
            .unwrap_or_default()
            .parse::<u64>()
            .unwrap_or(0);
        event.sequence = previous
            .checked_add(1)
            .context("Reporter sequence exhausted")?;
        atomic_replace(&counter, event.sequence.to_string().as_bytes(), false)?;
        atomic_replace(
            &dir.join(format!("{:020}.json", event.sequence)),
            &serde_json::to_vec(&event)?,
            false,
        )?;
        Ok(())
    })();
}

/// Read committed events, ordered and consumed once. Called under the tracker lock.
pub(crate) fn drain(dir: &Path) -> Vec<HookEvent> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|s| s == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .take(256)
        .filter_map(|path| {
            let event = std::fs::read(&path)
                .ok()
                .filter(|b| b.len() <= 16 * 1024)
                .and_then(|b| serde_json::from_slice(&b).ok());
            let _ = std::fs::remove_file(path);
            event
        })
        .collect()
}

fn provider_name(provider: Adapter) -> &'static str {
    match provider {
        Adapter::Claude => "claude",
        Adapter::Codex => "codex",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub provider: Adapter,
    pub source: String,
    pub reporter: String,
    pub installed: bool,
    pub disabled: bool,
    pub reporter_available: bool,
    pub reporting_sessions: usize,
    pub guidance: Vec<String>,
}

/// Effective inherited user directory, including provider overrides.
///
/// # Errors
/// Fails for relative override directories or missing home.
pub fn user_source(provider: Adapter) -> Result<PathBuf> {
    let home = dirs::home_dir().context("No home directory")?;
    let (variable, default, file) = match provider {
        Adapter::Claude => ("CLAUDE_CONFIG_DIR", ".claude", "settings.json"),
        Adapter::Codex => ("CODEX_HOME", ".codex", "hooks.json"),
    };
    let dir = std::env::var_os(variable).map_or_else(|| home.join(default), PathBuf::from);
    anyhow::ensure!(dir.is_absolute(), "{variable} must be absolute");
    if provider == Adapter::Codex {
        let path = dir.join("config.toml");
        let text = read_optional(&path)?;
        if !text.is_empty() {
            let doc = text
                .parse::<toml_edit::DocumentMut>()
                .context("Malformed Codex config.toml; no changes made")?;
            if doc.contains_key("hooks") {
                return Ok(path);
            }
        }
    }
    Ok(dir.join(file))
}

fn stable_reporter() -> Result<PathBuf> {
    Ok(crate::workspace::home()?
        .join("reporters")
        .join(if cfg!(windows) {
            "patchbay-status-v1.exe"
        } else {
            "patchbay-status-v1"
        }))
}

fn read_optional(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}
fn read_json(path: &Path) -> Result<Value> {
    let text = read_optional(path)?;
    let value = if text.is_empty() {
        anyhow::ensure!(
            !path.exists(),
            "Empty provider JSON configuration is malformed; no changes made"
        );
        json!({})
    } else {
        serde_json::from_str(&text).context("Malformed provider configuration; no changes made")?
    };
    validate_shape(&value)?;
    Ok(value)
}
fn validate_shape(value: &Value) -> Result<()> {
    anyhow::ensure!(
        value.is_object(),
        "Provider configuration must be an object"
    );
    if let Some(hooks) = value.get("hooks") {
        let hooks = hooks
            .as_object()
            .context("Malformed hooks: expected object")?;
        for (name, groups) in hooks {
            if matches!(name.as_str(), "managed_dir" | "windows_managed_dir") {
                anyhow::ensure!(groups.is_string(), "Malformed managed hook directory");
                continue;
            }
            for group in groups
                .as_array()
                .context("Malformed hooks: expected matcher array")?
            {
                anyhow::ensure!(group.is_object(), "Malformed hook matcher");
                let handlers = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .context("Malformed hook handlers")?;
                anyhow::ensure!(
                    handlers.iter().all(Value::is_object),
                    "Malformed hook handler"
                );
            }
        }
    }
    Ok(())
}
fn owned(handler_value: &Value, provider: Adapter, reporter: &Path) -> bool {
    let Ok(expected) = handler(provider, reporter) else {
        return false;
    };
    ["type", "command", "args", "statusMessage"]
        .iter()
        .all(|key| handler_value.get(key) == expected.get(key))
}
fn handler(provider: Adapter, reporter: &Path) -> Result<Value> {
    let path = reporter.to_str().context("Reporter path must be UTF-8")?;
    Ok(match provider {
        Adapter::Claude => {
            json!({"type":"command", "command": path, "args":["report-status", "claude"], "timeout": 3, "statusMessage":MARKER})
        }
        Adapter::Codex => {
            // Codex command hooks use a shell. Windows launches through PowerShell explicitly.
            let command = if cfg!(windows) {
                let quoted = format!("& '{}' report-status codex", path.replace('\'', "''"));
                use base64::Engine;
                let bytes: Vec<_> = quoted.encode_utf16().flat_map(u16::to_le_bytes).collect();
                format!(
                    "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            } else {
                format!("'{}' report-status codex", path.replace('\'', "'\\''"))
            };
            json!({"type":"command", "command":command, "timeout":3, "statusMessage":MARKER})
        }
    })
}

fn events(provider: Adapter) -> Vec<&'static str> {
    let mut events = EVENTS.to_vec();
    match provider {
        Adapter::Claude => events.extend(["Notification", "StopFailure", "PostToolUseFailure"]),
        Adapter::Codex => events.push("Interrupt"),
    }
    events
}
fn json_update(
    mut value: Value,
    provider: Adapter,
    reporter: &Path,
    install: bool,
) -> Result<Value> {
    validate_shape(&value)?;
    if value.get("hooks").is_none() && !install {
        return Ok(value);
    }
    let hooks = value
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap();
    for groups in hooks.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        groups.retain_mut(|group| {
            let handlers = group["hooks"].as_array_mut().unwrap();
            let before = handlers.len();
            handlers.retain(|h| !owned(h, provider, reporter));
            !handlers.is_empty() || before == 0
        });
    }
    if install {
        for event in events(provider) {
            hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(json!({"hooks":[handler(provider, reporter)?]}));
        }
    }
    Ok(value)
}

// Preserve unrelated TOML text verbatim. Only event tables affected by installation
// or an exactly owned handler are rewritten; inline arrays are supported too.
fn toml_update(text: &str, provider: Adapter, reporter: &Path, install: bool) -> Result<String> {
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .context("Malformed Codex TOML; no changes made")?;
    let raw: toml::Value = toml::from_str(text)?;
    let value = serde_json::to_value(raw)?;
    validate_shape(&value)?;
    let updated = json_update(value.clone(), provider, reporter, install)?;
    let Some(updated_hooks) = updated.get("hooks").and_then(Value::as_object) else {
        return Ok(doc.to_string());
    };
    // Convert an inline hooks root only when it needs modification.
    if !doc.get("hooks").is_some_and(toml_edit::Item::is_table) {
        if !install && value.get("hooks") == updated.get("hooks") {
            return Ok(doc.to_string());
        }
        let toml_value: toml::Value = serde_json::from_value(json!({"hooks":updated_hooks}))?;
        let generated = toml::to_string(&toml_value)?.parse::<toml_edit::DocumentMut>()?;
        doc["hooks"] = generated["hooks"].clone();
        return Ok(doc.to_string());
    }
    for (event, groups) in updated_hooks {
        if value.get("hooks").and_then(|h| h.get(event)) == Some(groups) {
            continue;
        }
        let toml_value: toml::Value = serde_json::from_value(json!({"hooks":{event:groups}}))?;
        let generated = toml::to_string(&toml_value)?.parse::<toml_edit::DocumentMut>()?;
        doc["hooks"][event] = generated["hooks"][event].clone();
    }
    Ok(doc.to_string())
}

/// Check configuration only. Installed does not imply trusted or reporting.
///
/// # Errors
/// Fails for malformed or inaccessible effective user configuration.
pub fn inspect(provider: Adapter, source_override: Option<&Path>) -> Result<Integration> {
    let path = source_override.map_or_else(|| user_source(provider), |p| Ok(p.to_owned()))?;
    anyhow::ensure!(path.is_absolute(), "Hook source must be absolute");
    let value = if path.extension().is_some_and(|e| e == "toml") {
        serde_json::to_value(toml::from_str::<toml::Value>(&read_optional(&path)?)?)?
    } else {
        read_json(&path)?
    };
    validate_shape(&value)?;
    let installed = events(provider).iter().all(|event| {
        value
            .get("hooks")
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().any(|g| {
                    g.get("hooks").and_then(Value::as_array).is_some_and(|hs| {
                        hs.iter()
                            .any(|h| owned(h, provider, &stable_reporter().unwrap_or_default()))
                    })
                })
            })
    });
    let mut disabled = value.get("disableAllHooks").and_then(Value::as_bool) == Some(true);
    if provider == Adapter::Codex {
        let config = if path.extension().is_some_and(|e| e == "toml") {
            read_optional(&path)?
        } else {
            read_optional(&path.with_file_name("config.toml"))?
        };
        let config: toml::Value =
            toml::from_str(&config).context("Malformed Codex user config; no changes made")?;
        let features = config.get("features");
        disabled |= features
            .and_then(|f| f.get("hooks"))
            .or_else(|| features.and_then(|f| f.get("codex_hooks")))
            .and_then(toml::Value::as_bool)
            == Some(false);
    }
    let mut guidance = vec!["Configuration inspection cannot establish active provider trust or effective project/managed policy. Start a Patchbay agent session to confirm reporting.".into()];
    if provider == Adapter::Codex {
        guidance.push("In Codex run /hooks to review and trust the Patchbay definitions. Disabled hooks and managed-only policy remain respected; Patchbay never bypasses trust.".into());
    }
    if provider == Adapter::Claude {
        guidance.push("Claude user hooks require the user settings source to remain enabled. Existing --settings, --setting-sources, project settings and managed policy can disable them; Patchbay preserves these options.".into());
    }
    if disabled {
        guidance.push(
            "Hooks are disabled in this source. Installation will preserve that setting.".into(),
        );
    }
    Ok(Integration {
        provider,
        source: path.display().to_string(),
        reporter: stable_reporter()?.display().to_string(),
        installed,
        disabled,
        reporter_available: stable_reporter()?.is_file(),
        reporting_sessions: 0,
        guidance,
    })
}

/// Append or remove only Patchbay-owned handlers. Writes atomically under a local edit lock.
///
/// # Errors
/// Fails for malformed config, changed config,
/// symlinks, missing packaged helper, or filesystem errors. No trust changes.
pub fn configure(
    provider: Adapter,
    source_override: Option<&Path>,
    helper: &Path,
    install: bool,
) -> Result<Integration> {
    let source = source_override.map_or_else(|| user_source(provider), |p| Ok(p.to_owned()))?;
    anyhow::ensure!(source.is_absolute(), "Hook source must be absolute");
    let state = crate::workspace::home()?.join("reporters");
    crate::workspace::private_dir(&state)?;
    let lock = crate::workspace::lock(&state.join("setup.lock"))?;
    lock.lock()?;
    inspect(provider, Some(&source))?;
    let before = read_optional(&source)?;
    let reporter = stable_reporter()?;
    let bytes = if source.extension().is_some_and(|s| s == "toml") {
        toml_update(&before, provider, &reporter, install)?.into_bytes()
    } else {
        let value = read_json(&source)?;
        serde_json::to_vec_pretty(&json_update(value, provider, &reporter, install)?)?
    };
    // Validate configuration before deploying the helper or changing its source.
    if install {
        anyhow::ensure!(
            helper.is_file(),
            "Packaged status reporter is missing. Reinstall or rebuild Patchbay."
        );
        atomic_replace(&reporter, &std::fs::read(helper)?, true)?;
    }
    anyhow::ensure!(
        read_optional(&source)? == before,
        "Provider configuration changed during setup; check integration and retry"
    );
    if install || !before.is_empty() {
        atomic_replace(&source, &bytes, false)?;
    }
    inspect(provider, Some(&source))
}

/// Atomic replacement without changing provider directory permissions.
fn atomic_replace(path: &Path, bytes: &[u8], executable: bool) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        anyhow::ensure!(
            !meta.file_type().is_symlink() && meta.is_file(),
            "Refusing to replace symlink/non-file {}",
            path.display()
        );
    }
    let parent = path.parent().context("Missing source parent")?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".patchbay-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if executable { 0o700 } else { 0o600 });
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        if let Ok(meta) = std::fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-hooks-{}", uuid::Uuid::new_v4()));
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
    fn install_remove_preserve_user_settings_and_hooks_and_are_idempotent() {
        let reporter = Path::new("/some folder/a'punctuation/$literal/patchbay-status-v1");
        let original = json!({
            "model":"user-model", "disableAllHooks":true,
            "hooks":{"Stop":[{"matcher":".*","hooks":[{"type":"command","command":"user-validation"}]}],
                "Notification":[{"hooks":[]}]}
        });
        let installed = json_update(original.clone(), Adapter::Claude, reporter, true).unwrap();
        assert_eq!(installed["disableAllHooks"], true);
        assert_eq!(installed["hooks"]["Stop"][0], original["hooks"]["Stop"][0]);
        assert_eq!(
            installed,
            json_update(installed.clone(), Adapter::Claude, reporter, true).unwrap()
        );
        let removed = json_update(installed, Adapter::Claude, reporter, false).unwrap();
        assert_eq!(removed["model"], original["model"]);
        assert_eq!(removed["hooks"]["Stop"], original["hooks"]["Stop"]);
        assert_eq!(
            removed["hooks"]["Notification"],
            original["hooks"]["Notification"]
        );
        assert_eq!(
            removed,
            json_update(removed.clone(), Adapter::Claude, reporter, false).unwrap()
        );
    }
    #[test]
    fn ownership_requires_exact_command_and_arguments_and_keeps_edited_entries() {
        let reporter = Path::new("/tmp/patchbay-status-v1");
        let exact = handler(Adapter::Codex, reporter).unwrap();
        assert!(owned(&exact, Adapter::Codex, reporter));
        let mut lookalike = exact.clone();
        lookalike["command"] = json!("echo patchbay-status-v1 unrelated");
        assert!(!owned(&lookalike, Adapter::Codex, reporter));
        let mut changed = handler(Adapter::Claude, reporter).unwrap();
        changed["args"] = json!(["report-status", "claude", "user-option"]);
        assert!(!owned(&changed, Adapter::Claude, reporter));
        assert!(!owned(&exact, Adapter::Claude, reporter));
    }
    #[test]
    fn toml_preserves_unrelated_text_and_accepts_inline_arrays() {
        let reporter = Path::new("/tmp/patchbay-status-v1");
        for hooks in [
            "[hooks]\nStop = [{ hooks = [{ type = 'command', command = 'user-validation' }] }]\n",
            "[[hooks.Stop]]\nmatcher = '.*'\n[[hooks.Stop.hooks]]\ntype = 'command'\ncommand = 'user-validation'\n",
            "hooks = { Stop = [{ hooks = [{ type = 'command', command = 'user-validation' }] }] }\n",
        ] {
            let original = format!(
                "# user comment\nmodel = 'user-model'\n{hooks}\n[other]\n# keep this comment\noption = 'unchanged'\n"
            );
            let installed = toml_update(&original, Adapter::Codex, reporter, true).unwrap();
            assert!(installed.contains("# user comment\nmodel = 'user-model'"));
            assert!(installed.contains("# keep this comment\noption = 'unchanged'"));
            assert_eq!(
                installed,
                toml_update(&installed, Adapter::Codex, reporter, true).unwrap()
            );
            let removed = toml_update(&installed, Adapter::Codex, reporter, false).unwrap();
            let value: toml::Value = toml::from_str(&removed).unwrap();
            assert_eq!(
                value["hooks"]["Stop"][0]["hooks"][0]["command"].as_str(),
                Some("user-validation")
            );
            assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 1);
            assert!(removed.contains("# keep this comment\noption = 'unchanged'"));
        }
    }
    #[test]
    fn malformed_sources_return_errors_without_panics_or_writes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("settings.json");
        for text in [
            "{bad",
            "[]",
            "{\"hooks\":[]}",
            "{\"hooks\":{\"Stop\":true}}",
            "{\"hooks\":{\"Stop\":[{\"hooks\":null}]}}",
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(read_json(&path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
        for text in [
            "hooks = false",
            "[hooks]\nStop = false",
            "[hooks]\nStop = [{ hooks = 12 }]",
            "[hooks]\nStop = [{ hooks = ['wrong'] }]",
            "bad = {",
        ] {
            assert!(
                toml_update(
                    text,
                    Adapter::Codex,
                    Path::new("/tmp/patchbay-status-v1"),
                    true
                )
                .is_err()
            );
        }
    }
    #[test]
    fn normalizes_parent_turns_and_rejects_subagents_and_missing_identity() {
        let input = json!({"hook_event_name":"UserPromptSubmit", "session_id":"12345678-session", "turn_id":"12345678-turn", "prompt":"hello"});
        let event = normalize(Adapter::Codex, &input).unwrap();
        assert_eq!(event.turn.as_deref(), Some("12345678-turn"));
        let mut subagent = input.clone();
        subagent["agent_id"] = json!("child");
        assert!(normalize(Adapter::Codex, &subagent).is_none());
        subagent = input.clone();
        subagent["hook_event_name"] = json!("SubagentStop");
        assert!(normalize(Adapter::Codex, &subagent).is_none());
        let mut selected_agent = input.clone();
        selected_agent["agent_type"] = json!("custom-main-agent");
        assert!(normalize(Adapter::Claude, &selected_agent).is_some());
        let mut legacy = input.clone();
        legacy.as_object_mut().unwrap().remove("turn_id");
        assert!(normalize(Adapter::Codex, &legacy).unwrap().turn.is_none());
        legacy["prompt_id"] = json!("12345678-claude-prompt");
        assert!(normalize(Adapter::Claude, &legacy).is_some());
        legacy["hook_event_name"] = json!("Notification");
        legacy["notification_type"] = json!("idle_prompt");
        assert!(normalize(Adapter::Claude, &legacy).is_none());
    }
    #[test]
    fn atomic_replacement_preserves_permissions_and_cleans_temp_files() {
        let fixture = Fixture::new();
        let path = fixture.0.join("settings.json");
        std::fs::write(&path, "before").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        atomic_replace(&path, b"after", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"after");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
    #[test]
    fn codex_disabled_features_and_managed_directory_metadata_are_preserved() {
        let fixture = Fixture::new();
        let config = fixture.0.join("config.toml");
        let text = "[features]\nhooks = false\n[hooks]\nmanaged_dir = '/managed/hooks'\nwindows_managed_dir = 'C:\\managed'\n";
        std::fs::write(&config, text).unwrap();
        let changed = toml_update(
            text,
            Adapter::Codex,
            Path::new("/tmp/patchbay-status-v1"),
            true,
        )
        .unwrap();
        let value: toml::Value = toml::from_str(&changed).unwrap();
        assert_eq!(value["features"]["hooks"].as_bool(), Some(false));
        assert_eq!(
            value["hooks"]["managed_dir"].as_str(),
            Some("/managed/hooks")
        );
        assert!(inspect(Adapter::Codex, Some(&config)).unwrap().disabled);
        let hooks = fixture.0.join("hooks.json");
        std::fs::write(&hooks, "{}").unwrap();
        assert!(inspect(Adapter::Codex, Some(&hooks)).unwrap().disabled);
    }
}
