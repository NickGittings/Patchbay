//! Exercise the real status-line executable without changing provider settings.
use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "patchbay-usage-reporter-{}-{}-{}",
            std::process::id(),
            patchbay_core::pty::now_ms(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn run(&self, payload: &str) -> std::process::Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_patchbay-sessiond"))
            .arg("status-line")
            .env("PATCHBAY_STATE_DIR", &self.0)
            .env("CLAUDE_CONFIG_DIR", self.0.join("claude"))
            .env("SHELL", "/bin/sh")
            .env(
                patchbay_core::agent_hooks::JOURNAL_ENV,
                self.0.join("journal"),
            )
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
    #[cfg(unix)]
    fn chain(&self, command: &str) {
        std::fs::create_dir_all(self.0.join("usage")).unwrap();
        std::fs::write(
            self.0.join("usage/statusline-chain.json"),
            serde_json::to_vec(&json!({
                "source":self.0.join("claude/settings.json"),
                "statusLine":{"type":"command","command":command}
            }))
            .unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn status_line_captures_without_journals_and_always_exits_successfully() {
    let fixture = Fixture::new();
    let payload = json!({"rate_limits":{
        "five_hour":{"used_percentage":23,"resets_at":patchbay_core::pty::now_ms()/1000+3600},
        "seven_day":{"used_percentage":41,"resets_at":patchbay_core::pty::now_ms()/1000+7200}
    }})
    .to_string();
    let output = fixture.run(&payload);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "5h 23% · 7d 41%"
    );
    let captured: patchbay_core::usage::ProviderUsage =
        serde_json::from_slice(&std::fs::read(fixture.0.join("usage/claude.json")).unwrap())
            .unwrap();
    assert_eq!(captured.five_hour.unwrap().used_percent, 23.0);
    assert!(!fixture.0.join("journal").exists());
    for input in ["bad JSON", "{}"] {
        assert!(fixture.run(input).status.success());
    }
}

#[cfg(unix)]
#[test]
fn chained_status_line_gets_exact_stdin_and_failure_or_timeout_is_harmless() {
    let fixture = Fixture::new();
    fixture.chain("cat");
    let output = fixture.run("{\"other\":true}\n");
    assert!(output.status.success());
    assert_eq!(output.stdout, b"{\"other\":true}\n");
    // A failing, silent or slow chain leaves Patchbay's own line in its place.
    fixture.chain("exit 1");
    let output = fixture.run("{}");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Usage unavailable"
    );
    fixture.chain("exec sleep 10");
    let start = Instant::now();
    let output = fixture.run("{}");
    assert!(output.status.success());
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Usage unavailable"
    );
}

#[cfg(unix)]
#[test]
fn a_chained_reporter_never_chains_again() {
    let fixture = Fixture::new();
    let reporter = env!("CARGO_BIN_EXE_patchbay-sessiond");
    // A recognisable reporter command is never chained at all.
    fixture.chain(&format!("'{reporter}' status-line"));
    assert_eq!(
        String::from_utf8_lossy(&fixture.run("{}").stdout).trim(),
        "Usage unavailable"
    );
    // One hidden behind a script still runs, but only reports instead of chaining to itself.
    let script = fixture.0.join("rerun.sh");
    std::fs::write(&script, format!("'{reporter}' status-line\necho chained\n")).unwrap();
    fixture.chain(&format!("sh '{}'", script.display()));
    let start = Instant::now();
    let output = fixture.run("{}");
    assert!(output.status.success());
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Usage unavailable\nchained"
    );
}

#[cfg(unix)]
#[test]
fn a_background_child_holding_the_output_neither_delays_nor_hides_the_line() {
    let fixture = Fixture::new();
    fixture.chain("echo chained; sleep 10 &");
    let start = Instant::now();
    let output = fixture.run("{}");
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "chained");
}

#[cfg(unix)]
#[test]
fn the_installed_usage_folder_wins_over_the_environment() {
    let fixture = Fixture::new();
    fixture.chain("echo chained");
    // Claude's environment points elsewhere; the folder named in the command still holds the chain.
    let elsewhere = Fixture::new();
    let mut child = Command::new(env!("CARGO_BIN_EXE_patchbay-sessiond"))
        .arg("status-line")
        .arg(fixture.0.join("usage"))
        .env("PATCHBAY_STATE_DIR", &elsewhere.0)
        .env("CLAUDE_CONFIG_DIR", elsewhere.0.join("claude"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "chained");
}
