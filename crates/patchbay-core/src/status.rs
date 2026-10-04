//! What a running session is doing, beyond "the process is alive": whether an
//! agent is working, waiting for input or done, and whether a service is
//! listening. [`crate::pty::PtyManager`] owns one [`Tracker`] per session.
//!
//! Agents report through a status file named by `PATCHBAY_STATUS_FILE`: the
//! first line is a state word (`working`, `needs-input`, `notify`, `review`,
//! `idle`), optionally followed by JSON (a Claude Code hook's stdin). Any tool
//! can write it. Services are recognised from their output: the first local URL
//! they print, or the terminal's `readyWhen` text.

use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, SystemTime};

/// Env var naming the file a session may write its agent state to.
pub const STATUS_ENV: &str = "PATCHBAY_STATUS_FILE";

/// Output within this window counts as activity.
const ACTIVE_MS: u64 = 1500;
/// Output this soon after input is taken as its echo, not activity.
const ECHO_MS: u64 = 300;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
}

/// The agent's latest self-reported state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReport {
    pub state: AgentState,
    /// When it entered `state`, in Unix milliseconds.
    pub since_ms: u64,
    /// Why it needs input, when it does.
    pub message: Option<String>,
    /// The prompt it is working on, or last worked on.
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
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
    Csi,
    Osc,
    OscEsc,
}

impl LineScanner {
    fn feed(&mut self, data: &[u8], mut on_line: impl FnMut(&str)) {
        for &b in data {
            self.escape = match (self.escape, b) {
                (Escape::None, 0x1b) => Escape::Esc,
                (Escape::None, b'\n' | b'\r') => {
                    if !self.line.is_empty() {
                        on_line(&String::from_utf8_lossy(&self.line));
                        self.line.clear();
                    }
                    Escape::None
                }
                (Escape::None, b) => {
                    if (b >= 0x20 || b == b'\t') && self.line.len() < LINE_LIMIT {
                        self.line.push(b);
                    }
                    Escape::None
                }
                (Escape::Esc, b'[') => Escape::Csi,
                (Escape::Esc, b']') => Escape::Osc,
                (Escape::Esc | Escape::Csi, 0x40..=0x7e) => Escape::None,
                (Escape::Esc | Escape::Csi, _) => self.escape,
                (Escape::Osc | Escape::OscEsc, 0x07) => Escape::None,
                (Escape::Osc | Escape::OscEsc, 0x1b) => Escape::OscEsc,
                (Escape::OscEsc, b'\\') => Escape::None,
                (Escape::Osc | Escape::OscEsc, _) => Escape::Osc,
            };
        }
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
        && data
            .iter()
            .any(|&b| b == b'\r' || (0x20..0x7f).contains(&b))
    {
        Some(AgentState::Working)
    } else {
        None
    }
}

/// A status file's modification time and length, which tell one write from
/// another.
pub type Stamp = (SystemTime, u64);

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

fn unix_ms(time: SystemTime) -> u64 {
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

    /// Answering a prompt that needs input resumes the agent (it reports again
    /// only once the approved step finishes); Esc or Ctrl+C stops it, which it
    /// never reports.
    pub fn on_input(&mut self, data: &[u8], now: u64) {
        self.last_input_ms = Some(now);
        let Some(effect) = input_effect(data) else {
            return;
        };
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

    /// A window showed the session to the user.
    pub fn on_seen(&mut self, now: u64) {
        self.status.seen_ms = Some(now);
    }

    pub fn on_output(&mut self, data: &[u8], now: u64) {
        if self
            .last_input_ms
            .is_none_or(|t| now.saturating_sub(t) > ECHO_MS)
        {
            self.status.last_output_ms = Some(now);
        }
        if !self.service {
            return;
        }
        let mut lines = Vec::new();
        self.lines.feed(data, |line| lines.push(line.to_owned()));
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

    /// Recompute time-dependent fields.
    fn refresh(&mut self, now: u64) {
        self.status.active = self
            .status
            .last_output_ms
            .is_some_and(|t| now.saturating_sub(t) <= ACTIVE_MS);
        let stale = self.quiet_ms(now) > STALE_WORKING_MS;
        let last_heard = self.last_heard();
        self.status.agent = self.report.clone().map(|mut r| {
            if r.state == AgentState::Working && stale {
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

/// Settings for `claude --settings` whose hooks report its state to
/// `$PATCHBAY_STATUS_FILE`. Each hook passes its stdin along as the report's
/// JSON, and always succeeds so it never blocks the agent.
#[must_use]
pub fn claude_hooks_settings() -> String {
    let hook = |word: &str| {
        serde_json::json!([{
            "hooks": [{
                "type": "command",
                "command": format!(
                    "f=\"${STATUS_ENV}\"; [ -n \"$f\" ] && {{ printf '{word}\\n'; cat; }} > \"$f.$$\" && mv -f \"$f.$$\" \"$f\"; true"
                ),
            }]
        }])
    };
    serde_json::json!({
        "hooks": {
            "SessionStart": hook("idle"),
            "UserPromptSubmit": hook("working"),
            "PostToolUse": hook("working"),
            "Notification": hook("notify"),
            "Stop": hook("review"),
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn hooks_settings_are_valid_json() {
        let settings: serde_json::Value = serde_json::from_str(&claude_hooks_settings()).unwrap();
        let command = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(command.contains("printf 'review\\n'"), "{command}");
        assert!(command.contains("$PATCHBAY_STATUS_FILE"), "{command}");
    }

    #[cfg(unix)]
    #[test]
    fn hook_command_writes_the_status_file() {
        let settings: serde_json::Value = serde_json::from_str(&claude_hooks_settings()).unwrap();
        let command = settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        let file = std::env::temp_dir().join(format!("patchbay-hook-{}", std::process::id()));
        let mut child = std::process::Command::new("sh")
            .args(["-c", command])
            .env(STATUS_ENV, &file)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), b"{\"prompt\":\"hi\"}").unwrap();
        assert!(child.wait().unwrap().success());
        let text = std::fs::read_to_string(&file).unwrap();
        let _ = std::fs::remove_file(&file);
        let report = parse_report(&text).unwrap();
        assert_eq!(report.state, AgentState::Working);
        assert_eq!(report.prompt.as_deref(), Some("hi"));
        // Without the env var it does nothing and still succeeds.
        let status = std::process::Command::new("sh")
            .args(["-c", command])
            .env_remove(STATUS_ENV)
            .stdin(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
}
