//! Explicit conversation adapters. Provider identities never double as PTY identities.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Adapter {
    Claude,
    Codex,
}
impl Adapter {
    pub fn default_for(command: &str) -> Option<Self> {
        let words = crate::context::launch_words(command)?;
        match Path::new(words.first()?).file_stem()?.to_str()? {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
    pub fn capture(self, text: &str) -> Option<String> {
        // Only provider instructions containing the explicit resume invocation count.
        let prefix = match self {
            Self::Claude => "claude --resume ",
            Self::Codex => "codex resume ",
        };
        let (_, suffix) = text.rsplit_once(prefix)?;
        let id = suffix
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .next()?;
        valid_id(id).then(|| id.to_string())
    }
    pub fn resume(self, command: &str, id: &str, cwd: &Path) -> Result<String> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("No home directory"))?;
        let history = match self {
            Self::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"))
                .join("projects"),
            Self::Codex => std::env::var_os("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("sessions"),
        };
        self.resume_with_history(command, id, cwd, &history)
    }
    fn resume_with_history(
        self,
        command: &str,
        id: &str,
        cwd: &Path,
        history: &Path,
    ) -> Result<String> {
        anyhow::ensure!(
            valid_id(id),
            "Set an exact provider conversation ID before resuming"
        );
        anyhow::ensure!(cwd.is_dir(), "Recorded working directory is missing");
        let words = crate::context::launch_words(command).ok_or_else(|| {
            anyhow::anyhow!("Cannot safely preserve this launch command's options")
        })?;
        if Self::default_for(command) != Some(self) {
            bail!(
                "Custom commands need a direct provider command to resume with preserved options"
            );
        }
        let forbidden = [
            "resume",
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--last",
            "exec",
            "-p",
            "--print",
            "--session-id",
        ];
        // Codex -c is a configuration option injected by Patchbay; it is valid.
        for word in words.iter().skip(1) {
            if forbidden.contains(&word.as_str()) && !(self == Self::Codex && word == "-c") {
                bail!("Remove existing resume/continue/print options before resuming");
            }
        }
        anyhow::ensure!(
            Self::has_history(history, id),
            "Provider history for {id} is missing; restore it or set the correct conversation ID"
        );
        let mut result = crate::context::quote_argument(&words[0]);
        result.push_str(match self {
            Self::Claude => " --resume ",
            Self::Codex => " resume ",
        });
        result.push_str(&crate::context::quote_argument(id));
        for word in words.iter().skip(1) {
            result.push(' ');
            result.push_str(&crate::context::quote_argument(word));
        }
        Ok(result)
    }
    fn has_history(root: &Path, id: &str) -> bool {
        fn contains(dir: &Path, id: &str, depth: usize) -> bool {
            if depth == 0 {
                return false;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return false;
            };
            entries.flatten().any(|entry| {
                let Ok(kind) = entry.file_type() else {
                    return false;
                };
                if kind.is_dir() {
                    return contains(&entry.path(), id, depth - 1);
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                kind.is_file()
                    && (name == format!("{id}.jsonl") || name.ends_with(&format!("-{id}.jsonl")))
            })
        }
        // Lookup only the exact id. Never infer a conversation from directory recency.
        contains(root, id, 6)
    }
}
/// Probe the same login-shell PATH before creating a resumed process incarnation.
pub fn require_executable(
    command: &str,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let words = crate::context::launch_words(command).context("Invalid provider command")?;
    let program = words.first().context("Missing provider executable")?;
    #[cfg(unix)]
    let mut probe = {
        let mut shell =
            std::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        shell.args([
            "-ilc",
            &format!("command -v {}", crate::context::quote_argument(program)),
        ]);
        shell
    };
    #[cfg(windows)]
    let mut probe = {
        let mut probe = std::process::Command::new("where.exe");
        probe.arg(program);
        probe
    };
    let status = probe
        .current_dir(cwd)
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    anyhow::ensure!(
        status.success(),
        "Provider executable {program} is missing; install it or correct the recorded command before resuming"
    );
    Ok(())
}

pub fn valid_id(id: &str) -> bool {
    id.len() >= 8 && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_only_explicit_resume_ids() {
        assert_eq!(
            Adapter::Codex.capture("To continue this session, run codex resume 12345678-abcd"),
            Some("12345678-abcd".into())
        );
        assert!(
            Adapter::Claude
                .capture("most recent session: 12345678")
                .is_none()
        );
        assert!(Adapter::default_for("echo codex").is_none());
        assert!(!valid_id("id; rm -rf"));
    }
    #[test]
    fn resume_preserves_context_and_requires_exact_history() {
        let fixture = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let history = fixture.join("sessions/2026/10/04");
        std::fs::create_dir_all(&history).unwrap();
        let id = "12345678-abcd-4321-aaaa-123456789abc";
        std::fs::write(history.join(format!("rollout-2026-{id}.jsonl")), "{}").unwrap();
        std::fs::write(history.join("newest-unrelated.jsonl"), "{}").unwrap();
        let command = "codex --model gpt-test -c 'developer_instructions=\"Patchbay context\"'";
        let resumed = Adapter::Codex
            .resume_with_history(command, id, &fixture, &fixture.join("sessions"))
            .unwrap();
        let words = crate::context::launch_words(&resumed).unwrap();
        assert_eq!(&words[..3], &["codex", "resume", id]);
        assert_eq!(
            &words[3..],
            &crate::context::launch_words(command).unwrap()[1..]
        );
        assert!(
            Adapter::Codex
                .resume_with_history(command, "87654321-missing", &fixture, &history)
                .is_err()
        );
        assert!(
            Adapter::Codex
                .resume_with_history("codex --last", id, &fixture, &history)
                .is_err()
        );
        assert!(
            Adapter::Codex
                .resume_with_history("echo hi && codex", id, &fixture, &history)
                .is_err()
        );
        assert!(
            Adapter::Codex
                .resume_with_history(command, id, &fixture.join("missing"), &history)
                .is_err()
        );
        std::fs::write(history.join(format!("{id}.jsonl")), "{}").unwrap();
        let command = "claude --model sonnet --append-system-prompt 'Patchbay context'";
        let resumed = Adapter::Claude
            .resume_with_history(command, id, &fixture, &history)
            .unwrap();
        let words = crate::context::launch_words(&resumed).unwrap();
        assert_eq!(&words[..3], &["claude", "--resume", id]);
        assert_eq!(
            &words[3..],
            &crate::context::launch_words(command).unwrap()[1..]
        );
        assert!(
            Adapter::Claude
                .resume_with_history("claude --continue", id, &fixture, &history)
                .is_err()
        );
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
