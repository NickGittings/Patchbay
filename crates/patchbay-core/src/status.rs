//! What a running session is doing, beyond "the process is alive": whether an
//! agent is working, waiting for input or done, and whether a service is
//! listening. [`crate::pty::PtyManager`] owns one [`Tracker`] per session.
//!
//! Agents report through a status file named by `PATCHBAY_STATUS_FILE`: the
//! first line is a state word (`working`, `needs-input`, `notify`, `review`,
//! `idle`), optionally followed by JSON (a Claude Code hook's stdin). Any tool
//! can write it. Services are recognised from their output: the first local URL
//! they print, or the terminal's `readyWhen` text.

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, SystemTime};

/// Env var naming the file a session may write its agent state to.
pub const STATUS_ENV: &str = "PATCHBAY_STATUS_FILE";

/// Output within this window counts as activity.
const ACTIVE_MS: u64 = 1500;
/// Output this soon after input is taken as its echo, not activity.
const ECHO_MS: u64 = 300;
/// Give automatic reviewers time to answer before showing a permission prompt.
const APPROVAL_QUIET_MS: u64 = 3_000;
/// A reported `working` with no output for this long is treated as idle: an
/// interrupted agent may never report that it stopped, while a working one
/// keeps animating.
const STALE_WORKING_MS: u64 = 15_000;
/// Between health probes of a service's port.
pub const PROBE_INTERVAL_MS: u64 = 5_000;
/// Consecutive failed probes before a service is shown as unreachable.
const PROBE_FAILURES: u32 = 2;
/// Longest line kept while scanning output.
const LINE_LIMIT: usize = 2048;
/// Longest prompt or message kept from a report.
const DETAIL_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Busy with a prompt.
    Working,
    /// Blocked on the user, e.g. a permission prompt.
    NeedsInput,
    /// Finished its turn; its work is ready to look at.
    Review,
    /// Waiting for a prompt.
    Idle,
    /// Provider conversation ended; the PTY may still be alive.
    Ended,
}

/// The agent's latest self-reported state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReport {
    pub state: AgentState,
    /// When it entered `state`, in Unix milliseconds.
    pub since_ms: u64,
    /// Why it needs input, when it does.
    pub message: Option<String>,
    /// The prompt it is working on, or last worked on.
    pub prompt: Option<String>,
    /// Confirmed by a native provider hook; absent for legacy reports.
    pub provider: Option<crate::adapters::Adapter>,
    pub conversation_id: Option<String>,
    pub turn_id: Option<String>,
    #[serde(default)]
    pub authoritative: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// Last output that wasn't an echo of input, in Unix milliseconds.
    pub last_output_ms: Option<u64>,
    /// Whether it produced output in the last moment.
    pub active: bool,
    /// Set once the session reports through its status file.
    pub agent: Option<AgentReport>,
    /// The first local URL it printed.
    pub url: Option<String>,
    /// It printed a local URL or its `readyWhen` text.
    pub ready: bool,
    /// Whether the URL's port accepts connections; unknown until probed.
    pub healthy: Option<bool>,
    /// The user asked it to stop, so a non-zero exit isn't a failure.
    pub stopped: bool,
    /// When a window last showed it to the user, in Unix milliseconds.
    pub seen_ms: Option<u64>,
}

impl SessionStatus {
    /// Equal apart from `last_output_ms`, which changes with every chunk.
    fn same_as(&self, other: &Self) -> bool {
        Self {
            last_output_ms: other.last_output_ms,
            ..self.clone()
        } == *other
    }
}

/// One parsed status file.
#[derive(Debug, PartialEq, Eq)]
struct Report {
    state: AgentState,
    message: Option<String>,
    prompt: Option<String>,
}

fn truncate(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let first = text.lines().next().unwrap_or_default();
    let mut out: String = first.chars().take(DETAIL_LIMIT).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    Some(out)
}

/// `None` for an unknown word or a notification that doesn't need the user.
fn parse_report(text: &str) -> Option<Report> {
    let (word, rest) = text.split_once('\n').unwrap_or((text, ""));
    let json: serde_json::Value = serde_json::from_str(rest).unwrap_or_default();
    let field = |name: &str| json.get(name).and_then(|v| v.as_str()).and_then(truncate);
    let state = match word.trim() {
        "working" => AgentState::Working,
        "needs-input" => AgentState::NeedsInput,
        // Claude Code also notifies after a minute of idling at its prompt,
        // which isn't something it needs from the user.
        "notify" => match field("notification_type").as_deref() {
            Some("idle_prompt" | "auth_success") => return None,
            _ => AgentState::NeedsInput,
        },
        "review" => AgentState::Review,
        "idle" => AgentState::Idle,
        _ => return None,
    };
    Some(Report {
        state,
        message: field("message"),
        prompt: field("prompt"),
    })
}

/// Strips terminal escapes from output and yields complete lines, across chunks.
#[derive(Default)]
struct LineScanner {
    escape: Escape,
    line: Vec<u8>,
}

#[derive(Default, Clone, Copy)]
enum Escape {
    #[default]
    None,
    Esc,
    EscIntermediate,
    Csi,
    Osc,
    String,
    StringEsc,
}

impl Escape {
    /// Yield bytes outside terminal controls, retaining partial escapes across chunks.
    fn feed(&mut self, b: u8) -> Option<u8> {
        if matches!(self, Self::StringEsc) {
            if b == b'\\' {
                *self = Self::None;
                return None;
            }
            // ESC cancels an unterminated control string and starts a new escape.
            *self = Self::Esc;
            return self.feed(b);
        }
        // Non-ASCII bytes cannot belong to a short escape. Recover before
        // consuming the first UTF-8 byte, including when ESC arrived separately.
        if matches!(self, Self::Esc | Self::EscIntermediate) && b >= 0x80 {
            *self = Self::None;
        }
        let plain = matches!(self, Self::None) && b != 0x1b;
        *self = match (*self, b) {
            (_, 0x18 | 0x1a) => Self::None, // CAN / SUB cancel a control sequence.
            (Self::Osc | Self::String, 0x1b) => Self::StringEsc,
            (_, 0x1b) => Self::Esc,
            (Self::None, _) => Self::None,
            (Self::Esc, b'[') => Self::Csi,
            (Self::Esc, b']') => Self::Osc,
            (Self::Esc, b'P' | b'X' | b'^' | b'_') => Self::String,
            (Self::Esc | Self::EscIntermediate, 0x20..=0x2f) => Self::EscIntermediate,
            (Self::Esc | Self::EscIntermediate, 0x30..=0x7e) | (Self::Csi, 0x40..=0x7e) => {
                Self::None
            }
            (Self::Osc, 0x07) => Self::None,
            _ => *self,
        };
        plain.then_some(b)
    }
}

impl LineScanner {
    /// Parse once for both text activity and optional service line detection.
    fn feed(&mut self, data: &[u8], scan_lines: bool, mut on_line: impl FnMut(&str)) -> bool {
        let mut text = false;
        for &b in data {
            let Some(b) = self.escape.feed(b) else {
                continue;
            };
            text |= b >= 0x20 && b != 0x7f;
            if !scan_lines {
                continue;
            }
            match b {
                b'\n' | b'\r' => {
                    if !self.line.is_empty() {
                        on_line(&String::from_utf8_lossy(&self.line));
                        self.line.clear();
                    }
                }
                b if (b >= 0x20 && b != 0x7f || b == b'\t') && self.line.len() < LINE_LIMIT => {
                    self.line.push(b);
                }
                _ => {}
            }
        }
        text
    }
}

const LOCAL_HOSTS: [&str; 5] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"];

/// The first local URL in a line, with wildcard hosts shown as `localhost`,
/// and its port.
fn find_local_url(line: &str) -> Option<(String, u16)> {
    let lower = line.to_ascii_lowercase();
    for (start, _) in lower.match_indices(['l', '1', '0', '[']) {
        let Some(host) = LOCAL_HOSTS.iter().find(|h| lower[start..].starts_with(*h)) else {
            continue;
        };
        let before = &lower[..start];
        // Only web URLs, or a bare `host:port` that isn't part of a longer
        // name, path or other scheme (`postgres://localhost:5432`).
        let scheme = if before.ends_with("https://") {
            "https"
        } else if before.ends_with("http://")
            || before
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '/' | ':' | '@'))
        {
            "http"
        } else {
            continue;
        };
        let after = &line[start + host.len()..];
        let Some(rest) = after.strip_prefix(':') else {
            continue;
        };
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let Ok(port) = digits.parse::<u16>() else {
            continue;
        };
        if port == 0 {
            continue;
        }
        let path: String = rest[digits.len()..]
            .chars()
            .take_while(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | ')' | '>' | ','))
            .collect();
        // Sentence punctuation after the URL isn't part of it.
        let path = path.trim_end_matches(['.', ',', ';', ':', '!', '?', ']', '}']);
        if path.chars().next().is_some_and(|c| c != '/') {
            continue;
        }
        let shown = match *host {
            "0.0.0.0" | "[::]" => "localhost",
            h => h,
        };
        return Some((format!("{scheme}://{shown}:{port}{path}"), port));
    }
    None
}

/// Whether anything is listening on a local port.
#[must_use]
pub fn probe(port: u16) -> bool {
    let timeout = Duration::from_millis(500);
    [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
    ]
    .iter()
    .any(|addr| TcpStream::connect_timeout(addr, timeout).is_ok())
}

/// Whether a line announces someone else's address rather than the service's
/// own: a proxy target, a database it connects to, or a connection error.
fn mentions_other_address(line: &str) -> bool {
    let lower = line.to_lowercase();
    [
        "proxy",
        "->",
        "=>",
        "error",
        "refused",
        "failed",
        "connecting to",
        "connected to",
        "database",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

/// What input means for an agent's state: Esc or Ctrl+C interrupts it
/// (`Idle`); a key press or Enter answers a prompt (`Working`); an escape
/// sequence such as a focus report or an arrow key means nothing.
fn input_effect(data: &[u8]) -> Option<AgentState> {
    if data == [0x1b] || data.contains(&0x03) {
        Some(AgentState::Idle)
    } else if data.first() != Some(&0x1b)
        && data.iter().any(|&b| b == b'\r' || (b >= 0x20 && b != 0x7f))
    {
        Some(AgentState::Working)
    } else {
        None
    }
}

/// A status file's modification time and length, which tell one write from
/// another.
pub type Stamp = (SystemTime, u64);

#[derive(Debug, PartialEq, Eq)]
struct PendingApproval {
    requested_ms: u64,
    message: Option<String>,
}

/// Mouse and focus reports the terminal sends on its own. They are never echoed.
fn is_terminal_report(data: &[u8]) -> bool {
    [b"\x1b[<".as_slice(), b"\x1b[M", b"\x1b[I", b"\x1b[O"]
        .iter()
        .any(|prefix| data.starts_with(prefix))
}

/// Moves a state on after input that resolves it: answering a prompt resumes
/// the agent, and an interrupt stops it. Returns whether it changed.
fn resolve(state: &mut AgentState, message: &mut Option<String>, effect: AgentState) -> bool {
    let resolves = match effect {
        AgentState::Working => *state == AgentState::NeedsInput,
        AgentState::Idle => matches!(*state, AgentState::NeedsInput | AgentState::Working),
        _ => false,
    };
    if resolves {
        *state = effect;
        *message = None;
    }
    resolves
}

pub(crate) fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

/// Status of one session incarnation.
#[derive(Default)]
pub struct Tracker {
    /// Look for a local URL or `ready_when` (task terminals only).
    service: bool,
    ready_when: String,
    lines: LineScanner,
    last_input_ms: Option<u64>,
    /// The last input that answered or interrupted the agent, and its effect.
    resolved: Option<(u64, AgentState)>,
    port: Option<u16>,
    probing: bool,
    next_probe_ms: u64,
    failures: u32,
    report: Option<AgentReport>,
    /// PermissionRequest may be answered by an automatic reviewer, not the user.
    approval_pending: Option<PendingApproval>,
    /// Text activity excludes cursor redraws and Codex's blinking OSC window title,
    /// which continue even while a real approval dialog waits for input.
    last_text_output_ms: Option<u64>,
    session_identity: Option<(String, u64)>,
    hook_sequence: u64,
    hook_conversation: Option<String>,
    hook_turn: Option<String>,
    retired_turns: std::collections::HashSet<String>,
    retired_conversations: std::collections::HashSet<String>,
    turn_closed: bool,
    /// The status file write `report` came from.
    report_stamp: Option<Stamp>,
    /// When the agent last reported or was resumed, in Unix milliseconds.
    heard_ms: u64,
    status: SessionStatus,
    emitted: SessionStatus,
}

impl Tracker {
    /// With `service`, output is scanned for a local URL and for `ready_when`,
    /// matched case-insensitively against lines (empty matches nothing).
    #[must_use]
    pub fn new(ready_when: &str, service: bool) -> Self {
        Self {
            service,
            ready_when: ready_when.trim().to_lowercase(),
            ..Self::default()
        }
    }

    /// Bind authoritative hooks to this process incarnation.
    #[must_use]
    pub fn with_identity(mut self, session: &str, generation: u64) -> Self {
        self.session_identity = Some((session.into(), generation));
        self
    }

    /// Consume a native provider event. Unknown sessions, retired conversations/turns,
    /// late sequence numbers, and progress after completion cannot change status.
    pub fn on_hook(&mut self, event: crate::agent_hooks::HookEvent, now: u64) {
        if self
            .session_identity
            .as_ref()
            .is_none_or(|(session, generation)| {
                session != &event.session || *generation != event.generation
            })
            || event.sequence <= self.hook_sequence
            // Resuming an earlier conversation starts it again.
            || (event.event != "SessionStart"
                && self.retired_conversations.contains(&event.conversation))
        {
            return;
        }
        self.hook_sequence = event.sequence;
        if self.hook_conversation.as_ref() != Some(&event.conversation) {
            // A fresh start in another conversation is a nested run (`claude -p`, `codex exec`
            // started from this terminal), which inherits the reporting environment.
            if self.hook_conversation.is_some()
                && (event.event != "SessionStart" || event.source.as_deref() == Some("startup"))
            {
                return;
            }
            self.retired_conversations.remove(&event.conversation);
            if let Some(previous) = self.hook_conversation.replace(event.conversation.clone()) {
                self.retired_conversations.insert(previous);
            }
            self.hook_turn = None;
            self.retired_turns.clear();
            self.turn_closed = false;
        }
        // A provider that reports prompts without turn identity cannot establish
        // reliable progress. Retain Active/Quiet instead of its startup Idle state.
        if event.event == "UserPromptSubmit" && event.turn.is_none() {
            self.report = None;
            self.approval_pending = None;
            if let Some(turn) = self.hook_turn.take() {
                self.retired_turns.insert(turn);
            }
            return;
        }
        if let Some(turn) = &event.turn
            && !matches!(event.event.as_str(), "SessionStart" | "SessionEnd")
        {
            if self.retired_turns.contains(turn) {
                return;
            }
            if event.event == "UserPromptSubmit" {
                if self.hook_turn.as_ref() == Some(turn) {
                    return;
                }
                if let Some(previous) = self.hook_turn.replace(turn.clone())
                    && previous != *turn
                {
                    self.retired_turns.insert(previous);
                }
                self.turn_closed = false;
            } else if self.hook_turn.as_ref() != Some(turn) || self.turn_closed {
                return;
            }
        }
        let state = match event.event.as_str() {
            "SessionStart"
                if self
                    .report
                    .as_ref()
                    .is_some_and(|r| r.state == AgentState::Working)
                    && self.hook_turn.is_some() =>
            {
                return;
            } // Compaction does not end an active turn.
            "SessionStart" | "Interrupt" | "StopFailure" => AgentState::Idle,
            "SessionEnd" => AgentState::Ended,
            "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
                AgentState::Working
            }
            "PermissionRequest" | "Notification" => AgentState::NeedsInput,
            "Stop" => AgentState::Review,
            _ => return,
        };
        if matches!(
            state,
            AgentState::Review | AgentState::Ended | AgentState::Idle
        ) && event.event != "SessionStart"
        {
            self.turn_closed = true;
        }
        // Input that interrupted after a hook started takes precedence over its delayed report.
        let state = if self
            .resolved
            .is_some_and(|(at, effect)| at >= event.at_ms && effect == AgentState::Idle)
            && matches!(
                state,
                AgentState::Working | AgentState::NeedsInput | AgentState::Review
            ) {
            self.turn_closed = true;
            AgentState::Idle
        } else {
            state
        };
        let previous = self.report.take();
        let turn = event.turn.or_else(|| self.hook_turn.clone());
        let same_turn = previous.as_ref().filter(|r| {
            r.conversation_id.as_ref() == Some(&event.conversation) && r.turn_id == turn
        });
        // Codex may hand a request to its automatic reviewer; Claude sends the hook
        // only for a dialog it shows.
        let state = if event.event == "PermissionRequest"
            && state == AgentState::NeedsInput
            && event.provider == crate::adapters::Adapter::Codex
        {
            // Every accepted request is a new approval, even without a progress
            // hook between tools. Sequence checks above reject duplicate delivery.
            self.approval_pending = Some(PendingApproval {
                requested_ms: event.at_ms,
                message: event.message.clone(),
            });
            AgentState::Working
        } else {
            self.approval_pending = None;
            state
        };
        let same_report = same_turn.filter(|r| r.state == state);
        let since_ms = same_report.map_or(now, |r| r.since_ms);
        let message = if state == AgentState::NeedsInput {
            event.message
        } else {
            None
        };
        self.report = Some(AgentReport {
            state,
            since_ms,
            message,
            prompt: event.prompt.or_else(|| previous.and_then(|r| r.prompt)),
            provider: Some(event.provider),
            conversation_id: Some(event.conversation),
            turn_id: turn,
            authoritative: true,
        });
        self.heard_ms = now;
    }

    /// Answering a prompt that needs input resumes the agent (it reports again
    /// only once the approved step finishes); Esc or Ctrl+C stops it, which it
    /// never reports.
    pub fn on_input(&mut self, data: &[u8], now: u64) {
        // Mouse and focus reports must not hide spinner output arriving right after them.
        if !is_terminal_report(data) {
            self.last_input_ms = Some(now);
        }
        let Some(effect) = input_effect(data) else {
            return;
        };
        let pending = self.approval_pending.take();
        if let Some(report) = self.report.as_mut().filter(|r| r.authoritative) {
            if !data.contains(&0x03) {
                // Answering a permission prompt resumes the agent, but the provider only
                // confirms that with its next hook (and a denial may never send one). Until
                // then the state is a guess, so it decays to idle like any unconfirmed one.
                if effect == AgentState::Working
                    && resolve(&mut report.state, &mut report.message, effect)
                {
                    report.since_ms = now;
                    report.authoritative = false;
                    self.heard_ms = now;
                    self.resolved = Some((now, effect));
                }
                // Typing during a pending request may answer its dialog, follow up, or
                // deny it without a hook, so the work it keeps is a guess that decays.
                if effect == AgentState::Working && pending.is_some() {
                    report.authoritative = false;
                    self.heard_ms = now;
                    self.resolved = Some((now, effect));
                }
                // Esc interrupts a turn or denies a prompt, and providers send no hook for
                // either. It may also just close provider UI, so it only makes the state a
                // guess: a denied prompt turns idle, and work decays to idle once quiet.
                if effect == AgentState::Idle
                    && matches!(report.state, AgentState::Working | AgentState::NeedsInput)
                {
                    if report.state == AgentState::NeedsInput || pending.is_some() {
                        report.state = AgentState::Idle;
                        report.message = None;
                        report.since_ms = now;
                    }
                    report.authoritative = false;
                    self.heard_ms = now;
                }
                return;
            }
            self.turn_closed = true;
        }
        self.resolved = Some((now, effect));
        if let Some(report) = &mut self.report
            && resolve(&mut report.state, &mut report.message, effect)
        {
            report.since_ms = now;
            self.heard_ms = now;
        }
    }

    /// The user asked the process to stop.
    pub fn on_stop(&mut self) {
        self.status.stopped = true;
    }

    /// Finalize unresolved work before publishing the PTY's exit. Later snapshots
    /// and seen updates must not promote a pending approval to NeedsInput.
    pub fn on_exit(&mut self, now: u64) {
        self.approval_pending = None;
        if let Some(report) = self.report.as_mut().filter(|r| r.authoritative)
            && matches!(report.state, AgentState::Working | AgentState::NeedsInput)
        {
            report.state = AgentState::Ended;
            report.since_ms = now;
            report.message = None;
        }
    }

    /// A window showed the session to the user.
    pub fn on_seen(&mut self, now: u64) {
        self.status.seen_ms = Some(now);
    }

    pub fn on_output(&mut self, data: &[u8], now: u64) {
        let mut lines = Vec::new();
        // Ordinary terminals need no parsing. Agent activity and service lines
        // share one parser, consuming whole chunks to retain split escapes.
        // All PTYs have identities; only hook-reporting agents need text activity.
        let agent = self.hook_conversation.is_some();
        let text = (agent || self.service)
            && self
                .lines
                .feed(data, self.service, |line| lines.push(line.to_owned()));
        if self
            .last_input_ms
            .is_none_or(|t| now.saturating_sub(t) > ECHO_MS)
        {
            self.status.last_output_ms = Some(now);
            if text {
                self.last_text_output_ms = Some(now);
            }
        }
        for line in lines {
            self.scan_line(&line);
        }
    }

    fn scan_line(&mut self, line: &str) {
        if let Some((url, port)) = find_local_url(line)
            && !mentions_other_address(line)
            // Until its port answers, a later address may be the real one
            // (e.g. after a test server's).
            && (self.status.url.is_none()
                || (self.status.healthy != Some(true) && self.port != Some(port)))
        {
            self.status.url = Some(url);
            if self.ready_when.is_empty() {
                self.status.ready = true;
            }
            self.status.healthy = None;
            self.port = Some(port);
            self.failures = 0;
            self.next_probe_ms = 0;
        }
        if !self.ready_when.is_empty() && line.to_lowercase().contains(self.ready_when.as_str()) {
            self.status.ready = true;
        }
    }

    /// Whether the report from this write was already applied.
    #[must_use]
    pub fn has_report(&self, stamp: Stamp) -> bool {
        self.report_stamp == Some(stamp)
    }

    /// Apply the contents of the status file, written at `stamp`. A write
    /// already applied is skipped.
    pub fn on_report(&mut self, text: &str, stamp: Stamp, now: u64) {
        if self.has_report(stamp) {
            return;
        }
        self.report_stamp = Some(stamp);
        if self.report.as_ref().is_some_and(|r| r.authoritative) {
            return;
        }
        let Some(mut report) = parse_report(text) else {
            return;
        };
        // Input after the write already answered or interrupted it.
        if let Some((at, effect)) = self.resolved
            && at >= unix_ms(stamp.0)
        {
            resolve(&mut report.state, &mut report.message, effect);
        }
        // Tool after tool is one stretch of work; any other report starts anew.
        let continues = report.state == AgentState::Working
            && self.report.as_ref().is_some_and(|p| {
                p.state == AgentState::Working && self.quiet_ms(now) <= STALE_WORKING_MS
            });
        let previous = self.report.take();
        let since_ms = match &previous {
            Some(p) if continues => p.since_ms,
            _ => now,
        };
        // A prompt carries over until the next one; a message only while it's asked.
        let prompt = report.prompt.or_else(|| previous.and_then(|p| p.prompt));
        let message = (report.state == AgentState::NeedsInput)
            .then_some(report.message)
            .flatten();
        self.heard_ms = now;
        self.report = Some(AgentReport {
            state: report.state,
            since_ms,
            message,
            prompt,
            provider: None,
            conversation_id: None,
            turn_id: None,
            authoritative: false,
        });
    }

    /// The port to probe now, if one is due; the caller reports back with
    /// [`Tracker::on_probe`].
    pub fn due_probe(&mut self, now: u64) -> Option<u16> {
        let port = self.port?;
        if self.probing || now < self.next_probe_ms {
            return None;
        }
        self.probing = true;
        Some(port)
    }

    /// The result of probing `port`, ignored if the service's port changed since.
    pub fn on_probe(&mut self, port: u16, ok: bool, now: u64) {
        self.probing = false;
        if self.port != Some(port) {
            return;
        }
        self.next_probe_ms = now + PROBE_INTERVAL_MS;
        self.failures = if ok { 0 } else { self.failures + 1 };
        if ok {
            self.status.healthy = Some(true);
        } else if self.failures >= PROBE_FAILURES {
            self.status.healthy = Some(false);
        }
    }

    /// When the agent last showed a sign of life: output, a report, or resuming.
    fn last_heard(&self) -> u64 {
        self.status.last_output_ms.unwrap_or(0).max(self.heard_ms)
    }

    fn quiet_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.last_heard())
    }

    fn confirm_approval(&mut self, now: u64) {
        if self.approval_pending.as_ref().is_some_and(|pending| {
            now.saturating_sub(
                pending
                    .requested_ms
                    .max(self.last_text_output_ms.unwrap_or(0)),
            ) >= APPROVAL_QUIET_MS
        }) {
            let pending = self.approval_pending.take().unwrap();
            if let Some(report) = &mut self.report {
                report.state = AgentState::NeedsInput;
                // Asked from now: a window may have been seen during the grace.
                report.since_ms = now;
                report.message = pending.message;
            }
        }
    }

    /// Recompute time-dependent fields.
    fn refresh(&mut self, now: u64) {
        self.status.active = self
            .status
            .last_output_ms
            .is_some_and(|t| now.saturating_sub(t) <= ACTIVE_MS);
        let stale = self.quiet_ms(now) > STALE_WORKING_MS;
        let last_heard = self.last_heard();
        self.confirm_approval(now);
        self.status.agent = self.report.clone().map(|mut r| {
            if r.state == AgentState::Working && stale && !r.authoritative {
                r.state = AgentState::Idle;
                r.since_ms = last_heard;
            }
            r
        });
    }

    /// The current status.
    #[must_use]
    pub fn status(&mut self, now: u64) -> SessionStatus {
        self.refresh(now);
        self.status.clone()
    }

    /// The status if it changed meaningfully since last returned here.
    pub fn changed(&mut self, now: u64) -> Option<SessionStatus> {
        self.refresh(now);
        if self.status.same_as(&self.emitted) {
            return None;
        }
        self.emitted = self.status.clone();
        Some(self.status.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_strings_hide_payloads_and_recover_at_the_next_escape() {
        for prefix in *b"]PX^_" {
            for terminator in [b"\x1b\\".as_slice(), b"\x1b[0m", b"\x18", b"\x1a"] {
                let mut control = vec![0x1b, prefix];
                control.extend_from_slice(b"http://localhost:9999 ready\n");
                // BEL terminates OSC only, not DCS, SOS, PM or APC.
                if prefix != b']' {
                    control.extend_from_slice(b"\x07hidden");
                }
                control.extend_from_slice(terminator);
                for split in 0..=control.len() {
                    let mut tracker = Tracker::new("ready", true).with_identity("session", 42);
                    tracker.on_output(&control[..split], 100);
                    tracker.on_output(&control[split..], 200);
                    assert_eq!(tracker.last_text_output_ms, None, "{prefix}: {split}");
                    assert!(!tracker.status(200).ready);
                    assert!(tracker.status(200).url.is_none());
                    tracker.on_output(b"http://localhost:3000 ready\n", 300);
                    let status = tracker.status(300);
                    assert_eq!(status.url.as_deref(), Some("http://localhost:3000"));
                    assert!(status.ready);
                    assert_eq!(tracker.last_text_output_ms, Some(300));
                }
            }
        }
    }

    #[test]
    fn short_escapes_preserve_timer_text_and_service_lines() {
        for escape in [b"\x1b7".as_slice(), b"\x1b8", b"\x1b=", b"\x1b>", b"\x1b(B"] {
            let mut tracker = Tracker::new("ready", true).with_identity("session", 42);
            tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
            tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
            // Consume every escape byte separately, as well as a split UTF-8 glyph.
            for b in escape {
                tracker.on_output(&[*b], 3_000);
            }
            tracker.on_output(b"13s \xe2", 3_000);
            tracker.on_output(b"\x9c\x93 http://localhost:3000 ready\n", 3_000);
            let status = tracker.status(3_200);
            assert_eq!(status.agent.unwrap().state, AgentState::Working);
            assert_eq!(status.url.as_deref(), Some("http://localhost:3000"));
            assert!(status.ready);
            assert_eq!(tracker.last_text_output_ms, Some(3_000));
            assert_eq!(
                tracker.status(6_000).agent.unwrap().state,
                AgentState::NeedsInput
            );
        }
    }

    #[test]
    fn ordinary_terminals_skip_output_parsing() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_output(b"ordinary output\x1b]unfinished title", 100);
        assert!(matches!(tracker.lines.escape, Escape::None));
        assert!(tracker.lines.line.is_empty());
        assert_eq!(tracker.last_text_output_ms, None);
        assert_eq!(tracker.status(100).last_output_ms, Some(100));
    }

    #[test]
    fn utf8_after_a_stray_escape_preserves_text_across_chunks() {
        for prefix in [b"\x1b".as_slice(), b"\x1b("] {
            let data = [prefix, "✓ http://localhost:3000 ready\n".as_bytes()].concat();
            for split in 0..=data.len() {
                let mut scanner = LineScanner::default();
                let mut lines = Vec::new();
                scanner.feed(&data[..split], true, |line| lines.push(line.to_owned()));
                scanner.feed(&data[split..], true, |line| lines.push(line.to_owned()));
                assert_eq!(lines, ["✓ http://localhost:3000 ready"], "{split}");
            }
        }
    }

    /// Apply a report as if the status file was written at `now`.
    fn report(tracker: &mut Tracker, text: &str, now: u64) {
        let stamp = (
            SystemTime::UNIX_EPOCH + Duration::from_millis(now),
            text.len() as u64,
        );
        tracker.on_report(text, stamp, now);
    }

    #[test]
    fn parses_reports_and_ignores_idle_notifications() {
        let report = parse_report("working\n{\"prompt\":\"fix the build\\nplease\"}").unwrap();
        assert_eq!(report.state, AgentState::Working);
        assert_eq!(report.prompt.as_deref(), Some("fix the build…"));
        let report = parse_report(
            "notify\n{\"notification_type\":\"permission_prompt\",\"message\":\"Claude needs your permission to use Bash\"}",
        )
        .unwrap();
        assert_eq!(report.state, AgentState::NeedsInput);
        assert_eq!(
            report.message.as_deref(),
            Some("Claude needs your permission to use Bash")
        );
        assert!(parse_report("notify\n{\"notification_type\":\"idle_prompt\"}").is_none());
        assert_eq!(parse_report("review").unwrap().state, AgentState::Review);
        assert_eq!(
            parse_report("needs-input\n").unwrap().state,
            AgentState::NeedsInput
        );
        assert!(parse_report("bogus\n{}").is_none());
    }

    #[test]
    fn finds_local_urls() {
        let cases = [
            (
                "  ➜  Local:   http://localhost:5173/",
                "http://localhost:5173/",
            ),
            (
                "Listening on http://127.0.0.1:3000",
                "http://127.0.0.1:3000",
            ),
            ("listening on 0.0.0.0:8080", "http://localhost:8080"),
            ("(127.0.0.1:9000)", "http://127.0.0.1:9000"),
            (
                "server at https://[::1]:8443/app.",
                "https://[::1]:8443/app",
            ),
            (
                "Server listening on http://localhost:3000.",
                "http://localhost:3000",
            ),
            ("bound to localhost:3000;", "http://localhost:3000"),
            (
                "ready - started server on [::]:3000, url: x",
                "http://localhost:3000",
            ),
        ];
        for (line, url) in cases {
            assert_eq!(
                find_local_url(line).map(|(u, _)| u).as_deref(),
                Some(url),
                "{line}"
            );
        }
        for line in [
            "see http://example.com:80",
            "version 10.0.0.1:2",
            "localhost:abc",
            "mylocalhost:3000",
            "localhost:0",
            "postgres://localhost:5432/db",
            "redis://user@localhost:6379",
        ] {
            assert!(find_local_url(line).is_none(), "{line}");
        }
    }

    #[test]
    fn scans_lines_across_chunks_without_escapes() {
        let mut tracker = Tracker::new("Compiled Successfully", true);
        tracker.on_output(b"\x1b[32m  Local: \x1b[1mhttp://local", 10_000);
        assert!(tracker.status(10_000).url.is_none());
        tracker.on_output(b"host:\x1b[0m5173\x1b]0;title\x07/\r\n", 10_100);
        let status = tracker.status(10_100);
        assert_eq!(status.url.as_deref(), Some("http://localhost:5173/"));
        assert!(
            !status.ready,
            "a URL cannot bypass the configured readiness text"
        );
        assert_eq!(tracker.due_probe(10_100), Some(5173));
        assert_eq!(tracker.due_probe(10_100), None);
        tracker.on_output(b"\x1b[32mCompiled Succ", 10_200);
        tracker.on_output(b"essfully\x1b[0m\n", 10_300);
        assert!(tracker.status(10_300).ready);

        let mut tracker = Tracker::new("Compiled Successfully", true);
        tracker.on_output(b"webpack compiled successfully\n", 0);
        assert!(tracker.status(0).ready);
        assert!(!Tracker::new("", true).status(0).ready);
    }

    #[test]
    fn activity_ignores_echo_and_expires() {
        let mut tracker = Tracker::new("", true);
        tracker.on_input(b"x", 1_000);
        tracker.on_output(b"x", 1_100);
        assert!(!tracker.status(1_100).active);
        tracker.on_output(b"y", 2_000);
        assert!(tracker.status(2_500).active);
        assert!(!tracker.status(2_000 + ACTIVE_MS + 1).active);
    }

    #[test]
    fn reports_keep_prompt_and_go_stale_when_quiet() {
        let mut tracker = Tracker::new("", true);
        report(&mut tracker, "working\n{\"prompt\":\"add tests\"}", 100);
        tracker.on_output(b"spinner", 200);
        let agent = tracker.status(300).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
        report(&mut tracker, "notify\n{\"message\":\"Allow Bash?\"}", 400);
        let agent = tracker.status(400).agent.unwrap();
        assert_eq!(agent.state, AgentState::NeedsInput);
        assert_eq!(agent.message.as_deref(), Some("Allow Bash?"));
        assert_eq!(agent.prompt.as_deref(), Some("add tests"));
        report(&mut tracker, "working\n{}", 500);
        report(&mut tracker, "review\n{}", 600);
        let agent = tracker.status(600).agent.unwrap();
        assert_eq!((agent.state, agent.message), (AgentState::Review, None));
        assert_eq!(agent.prompt.as_deref(), Some("add tests"));

        report(&mut tracker, "working\n{}", 700);
        tracker.on_output(b"spinner", 700);
        assert_eq!(
            tracker
                .status(700 + STALE_WORKING_MS + 1)
                .agent
                .unwrap()
                .state,
            AgentState::Idle
        );
    }

    #[test]
    fn answering_clears_needs_input_and_shells_never_become_services() {
        let mut tracker = Tracker::new("", true);
        tracker.on_output(b"spinner", 50);
        report(&mut tracker, "notify\n{\"message\":\"Allow?\"}", 100);
        tracker.on_input(b"\x1b[I", 200);
        assert_eq!(
            tracker.status(200).agent.unwrap().state,
            AgentState::NeedsInput
        );
        tracker.on_input(b"\r", 300);
        let agent = tracker.status(300).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 300));
        assert_eq!(agent.message, None);

        let mut shell = Tracker::new("ready", false);
        shell.on_output(b"$ curl http://localhost:9999 ready\n", 0);
        let status = shell.status(0);
        assert!(status.url.is_none() && !status.ready);
        assert_eq!(shell.due_probe(0), None);
    }

    #[test]
    fn skips_other_addresses_until_the_service_answers() {
        let mut tracker = Tracker::new("", true);
        tracker.on_output(
            b"[HPM] Proxy created: /api -> http://localhost:8080\n\
              connect ECONNREFUSED 127.0.0.1:5432\n",
            0,
        );
        assert!(tracker.status(0).url.is_none());
        tracker.on_output(b"test server on http://localhost:4000\n", 0);
        assert_eq!(tracker.due_probe(0), Some(4000));
        tracker.on_probe(4000, false, 0);
        // An address printed later replaces one that hasn't answered.
        tracker.on_output(b"running at http://localhost:3000/\n", 0);
        assert_eq!(
            tracker.status(0).url.as_deref(),
            Some("http://localhost:3000/")
        );
        assert_eq!(tracker.due_probe(0), Some(3000));
        tracker.on_probe(3000, true, 0);
        tracker.on_output(b"also http://localhost:9999\n", 0);
        let status = tracker.status(0);
        assert_eq!(status.url.as_deref(), Some("http://localhost:3000/"));
        assert_eq!(status.healthy, Some(true));
    }

    #[test]
    fn interrupting_stops_the_agent() {
        let mut tracker = Tracker::new("", false);
        report(&mut tracker, "notify\n{}", 100);
        tracker.on_input(b"\x1b", 200);
        let agent = tracker.status(200).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Idle, 200));
        report(&mut tracker, "working\n{}", 300);
        tracker.on_input(b"\x03", 400);
        assert_eq!(tracker.status(400).agent.unwrap().state, AgentState::Idle);
        // Typing a prompt while it works changes nothing.
        report(&mut tracker, "working\n{}", 500);
        tracker.on_input(b"q\r", 600);
        assert_eq!(
            tracker.status(600).agent.unwrap().state,
            AgentState::Working
        );
    }

    #[test]
    fn an_answer_before_the_report_is_read_still_counts() {
        let mut tracker = Tracker::new("", false);
        tracker.on_input(b"1", 150);
        report_written(&mut tracker, "notify\n{}", 100, 250);
        assert_eq!(
            tracker.status(250).agent.unwrap().state,
            AgentState::Working
        );
        // A prompt written after the answer still needs input.
        report_written(&mut tracker, "notify\n{}", 300, 400);
        assert_eq!(
            tracker.status(400).agent.unwrap().state,
            AgentState::NeedsInput
        );
    }

    fn report_written(tracker: &mut Tracker, text: &str, written: u64, now: u64) {
        let stamp = (
            SystemTime::UNIX_EPOCH + Duration::from_millis(written),
            text.len() as u64,
        );
        tracker.on_report(text, stamp, now);
        assert!(tracker.has_report(stamp));
    }

    #[test]
    fn each_new_stretch_of_work_and_result_starts_its_own_time() {
        let mut tracker = Tracker::new("", false);
        // Reported without printing anything: fresh, not stale.
        report(&mut tracker, "working\n{}", 100_000);
        assert_eq!(
            tracker.status(100_500).agent.unwrap().state,
            AgentState::Working
        );
        report(&mut tracker, "working\n{}", 101_000);
        assert_eq!(tracker.status(101_000).agent.unwrap().since_ms, 100_000);
        // After going stale, the next prompt is new work.
        let later = 101_000 + STALE_WORKING_MS + 1;
        assert_eq!(tracker.status(later).agent.unwrap().state, AgentState::Idle);
        report(&mut tracker, "working\n{}", later + 1);
        assert_eq!(tracker.status(later + 1).agent.unwrap().since_ms, later + 1);
        // A second result is new even if the work between went unread.
        report(&mut tracker, "review\n{}", 200_000);
        report(&mut tracker, "review\n{ }", 300_000);
        assert_eq!(tracker.status(300_000).agent.unwrap().since_ms, 300_000);
    }

    #[test]
    fn changed_skips_output_time_only_updates() {
        let mut tracker = Tracker::new("", true);
        assert!(tracker.changed(0).is_none());
        tracker.on_output(b"a", 10_000);
        assert!(tracker.changed(10_000).unwrap().active);
        tracker.on_output(b"b", 10_500);
        assert!(tracker.changed(10_500).is_none());
        assert!(!tracker.changed(20_000).unwrap().active);
    }

    #[test]
    fn unreachable_after_repeated_failures() {
        let mut tracker = Tracker::new("", true);
        tracker.on_output(b"http://localhost:4000\n", 0);
        assert_eq!(tracker.due_probe(0), Some(4000));
        tracker.on_probe(4000, false, 0);
        assert_eq!(tracker.status(0).healthy, None);
        assert_eq!(tracker.due_probe(1), None);
        assert_eq!(tracker.due_probe(PROBE_INTERVAL_MS), Some(4000));
        tracker.on_probe(4000, false, PROBE_INTERVAL_MS);
        assert_eq!(tracker.status(0).healthy, Some(false));
        tracker.on_probe(4000, true, PROBE_INTERVAL_MS * 2);
        assert_eq!(tracker.status(0).healthy, Some(true));
    }

    fn hook(event: &str, turn: Option<&str>, sequence: u64) -> crate::agent_hooks::HookEvent {
        crate::agent_hooks::HookEvent {
            session: "session".into(),
            generation: 42,
            provider: crate::adapters::Adapter::Codex,
            sequence,
            at_ms: sequence * 100,
            event: event.into(),
            conversation: "12345678-conversation".into(),
            turn: turn.map(str::to_string),
            prompt: (event == "UserPromptSubmit").then(|| "build it".into()),
            message: (event == "PermissionRequest").then(|| "Allow Bash?".into()),
            source: None,
        }
    }
    #[test]
    fn native_hooks_preserve_quiet_work_and_correlate_turns_and_generations() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("SessionStart", None, 1), 100);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn-one"), 2), 200);
        assert_eq!(
            tracker.status(1_000_000).agent.unwrap().state,
            AgentState::Working
        );
        tracker.on_hook(hook("PermissionRequest", Some("turn-one"), 3), 300);
        tracker.on_input(b"\x1b[B", 320);
        assert_eq!(
            tracker.status(320).agent.unwrap().state,
            AgentState::Working
        );
        assert_eq!(tracker.approval_pending.as_ref().unwrap().requested_ms, 300);
        // Typing during pending approval keeps the turn's work, but only as a guess.
        tracker.on_input(b"y", 350);
        let answered = tracker.status(350).agent.unwrap();
        assert_eq!(answered.state, AgentState::Working);
        assert!(!answered.authoritative);
        assert_eq!(answered.since_ms, 200);
        assert_eq!(tracker.approval_pending, None);
        let mut duplicate = hook("UserPromptSubmit", Some("turn-one"), 4);
        duplicate.prompt = Some("duplicate prompt".into());
        tracker.on_hook(duplicate, 350);
        assert_eq!(
            tracker.status(400).agent.unwrap().state,
            AgentState::Working
        );
        assert_eq!(
            tracker.status(400).agent.unwrap().prompt.as_deref(),
            Some("build it")
        );
        tracker.on_hook(hook("PostToolUse", Some("turn-one"), 5), 400);
        tracker.on_hook(hook("Stop", Some("turn-one"), 6), 500);
        assert_eq!(tracker.status(500).agent.unwrap().state, AgentState::Review);
        tracker.on_hook(hook("PostToolUse", Some("turn-one"), 7), 600);
        assert_eq!(tracker.status(600).agent.unwrap().state, AgentState::Review);
        // Duplicate hook definitions or a late prompt cannot reopen the finished turn.
        tracker.on_hook(hook("UserPromptSubmit", Some("turn-one"), 8), 650);
        assert_eq!(tracker.status(650).agent.unwrap().state, AgentState::Review);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn-two"), 9), 700);
        tracker.on_hook(hook("Stop", Some("turn-one"), 10), 800);
        let mut old_generation = hook("Stop", Some("turn-two"), 11);
        old_generation.generation = 41;
        tracker.on_hook(old_generation, 900);
        assert_eq!(
            tracker.status(900).agent.unwrap().state,
            AgentState::Working
        );
        tracker.on_hook(hook("Interrupt", Some("turn-two"), 12), 1000);
        assert_eq!(tracker.status(1000).agent.unwrap().state, AgentState::Idle);
        tracker.on_hook(hook("SessionEnd", Some("turn-two"), 13), 1100);
        assert_eq!(tracker.status(1100).agent.unwrap().state, AgentState::Ended);
    }
    #[test]
    fn compaction_and_subagent_events_do_not_complete_the_parent_turn() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("parent-turn"), 1), 100);
        tracker.on_hook(hook("SessionStart", None, 2), 200);
        tracker.on_hook(hook("SubagentStop", Some("parent-turn"), 3), 300);
        tracker.on_hook(hook("Stop", Some("child-turn"), 4), 400);
        assert_eq!(
            tracker.status(100_000).agent.unwrap().state,
            AgentState::Working
        );
        tracker.on_input(b"\x03", 500);
        tracker.on_hook(hook("PostToolUse", Some("parent-turn"), 6), 600);
        assert_eq!(tracker.status(600).agent.unwrap().state, AgentState::Idle);
    }
    #[test]
    fn retired_conversations_and_legacy_reports_cannot_override_native_status() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("first-turn"), 1), 100);
        let mut start = hook("SessionStart", None, 2);
        start.conversation = "second-conversation".into();
        tracker.on_hook(start, 200);
        tracker.on_hook(hook("Stop", Some("first-turn"), 3), 300);
        report(&mut tracker, "review", 400);
        let agent = tracker.status(400).agent.unwrap();
        assert_eq!(
            agent.conversation_id.as_deref(),
            Some("second-conversation")
        );
        assert_eq!(agent.state, AgentState::Idle);
        // Resuming the first conversation makes it current again.
        tracker.on_hook(hook("SessionStart", None, 4), 500);
        tracker.on_hook(hook("UserPromptSubmit", Some("resumed-turn"), 5), 600);
        let agent = tracker.status(600).agent.unwrap();
        assert_eq!(
            agent.conversation_id.as_deref(),
            Some("12345678-conversation")
        );
        assert_eq!(agent.state, AgentState::Working);
        let mut late = hook("Stop", Some("second-turn"), 6);
        late.conversation = "second-conversation".into();
        tracker.on_hook(late, 700);
        assert_eq!(
            tracker.status(700).agent.unwrap().state,
            AgentState::Working
        );
    }
    #[test]
    fn nested_runs_cannot_take_over_the_terminals_conversation() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("SessionStart", None, 1), 100);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 2), 200);
        let mut nested = hook("SessionStart", None, 3);
        nested.conversation = "nested-conversation".into();
        nested.source = Some("startup".into());
        tracker.on_hook(nested, 300);
        let mut nested_stop = hook("Stop", Some("nested-turn"), 4);
        nested_stop.conversation = "nested-conversation".into();
        tracker.on_hook(nested_stop, 400);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 5), 500);
        let agent = tracker.status(500 + APPROVAL_QUIET_MS).agent.unwrap();
        assert_eq!(agent.state, AgentState::NeedsInput);
        assert_eq!(
            agent.conversation_id.as_deref(),
            Some("12345678-conversation")
        );
        // `/clear` starts the terminal's next conversation.
        let mut cleared = hook("SessionStart", None, 6);
        cleared.conversation = "cleared-conversation".into();
        cleared.source = Some("clear".into());
        tracker.on_hook(cleared, 600);
        let agent = tracker.status(600).agent.unwrap();
        assert_eq!(
            agent.conversation_id.as_deref(),
            Some("cleared-conversation")
        );
    }
    #[test]
    fn esc_makes_native_work_and_prompts_unconfirmed() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_input(b"\x1b", 200);
        let agent = tracker.status(200).agent.unwrap();
        assert_eq!(agent.state, AgentState::Working);
        assert!(!agent.authoritative);
        assert_eq!(
            tracker
                .status(200 + STALE_WORKING_MS + 1)
                .agent
                .unwrap()
                .state,
            AgentState::Idle
        );
        // The provider's next hook confirms the turn went on.
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 3), 300);
        assert!(tracker.status(300).agent.unwrap().authoritative);
        assert_eq!(tracker.approval_pending.as_ref().unwrap().requested_ms, 300);
        tracker.on_input(b"\x1b", 400);
        let agent = tracker.status(400).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Idle, 400));
        assert_eq!(agent.message, None);
        assert!(!agent.authoritative);
        assert_eq!(tracker.approval_pending, None);
    }

    #[test]
    fn automatic_approval_stays_working_through_a_long_running_command() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        for now in (1_000..=30_000).step_by(1_000) {
            tracker.on_output(b"\x1b[19;12H\x1b[2m20s \xe2\xa0\x8b\x1b[0m", now);
            let agent = tracker
                .changed(now)
                .and_then(|s| s.agent)
                .unwrap_or_else(|| tracker.status(now).agent.unwrap());
            assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
            assert!(agent.authoritative);
            assert_eq!(agent.message, None);
        }
        tracker.on_hook(hook("PostToolUse", Some("turn"), 3), 30_100);
        assert_eq!(tracker.approval_pending, None);
        assert_eq!(
            tracker.status(100_000).agent.unwrap().state,
            AgentState::Working
        );
        tracker.on_hook(hook("Stop", Some("turn"), 4), 100_100);
        assert_eq!(
            tracker.status(100_100).agent.unwrap().state,
            AgentState::Review
        );
    }

    #[test]
    fn automatic_approvals_preserve_the_start_of_work() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        for sequence in [2, 4] {
            let now = sequence * 100;
            tracker.on_hook(hook("PermissionRequest", Some("turn"), sequence), now);
            let agent = tracker.status(now).agent.unwrap();
            assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
            tracker.on_hook(hook("PostToolUse", Some("turn"), sequence + 1), now + 100);
            let agent = tracker.status(now + 100).agent.unwrap();
            assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
            assert_eq!(tracker.approval_pending, None);
        }
        assert_eq!(
            tracker.status(100_000).agent.unwrap().state,
            AgentState::Working
        );
    }

    #[test]
    fn a_new_turn_during_pending_approval_starts_its_own_work_time() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("first"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("first"), 2), 200);
        tracker.on_hook(hook("UserPromptSubmit", Some("second"), 3), 300);
        let agent = tracker.status(300).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 300));
        assert_eq!(tracker.approval_pending, None);
    }

    #[test]
    fn compaction_during_pending_approval_keeps_work_and_the_pending_request() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_hook(hook("SessionStart", None, 3), 300);
        let agent = tracker.status(300).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
        assert!(agent.authoritative);
        assert_eq!(tracker.approval_pending.as_ref().unwrap().requested_ms, 200);
        assert_eq!(
            tracker.status(3_200).agent.unwrap().state,
            AgentState::NeedsInput
        );
    }

    #[test]
    fn mouse_and_focus_reports_do_not_suppress_approval_activity() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        for now in (1_000..=20_000).step_by(1_000) {
            for input in [
                b"\x1b[<35;10;5M".as_slice(),
                b"\x1b[M !!",
                b"\x1b[I",
                b"\x1b[O",
            ] {
                tracker.on_input(input, now);
                tracker.on_output(b"spinner", now + 1);
                assert_eq!(tracker.last_input_ms, None);
                assert_eq!(tracker.last_text_output_ms, Some(now + 1));
                let agent = tracker.status(now + 1).agent.unwrap();
                assert_eq!((agent.state, agent.since_ms), (AgentState::Working, 100));
                assert!(agent.authoritative);
            }
        }
    }

    #[test]
    fn exiting_cancels_pending_approval_before_later_status_reads() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_exit(300);
        let final_status = tracker.changed(300).unwrap();
        assert_eq!(
            final_status.agent.as_ref().unwrap().state,
            AgentState::Ended
        );
        assert_eq!(tracker.approval_pending, None);
        assert_eq!(tracker.status(100_000), final_status);
        tracker.on_seen(100_100);
        assert_eq!(tracker.changed(100_100).unwrap().agent, final_status.agent);
    }

    #[test]
    fn quiet_approval_keeps_its_message_and_asks_from_confirmation() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_output(b"Allow Bash?", 500);
        assert_eq!(
            tracker
                .status(500 + APPROVAL_QUIET_MS - 1)
                .agent
                .unwrap()
                .state,
            AgentState::Working
        );
        let agent = tracker.status(500 + APPROVAL_QUIET_MS).agent.unwrap();
        // A window seen during the grace never saw the prompt, so it asks from now.
        assert_eq!(
            (agent.state, agent.since_ms),
            (AgentState::NeedsInput, 500 + APPROVAL_QUIET_MS)
        );
        assert_eq!(agent.message.as_deref(), Some("Allow Bash?"));
        assert!(agent.authoritative);
        assert_eq!(tracker.approval_pending, None);
        // Once confirmed, incidental output cannot retract the request.
        tracker.on_output(b"redraw", 4_000);
        assert_eq!(tracker.status(4_000).agent.unwrap(), agent);
    }

    #[test]
    fn approval_waits_from_hook_time_and_ignores_input_echo() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_input(b"\r", 150);
        // Quiet starts at the hook timestamp, even if delivery is delayed.
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 250);
        tracker.on_output(b"echo", 400);
        assert_eq!(
            tracker
                .status(200 + APPROVAL_QUIET_MS - 1)
                .agent
                .unwrap()
                .state,
            AgentState::Working
        );
        let agent = tracker.status(200 + APPROVAL_QUIET_MS).agent.unwrap();
        assert_eq!(
            (agent.state, agent.since_ms),
            (AgentState::NeedsInput, 200 + APPROVAL_QUIET_MS)
        );
    }

    #[test]
    fn approval_ignores_cursor_redraws_and_blinking_titles_across_chunks() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_output(b"Allow Bash?", 300);
        // Captured from a real Codex 0.162.1 approval dialog. Its OSC title keeps
        // blinking while the screen text is static; either terminator is valid.
        for (data, now) in [
            (
                b"\x1b[?2026h\x1b[0m\x1b[22;3H\x1b[?25h\x1b[?2026l".as_slice(),
                1_000,
            ),
            (b"\x1b]0;[ ! ] Action Req", 1_500),
            (
                b"uired | probe\x07\x1b]0;[ . ] Action Required | probe\x1b",
                2_000,
            ),
            (b"\\\x1b[?2026", 2_500),
            (b"h\x1b[0m\x1b[?2026l", 3_000),
        ] {
            tracker.on_output(data, now);
            assert_eq!(
                tracker.status(now).agent.unwrap().state,
                AgentState::Working
            );
        }
        let status = tracker.status(300 + APPROVAL_QUIET_MS);
        assert_eq!(status.last_output_ms, Some(3_000));
        assert_eq!(status.agent.unwrap().state, AgentState::NeedsInput);
    }

    #[test]
    fn permission_notification_confirms_approval_even_with_output() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_output(b"animation", 290);
        let mut notification = hook("Notification", Some("turn"), 3);
        notification.message = Some("Please approve".into());
        tracker.on_hook(notification, 300);
        let agent = tracker.status(300).agent.unwrap();
        assert_eq!(agent.state, AgentState::NeedsInput);
        assert_eq!(agent.message.as_deref(), Some("Please approve"));
        assert!(agent.authoritative);
        assert_eq!(tracker.approval_pending, None);
    }

    #[test]
    fn a_new_permission_request_gets_grace_even_after_a_confirmed_prompt() {
        for notification in [false, true] {
            let mut tracker = Tracker::new("", false).with_identity("session", 42);
            tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
            tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
            if notification {
                tracker.on_hook(hook("Notification", Some("turn"), 3), 300);
            }
            assert_eq!(
                tracker.status(3_200).agent.unwrap().state,
                AgentState::NeedsInput
            );
            let mut next = hook("PermissionRequest", Some("turn"), 4);
            next.at_ms = 4_000;
            next.message = Some("Allow the next tool?".into());
            tracker.on_hook(next, 4_000);
            let working = tracker.status(4_000).agent.unwrap();
            assert_eq!(working.state, AgentState::Working);
            assert!(working.authoritative);
            assert_eq!(working.message, None);
            assert_eq!(
                tracker.status(6_999).agent.unwrap().state,
                AgentState::Working
            );
            let waiting = tracker.status(7_000).agent.unwrap();
            assert_eq!(
                (waiting.state, waiting.since_ms),
                (AgentState::NeedsInput, 7_000)
            );
            assert_eq!(waiting.message.as_deref(), Some("Allow the next tool?"));
        }
    }

    #[test]
    fn consecutive_automatic_approvals_get_fresh_grace_and_keep_work_time() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_output(b"running", 2_000);
        let mut next = hook("PermissionRequest", Some("turn"), 3);
        next.at_ms = 4_000;
        tracker.on_hook(next.clone(), 4_000);
        assert_eq!(
            tracker.approval_pending.as_ref().unwrap().requested_ms,
            4_000
        );
        assert_eq!(tracker.status(5_000).agent.unwrap().since_ms, 100);
        // The same journal entry is rejected rather than restarting grace.
        tracker.on_hook(next, 6_000);
        assert_eq!(
            tracker.approval_pending.as_ref().unwrap().requested_ms,
            4_000
        );
        assert_eq!(
            tracker.status(6_999).agent.unwrap().state,
            AgentState::Working
        );
        assert_eq!(
            tracker.status(7_000).agent.unwrap().state,
            AgentState::NeedsInput
        );
    }

    #[test]
    fn claude_permission_requests_need_input_at_once() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        let mut prompt = hook("UserPromptSubmit", Some("turn"), 1);
        prompt.provider = crate::adapters::Adapter::Claude;
        tracker.on_hook(prompt, 100);
        let mut request = hook("PermissionRequest", Some("turn"), 2);
        request.provider = crate::adapters::Adapter::Claude;
        tracker.on_hook(request, 200);
        assert_eq!(tracker.approval_pending, None);
        let agent = tracker.status(200).agent.unwrap();
        assert_eq!((agent.state, agent.since_ms), (AgentState::NeedsInput, 200));
    }

    #[test]
    fn echoed_navigation_keys_do_not_extend_the_approval_grace() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        // Arrow keys redraw the highlighted option; that echo isn't activity.
        for now in (1_000..3_000).step_by(500) {
            tracker.on_input(b"\x1b[B", now);
            tracker.on_output(b"> Yes", now + 50);
        }
        assert_eq!(
            tracker.status(200 + APPROVAL_QUIET_MS).agent.unwrap().state,
            AgentState::NeedsInput
        );
    }

    #[test]
    fn exiting_leaves_self_reported_states_alone() {
        let mut tracker = Tracker::new("", false);
        tracker.on_report("working", (SystemTime::UNIX_EPOCH, 7), 100);
        tracker.on_exit(200);
        assert_eq!(
            tracker.status(200).agent.unwrap().state,
            AgentState::Working
        );
    }

    #[test]
    fn answering_or_interrupting_pending_approval_clears_it() {
        for (input, expected) in [
            (b"y".as_slice(), AgentState::Working),
            ("是".as_bytes(), AgentState::Working),
            (b"\r", AgentState::Working),
            (b"\x1b", AgentState::Idle),
            (b"\x03", AgentState::Idle),
        ] {
            let mut tracker = Tracker::new("", false).with_identity("session", 42);
            tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
            tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
            tracker.on_input(input, 300);
            assert_eq!(tracker.approval_pending, None);
            let agent = tracker.status(300 + APPROVAL_QUIET_MS).agent.unwrap();
            assert_eq!(agent.state, expected);
            assert_eq!(agent.message, None);
            if expected == AgentState::Working {
                // A denial sends no hook, so the kept work decays once quiet.
                assert!(!agent.authoritative);
                assert_eq!(agent.since_ms, 100);
                assert_eq!(
                    tracker.status(100_000).agent.unwrap().state,
                    AgentState::Idle
                );
            } else if input == b"\x1b" {
                assert!(!agent.authoritative);
            }
        }
    }

    #[test]
    fn accepted_hooks_clear_pending_approval_and_rejected_hooks_preserve_it() {
        for event in [
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "Interrupt",
            "SessionEnd",
        ] {
            let mut tracker = Tracker::new("", false).with_identity("session", 42);
            tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
            tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
            tracker.on_hook(hook("PostToolUse", Some("other-turn"), 3), 300);
            assert_eq!(tracker.approval_pending.as_ref().unwrap().requested_ms, 200);
            tracker.on_hook(hook(event, Some("turn"), 4), 400);
            assert_eq!(tracker.approval_pending, None, "{event}");
        }
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("UserPromptSubmit", Some("turn"), 1), 100);
        tracker.on_hook(hook("PermissionRequest", Some("turn"), 2), 200);
        tracker.on_hook(hook("UserPromptSubmit", None, 3), 300);
        assert_eq!(tracker.approval_pending, None);
        assert!(tracker.status(300 + APPROVAL_QUIET_MS).agent.is_none());
    }
    #[test]
    fn legacy_status_history_deserializes_without_hook_metadata() {
        let report: AgentReport = serde_json::from_str(
            r#"{"state":"working","sinceMs":100,"message":null,"prompt":null}"#,
        )
        .unwrap();
        assert!(!report.authoritative);
    }
    #[test]
    fn a_prompt_without_turn_identity_returns_to_output_fallback() {
        let mut tracker = Tracker::new("", false).with_identity("session", 42);
        tracker.on_hook(hook("SessionStart", None, 1), 100);
        tracker.on_hook(hook("UserPromptSubmit", None, 2), 200);
        assert!(tracker.status(200).agent.is_none());
        tracker.on_output(b"working animation", 210);
        assert!(tracker.status(210).active);
        assert!(!tracker.status(10_000).active);
    }
}
