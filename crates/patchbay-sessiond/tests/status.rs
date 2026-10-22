//! Exercise the packaged reporter as a separate process, including its inherited environment.
use patchbay_core::adapters::Adapter;
use patchbay_core::agent_hooks::{
    GENERATION_ENV, HookEvent, JOURNAL_ENV, PROVIDER_ENV, SESSION_ENV,
};
use patchbay_core::pty::{PtyManager, SessionSpec};
use patchbay_core::status::AgentState;
use patchbay_core::{EventSink, TerminalEvent};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "patchbay-reporter-{}-{}-{:?}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(provider: &str, payload: &str, env: &[(String, String)]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_patchbay-sessiond"));
    command
        .args(["report-status", provider])
        .env_clear()
        .envs(env.iter().cloned());
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
fn assert_silent(output: &std::process::Output) {
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
#[test]
fn reporter_is_silent_inert_outside_patchbay_and_orders_all_reports() {
    let fixture = Fixture::new();
    let payload = r#"{"hook_event_name":"UserPromptSubmit","session_id":"12345678-conversation","turn_id":"12345678-turn","prompt":"hello"}"#;
    assert_silent(&run("codex", payload, &[]));
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    let env = vec![
        (SESSION_ENV.into(), "origin-session".into()),
        (GENERATION_ENV.into(), "42".into()),
        (PROVIDER_ENV.into(), "codex".into()),
        (JOURNAL_ENV.into(), fixture.0.display().to_string()),
    ];
    assert_silent(&run("claude", payload, &env)); // A different provider cannot report this session.
    assert_silent(&run("codex", "malformed", &env));
    let subagent = payload.replace("\"prompt\":", "\"agent_id\":\"child\",\"prompt\":");
    assert_silent(&run("codex", &subagent, &env));
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
    for event in [
        "UserPromptSubmit",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
        "Interrupt",
        "SessionEnd",
    ] {
        assert_silent(&run(
            "codex",
            &payload.replace("UserPromptSubmit", event),
            &env,
        ));
    }
    for sequence in 1..=6 {
        let event: HookEvent = serde_json::from_slice(
            &std::fs::read(fixture.0.join(format!("{sequence:020}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(event.session, "origin-session");
        assert_eq!(event.generation, 42);
        assert_eq!(event.sequence, sequence);
        assert_eq!(event.provider, Adapter::Codex);
    }
    let mut claude_env = env.clone();
    claude_env[2].1 = "claude".into();
    let payload = payload.replace("turn_id", "prompt_id");
    assert_silent(&run("claude", &payload, &claude_env));
    let event: HookEvent = serde_json::from_slice(
        &std::fs::read(fixture.0.join("00000000000000000007.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(event.provider, Adapter::Claude);
}

#[derive(Default)]
struct Sink(Mutex<Vec<TerminalEvent>>);
impl EventSink for Sink {
    fn emit(&self, event: TerminalEvent) {
        self.0.lock().unwrap().push(event);
    }
}
fn wait_for(manager: &PtyManager, state: AgentState) {
    // Approval detection includes a quiet window and a journal polling interval;
    // allow scheduling headroom when the suite runs in parallel.
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if manager.snapshot("origin-session").is_some_and(|s| {
            s.status
                .agent
                .as_ref()
                .is_some_and(|a| a.state == state && a.authoritative)
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("status did not reach {state:?}");
}
#[cfg(unix)]
#[test]
fn pty_journal_delivers_native_reports_and_rejects_spoofed_launch_transport() {
    let fixture = Fixture::new();
    let manager = Arc::new(PtyManager::default());
    let sink = Arc::new(Sink::default());
    // The fixture shell prints its native reporting directory into a file for the test harness.
    let directory_file = fixture.0.join("directory");
    let quote = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    manager
        .spawn(
            SessionSpec {
                resume_command: None,
                rerun_on_resume: false,
                owns_briefing: false,
                exclusive_cwd: false,
                merge_source: None,
                id: "origin-session".into(),
                cwd: fixture.0.clone(),
                command: format!(
                    "printf '%s' \"$PATCHBAY_REPORT_DIR\" > {}; sleep 60",
                    quote(&directory_file)
                ),
                env: BTreeMap::from([
                    (PROVIDER_ENV.into(), "codex".into()),
                    (GENERATION_ENV.into(), "999".into()),
                    (SESSION_ENV.into(), "wrong-session".into()),
                    (JOURNAL_ENV.into(), "/tmp/wrong-directory".into()),
                ]),
                ready_when: String::new(),
                service: false,
                notice: None,
                dirs: Vec::new(),
            },
            sink.clone(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !directory_file.is_file() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let dir = std::fs::read_to_string(directory_file).unwrap();
    assert_ne!(dir, "/tmp/wrong-directory");
    let generation = manager.snapshot("origin-session").unwrap().generation;
    let env = vec![
        (SESSION_ENV.into(), "origin-session".into()),
        (GENERATION_ENV.into(), generation.to_string()),
        (PROVIDER_ENV.into(), "codex".into()),
        (JOURNAL_ENV.into(), dir),
    ];
    let payload = r#"{"hook_event_name":"UserPromptSubmit","session_id":"12345678-conversation","turn_id":"12345678-turn","prompt":"hello"}"#;
    assert_silent(&run("codex", payload, &env));
    wait_for(&manager, AgentState::Working);
    assert_silent(&run(
        "codex",
        &payload.replace("UserPromptSubmit", "PermissionRequest"),
        &env,
    ));
    wait_for(&manager, AgentState::NeedsInput);
    assert_silent(&run(
        "codex",
        &payload.replace("UserPromptSubmit", "Stop"),
        &env,
    ));
    wait_for(&manager, AgentState::Review);
    // Exit while a second turn's approval is pending, without a progress or
    // SessionEnd hook. Finalization must not leave a deferred NeedsInput behind.
    let next = payload.replace("12345678-turn", "12345678-next-turn");
    assert_silent(&run("codex", &next, &env));
    wait_for(&manager, AgentState::Working);
    assert_silent(&run(
        "codex",
        &next.replace("UserPromptSubmit", "PermissionRequest"),
        &env,
    ));
    manager.stop("origin-session");
    let deadline = Instant::now() + Duration::from_secs(5);
    while manager.snapshot("origin-session").unwrap().running && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let ended = manager.snapshot("origin-session").unwrap();
    assert!(!ended.running);
    assert_eq!(ended.status.agent.unwrap().state, AgentState::Ended);
    if let Some(TerminalEvent::Status { status, .. }) = manager.mark_seen("origin-session") {
        assert_eq!(status.agent.unwrap().state, AgentState::Ended);
    }
    let events = sink.0.lock().unwrap();
    let exit = events
        .iter()
        .position(|e| matches!(e, TerminalEvent::Exited { .. }))
        .unwrap();
    assert!(
        !events[exit..]
            .iter()
            .any(|e| matches!(e, TerminalEvent::Status { .. }))
    );
}

#[test]
fn concurrent_reporters_commit_unique_ordered_events_under_contention() {
    let fixture = Fixture::new();
    let env = vec![
        (SESSION_ENV.into(), "origin-session".into()),
        (GENERATION_ENV.into(), "42".into()),
        (PROVIDER_ENV.into(), "codex".into()),
        (JOURNAL_ENV.into(), fixture.0.display().to_string()),
    ];
    let threads: Vec<_> = (0..16).map(|index| {
        let env = env.clone();
        std::thread::spawn(move || {
            let payload = format!(r#"{{"hook_event_name":"UserPromptSubmit","session_id":"12345678-conversation","turn_id":"12345678-turn-{index}","prompt":"prompt-{index}"}}"#);
            assert_silent(&run("codex", &payload, &env));
        })
    }).collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let mut prompts = std::collections::HashSet::new();
    for sequence in 1..=16 {
        let event: HookEvent = serde_json::from_slice(
            &std::fs::read(fixture.0.join(format!("{sequence:020}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(event.sequence, sequence);
        prompts.insert(event.prompt.unwrap());
    }
    assert_eq!(prompts.len(), 16);
}
