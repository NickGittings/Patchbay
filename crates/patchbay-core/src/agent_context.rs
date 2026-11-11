//! Best-effort context observations, separate from account usage and turn completion.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Compaction {
    #[default]
    Unknown,
    Idle,
    Compacting,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentContext {
    pub used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
    pub used_percent: Option<f64>,
    pub observed_ms: Option<u64>,
    pub compaction: Compaction,
    pub last_compaction_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub session: String,
    pub generation: u64,
    pub conversation: String,
    pub context: AgentContext,
}

fn percent(value: Option<f64>) -> Option<f64> {
    value.filter(|p| p.is_finite() && *p >= 0.0 && *p <= 100.0)
}

/// Claude's current usage includes cached input; output/session totals are not context size.
#[must_use]
pub fn claude(input: &Value, at: u64) -> Option<AgentContext> {
    let window = input.get("context_window")?;
    let current = window.get("current_usage");
    let used_tokens = current.and_then(|usage| {
        usage
            .get("input_tokens")?
            .as_u64()?
            .checked_add(usage.get("cache_creation_input_tokens")?.as_u64()?)?
            .checked_add(usage.get("cache_read_input_tokens")?.as_u64()?)
    });
    let window_tokens = window
        .get("context_window_size")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0);
    let used_percent =
        percent(window.get("used_percentage").and_then(Value::as_f64)).or_else(|| {
            percent(
                used_tokens
                    .zip(window_tokens)
                    .map(|(used, size)| used as f64 / size as f64 * 100.0),
            )
        });
    Some(AgentContext {
        used_tokens,
        window_tokens,
        used_percent,
        observed_ms: Some(at),
        ..Default::default()
    })
}

/// Called by the existing opt-in reporter, independently of rate-limit capture.
pub fn capture_claude(input: &Value, at: u64) {
    let capture = (|| -> Option<()> {
        let conversation = input.get("session_id")?.as_str()?;
        if !crate::adapters::valid_id(conversation) {
            return None;
        }
        let observation = Observation {
            session: std::env::var(crate::agent_hooks::SESSION_ENV).ok()?,
            generation: std::env::var(crate::agent_hooks::GENERATION_ENV)
                .ok()?
                .parse()
                .ok()?,
            conversation: conversation.into(),
            context: claude(input, at)?,
        };
        let dir = PathBuf::from(std::env::var_os(crate::agent_hooks::JOURNAL_ENV)?);
        let temp = dir.join(format!("context-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temp, serde_json::to_vec(&observation).ok()?).ok()?;
        let result = std::fs::rename(&temp, dir.join("context.observation"));
        let _ = std::fs::remove_file(temp);
        result.ok()
    })();
    let _ = capture;
}

pub fn read_claude(dir: &Path) -> Option<Observation> {
    let file = std::fs::File::open(dir.join("context.observation")).ok()?;
    let mut bytes = Vec::new();
    file.take(8192).read_to_end(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Captured Codex rollout event shapes: only last_token_usage is current context.
fn codex(value: &Value) -> Option<AgentContext> {
    let at = chrono::DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?)
        .ok()?
        .timestamp_millis()
        .try_into()
        .ok()?;
    let payload = value.get("payload")?;
    let compacted = value.get("type")?.as_str()? == "compacted"
        || (value.get("type")?.as_str()? == "event_msg"
            && payload.get("type")?.as_str()? == "context_compacted");
    if compacted {
        return Some(AgentContext {
            compaction: Compaction::Idle,
            last_compaction_ms: Some(at),
            observed_ms: Some(at),
            ..Default::default()
        });
    }
    if value.get("type")?.as_str()? != "event_msg"
        || payload.get("type")?.as_str()? != "token_count"
    {
        return None;
    }
    let info = payload.get("info")?;
    let used_tokens = info
        .get("last_token_usage")
        .and_then(|u| u.get("total_tokens"))
        .and_then(Value::as_u64);
    let window_tokens = info
        .get("model_context_window")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0);
    let used_percent = percent(
        used_tokens
            .zip(window_tokens)
            .map(|(used, size)| used as f64 / size as f64 * 100.0),
    );
    Some(AgentContext {
        used_tokens,
        window_tokens,
        used_percent,
        observed_ms: Some(at),
        ..Default::default()
    })
}

/// One exact conversation, bounded I/O per monitor tick, retaining incomplete JSONL writes.
#[derive(Default)]
pub struct CodexReader {
    root: Option<PathBuf>,
    resolving: Option<std::sync::mpsc::Receiver<Option<PathBuf>>>,
    conversation: String,
    file: Option<PathBuf>,
    discovery: Option<TranscriptDiscovery>,
    offset: u64,
    pending: Vec<u8>,
    verified: bool,
    discarding: bool,
    retry_ms: u64,
}
impl CodexReader {
    pub fn new(spec: &crate::pty::SessionSpec) -> Self {
        // Shell initialization must never delay launching the agent or the monitor.
        let is_codex = spec.env.get(crate::agent_hooks::PROVIDER_ENV).map_or_else(
            || {
                crate::adapters::Adapter::default_for(&spec.command)
                    == Some(crate::adapters::Adapter::Codex)
            },
            |provider| provider == "codex",
        );
        let resolving = is_codex.then(|| {
            let (send, receive) = std::sync::mpsc::channel();
            let spec = spec.clone();
            std::thread::spawn(move || {
                let root = crate::adapters::codex_home(&spec.command, &spec.cwd, &spec.env)
                    .ok()
                    .map(|p| p.join("sessions"));
                let _ = send.send(root);
            });
            receive
        });
        Self {
            resolving,
            ..Default::default()
        }
    }
    pub fn read(&mut self, conversation: &str, now: u64) -> Vec<AgentContext> {
        if let Some(receiver) = &self.resolving {
            match receiver.try_recv() {
                Ok(root) => {
                    self.root = root;
                    self.resolving = None;
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => self.resolving = None,
                Err(std::sync::mpsc::TryRecvError::Empty) => return Vec::new(),
            }
        }
        if self.conversation != conversation {
            self.conversation = conversation.into();
            self.file = None;
            self.discovery = None;
            self.offset = 0;
            self.pending.clear();
            self.verified = false;
            self.discarding = false;
            self.retry_ms = 0;
        }
        if self.file.is_none() && now >= self.retry_ms {
            if self.discovery.is_none() {
                self.discovery = self.root.as_deref().and_then(TranscriptDiscovery::new);
            }
            if let Some(discovery) = &mut self.discovery {
                self.file = discovery.scan(conversation, 4096);
                if self.file.is_some() || discovery.directories.is_empty() {
                    self.discovery = None;
                }
            }
            // Continue an unfinished traversal next tick. Only a complete miss is delayed.
            if self.discovery.is_none() {
                self.retry_ms = now.saturating_add(5000);
            }
        }
        let Some(path) = &self.file else {
            return Vec::new();
        };
        let Ok(mut file) = std::fs::File::open(path) else {
            return Vec::new();
        };
        if file.metadata().is_ok_and(|m| m.len() < self.offset) {
            self.offset = 0;
            self.pending.clear();
            self.verified = false;
            self.discarding = false;
        }
        let length = file.metadata().map_or(0, |m| m.len());
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.take(64 * 1024).read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        if self.discarding {
            let Some(end) = bytes.iter().position(|b| *b == b'\n') else {
                return Vec::new();
            };
            bytes.drain(..=end);
            self.discarding = false;
        }
        self.pending.extend(bytes);
        let mut contexts = Vec::new();
        if let Some(end) = self.pending.iter().rposition(|b| *b == b'\n') {
            for line in self.pending[..=end].split(|b| *b == b'\n') {
                let Ok(value) = serde_json::from_slice::<Value>(line) else {
                    continue;
                };
                if !self.verified {
                    if value.get("type").and_then(Value::as_str) == Some("session_meta") {
                        self.verified = value.pointer("/payload/id").and_then(Value::as_str)
                            == Some(conversation);
                        if !self.verified {
                            self.root = None;
                            self.file = None;
                            break;
                        }
                    }
                    continue;
                }
                if let Some(context) = codex(&value) {
                    contexts.push(context);
                }
            }
            self.pending.drain(..=end);
        }
        // A malformed unbounded line never grows the service indefinitely.
        if self.pending.len() > 1024 * 1024 {
            self.pending.clear();
            self.discarding = true;
        }
        // Verify the header, then catch up from a bounded tail of long-running conversations.
        if self.verified && self.offset < length.saturating_sub(256 * 1024) {
            self.offset = length - 256 * 1024;
            self.pending.clear();
            self.discarding = true;
        }
        contexts
    }

    /// Catch up before the watcher is removed permanently. Shell resolution may still
    /// be in flight for short runs; wait only here, never on the shared monitor thread.
    pub fn drain(&mut self, conversation: &str, now: u64) -> Vec<AgentContext> {
        if let Some(receiver) = self.resolving.take() {
            self.root = receiver
                .recv_timeout(std::time::Duration::from_millis(2200))
                .ok()
                .flatten();
        }
        self.retry_ms = 0;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        let mut contexts = Vec::new();
        loop {
            let previous_offset = self.offset;
            let same_conversation = self.conversation == conversation;
            contexts.extend(self.read(conversation, now));
            if (self.discovery.is_none()
                && (self.file.is_none() || (same_conversation && self.offset == previous_offset)))
                || std::time::Instant::now() >= deadline
            {
                break;
            }
        }
        contexts
    }
}

/// Keep directory iterators alive across bounded scans so large histories make progress.
struct TranscriptDiscovery {
    directories: Vec<(std::fs::ReadDir, usize)>,
}
impl TranscriptDiscovery {
    fn new(root: &Path) -> Option<Self> {
        Some(Self {
            directories: vec![(std::fs::read_dir(root).ok()?, 6)],
        })
    }

    fn scan(&mut self, id: &str, budget: usize) -> Option<PathBuf> {
        if !crate::adapters::valid_id(id) {
            self.directories.clear();
            return None;
        }
        for _ in 0..budget {
            let (entries, depth) = self.directories.last_mut()?;
            let depth = *depth;
            let Some(entry) = entries.next() else {
                self.directories.pop();
                continue;
            };
            let Ok(entry) = entry else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if kind.is_file()
                && (name == format!("{id}.jsonl") || name.ends_with(&format!("-{id}.jsonl")))
            {
                return Some(entry.path());
            }
            if kind.is_dir()
                && depth > 1
                && let Ok(entries) = std::fs::read_dir(entry.path())
            {
                self.directories.push((entries, depth - 1));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn claude_context_is_independent_of_account_limits_and_session_totals() {
        let payload = json!({"context_window": {
            "context_window_size":200000,"used_percentage":12.5,"total_input_tokens":900000,
            "current_usage":{"input_tokens":10000,"cache_creation_input_tokens":5000,"cache_read_input_tokens":10000}
        }});
        let context = claude(&payload, 500).unwrap();
        assert_eq!(context.used_tokens, Some(25000));
        assert_eq!(context.used_percent, Some(12.5));
        assert_eq!(context.observed_ms, Some(500));
        for value in [
            json!({}),
            json!({"current_usage":null}),
            json!({"current_usage":{"input_tokens":10}}),
        ] {
            let context = claude(&json!({"context_window":value}), 600).unwrap();
            assert_eq!(context.used_tokens, None);
            assert_eq!(context.used_percent, None);
        }
        assert!(claude(&json!({"rate_limits":{}}), 500).is_none());
        assert_eq!(
            claude(
                &json!({"context_window":{"used_percentage":-1,"context_window_size":0}}),
                500
            )
            .unwrap()
            .window_tokens,
            None
        );
    }

    fn token_event() -> Value {
        // Sanitized local Codex rollout shape; total_token_usage is deliberately much larger.
        json!({"timestamp":"2026-11-10T12:00:00.000Z","type":"event_msg","payload":{
            "type":"token_count","info":{"total_token_usage":{"total_tokens":900000},
            "last_token_usage":{"input_tokens":24000,"cached_input_tokens":10000,"output_tokens":1000,"total_tokens":25000},
            "model_context_window":100000},"rate_limits":null
        }})
    }

    #[test]
    fn codex_never_substitutes_cumulative_totals_or_infers_compaction() {
        let mut value = token_event();
        assert_eq!(codex(&value).unwrap().used_tokens, Some(25000));
        assert_eq!(codex(&value).unwrap().used_percent, Some(25.0));
        value["payload"]["info"]["last_token_usage"] = Value::Null;
        assert_eq!(codex(&value).unwrap().used_tokens, None);
        assert_eq!(codex(&value).unwrap().compaction, Compaction::Unknown);
        value["payload"]["info"]["last_token_usage"] = json!({"total_tokens":5});
        assert_eq!(codex(&value).unwrap().compaction, Compaction::Unknown);
        value["timestamp"] = json!("bad date");
        assert!(codex(&value).is_none());
    }

    #[test]
    fn explicit_codex_compaction_has_completion_time_without_turn_completion() {
        for value in [
            json!({"timestamp":"2026-11-10T12:00:00Z","type":"compacted","payload":{"message":"summary","replacement_history":[]}}),
            json!({"timestamp":"2026-11-10T12:00:00Z","type":"event_msg","payload":{"type":"context_compacted"}}),
        ] {
            let context = codex(&value).unwrap();
            assert_eq!(context.compaction, Compaction::Idle);
            assert_eq!(context.last_compaction_ms, context.observed_ms);
            assert_eq!(context.used_tokens, None);
        }
    }

    #[test]
    fn transcript_reader_skips_large_message_lines_without_losing_future_context() {
        let root =
            std::env::temp_dir().join(format!("patchbay-context-large-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = "12345678-conversation";
        let path = root.join(format!("rollout-{id}.jsonl"));
        let header = json!({"type":"session_meta","payload":{"id":id}});
        std::fs::write(
            &path,
            format!(
                "{header}\n{}\n{}\n",
                "x".repeat(2 * 1024 * 1024),
                token_event()
            ),
        )
        .unwrap();
        let mut reader = CodexReader {
            root: Some(root.clone()),
            ..Default::default()
        };
        let mut found = Vec::new();
        for now in 1..=8 {
            found.extend(reader.read(id, now));
        }
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].used_percent, Some(25.0));
        assert!(reader.pending.len() < 1024 * 1024);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transcript_discovery_resumes_beyond_the_entry_budget() {
        let root =
            std::env::temp_dir().join(format!("patchbay-discovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..4200 {
            std::fs::write(root.join(format!("12345678-{index}.jsonl")), "").unwrap();
        }
        // Pick an existing entry beyond the first scan in this directory's enumeration.
        let path = std::fs::read_dir(&root)
            .unwrap()
            .last()
            .unwrap()
            .unwrap()
            .path();
        let id = path.file_stem().unwrap().to_str().unwrap();
        let header = json!({"type":"session_meta","payload":{"id":id}});
        std::fs::write(&path, format!("{header}\n{}\n", token_event())).unwrap();
        let mut reader = CodexReader {
            root: Some(root.clone()),
            ..Default::default()
        };
        assert!(reader.read(id, 1).is_empty());
        assert!(reader.discovery.is_some());
        assert_eq!(reader.read(id, 2)[0].used_percent, Some(25.0));
        assert!(reader.discovery.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transcript_drain_waits_for_resolution_and_reads_through_empty_chunks() {
        let root = std::env::temp_dir().join(format!("patchbay-drain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = "12345678-conversation";
        let header = json!({"type":"session_meta","payload":{"id":id}});
        std::fs::write(
            root.join(format!("rollout-{id}.jsonl")),
            format!("{header}\n{}{}\n", "{}\n".repeat(50000), token_event()),
        )
        .unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let resolved_root = root.clone();
        let resolver = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            send.send(Some(resolved_root)).unwrap();
        });
        let mut reader = CodexReader {
            resolving: Some(receive),
            ..Default::default()
        };
        let contexts = reader.drain(id, 1);
        resolver.join().unwrap();
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].used_percent, Some(25.0));
        assert!(reader.drain(id, 2).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn transcript_reader_is_incremental_waits_for_complete_lines_and_isolates_identity() {
        let root = std::env::temp_dir().join(format!("patchbay-context-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let id = "12345678-conversation";
        let path = root.join(format!("rollout-{id}.jsonl"));
        let header = json!({"type":"session_meta","payload":{"id":id}});
        let event = token_event().to_string();
        let split = event.len() / 2;
        std::fs::write(&path, format!("{header}\n{}", &event[..split])).unwrap();
        let mut reader = CodexReader {
            root: Some(root.clone()),
            ..Default::default()
        };
        assert!(reader.read(id, 1).is_empty());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{}", &event[split..]).unwrap();
        assert_eq!(reader.read(id, 2)[0].used_percent, Some(25.0));
        assert!(reader.read(id, 3).is_empty());
        assert!(reader.read("different-conversation", 4).is_empty());
        let other = root.join("rollout-different-conversation.jsonl");
        std::fs::write(other, format!("{header}\n{event}\n")).unwrap();
        assert!(reader.read("different-conversation", 5005).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
