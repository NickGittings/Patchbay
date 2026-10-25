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
    /// The provider implied by a launch command, including env/assignment prefixes and wrappers.
    #[must_use]
    pub fn default_for(command: &str) -> Option<Self> {
        crate::context::command_provider(command)
    }
    /// The conversation id in the resume hint a provider prints as it exits.
    /// Callers pass only the tail of a finished run's output, and only UUIDs (the
    /// form both providers use) count, so ids quoted in files or docs earlier in
    /// the run aren't mistaken for the session's own.
    #[must_use]
    pub fn capture(self, text: &str) -> Option<String> {
        let prefix = match self {
            Self::Claude => "claude --resume ",
            Self::Codex => "codex resume ",
        };
        let (_, suffix) = text.rsplit_once(prefix)?;
        let id = suffix
            .split(|c: char| !c.is_ascii_hexdigit() && c != '-')
            .next()?;
        is_uuid(id).then(|| id.to_ascii_lowercase())
    }
    /// The command that resumes conversation `id` with the options of `command`.
    ///
    /// # Errors
    /// Fails if the id is invalid, `cwd` is missing, the command isn't a plain
    /// provider command, already resumes, or the provider has no history for `id`.
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
        let (program_index, program_range) =
            crate::context::launch_program(command).context("Cannot locate provider executable")?;
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
        // Codex -c is configuration and -p selects a profile; both are launch options.
        for word in words.iter().skip(program_index + 1) {
            let flag = word.split('=').next().unwrap_or(word);
            if forbidden.contains(&flag) && !(self == Self::Codex && ["-c", "-p"].contains(&flag)) {
                bail!("Remove existing resume/continue/print options before resuming");
            }
        }
        anyhow::ensure!(
            Self::has_history(history, id),
            "Provider history for {id} is missing; restore it or set the correct conversation ID"
        );
        let (program, options) = command.split_at(program_range.end);
        let mut result = program.to_string();
        result.push_str(match self {
            Self::Claude => " --resume ",
            Self::Codex => " resume ",
        });
        result.push_str(&crate::context::quote_argument(id));
        // Preserve the original shell syntax, including quoted environment variables.
        result.push_str(options);
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
///
/// # Errors
/// Fails if the command can't be parsed or its program isn't on the login shell's PATH.
pub fn require_executable(
    command: &str,
    cwd: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let words = crate::context::launch_words(command).context("Invalid provider command")?;
    let (index, _range) =
        crate::context::launch_program(command).context("Missing provider executable")?;
    let program = &words[index];
    #[cfg(unix)]
    let mut probe = {
        let mut shell =
            std::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        // Keep assignments active for executable paths containing shell variables, too.
        let probe = format!("command -v {}", &command[_range.clone()]);
        shell.args([
            "-ilc",
            &format!(
                "{} /bin/sh -c {}",
                &command[.._range.start],
                crate::context::quote_argument(&probe)
            ),
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

fn is_uuid(id: &str) -> bool {
    let groups: Vec<_> = id.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// Whether a user-supplied conversation id is safe to pass on a command line.
#[must_use]
pub fn valid_id(id: &str) -> bool {
    id.len() >= 8 && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_only_explicit_resume_ids() {
        let id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
        assert_eq!(
            Adapter::Codex.capture(&format!(
                "To continue this session, run codex resume {id}\r\n"
            )),
            Some(id.into())
        );
        assert!(
            Adapter::Codex
                .capture("To continue this session, run codex resume 12345678-abcd")
                .is_none()
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
    fn recognises_providers_and_their_resume_hints() {
        assert_eq!(Adapter::default_for("claude"), Some(Adapter::Claude));
        assert_eq!(
            Adapter::default_for("/usr/local/bin/codex --model x"),
            Some(Adapter::Codex)
        );
        assert_eq!(Adapter::default_for("claude-dev"), None);
        assert_eq!(Adapter::default_for(""), None);

        let first = "11111111-2222-3333-4444-555555555555";
        let last = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
        // The last hint wins, lowercased, and trailing punctuation isn't part of it.
        let output = format!("claude --resume {first}\n...\nclaude --resume {last}.\n");
        assert_eq!(
            Adapter::Claude.capture(&output),
            Some(last.to_ascii_lowercase())
        );
        // Each provider reads only its own hint.
        assert!(Adapter::Codex.capture(&output).is_none());
    }

    #[test]
    fn ids_are_bounded_and_command_line_safe() {
        assert!(valid_id("abcdef12"));
        assert!(valid_id(&"a".repeat(128)));
        assert!(!valid_id("abc1234"));
        assert!(!valid_id(&"a".repeat(129)));
        assert!(!valid_id("abcdef12 --print"));
        assert!(is_uuid("12345678-abcd-4321-aaaa-123456789abc"));
        assert!(!is_uuid("12345678-abcd-4321-aaaa-123456789ab"));
        assert!(!is_uuid("1234567g-abcd-4321-aaaa-123456789abc"));
    }

    #[test]
    fn resume_needs_the_matching_provider_and_nearby_history() {
        let fixture = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = "12345678-abcd-4321-aaaa-123456789abc";
        // Deeper than the lookup goes, so it isn't found.
        let deep = fixture.join("1/2/3/4/5/6");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join(format!("{id}.jsonl")), "{}").unwrap();
        assert!(!Adapter::has_history(&fixture, id));
        std::fs::write(fixture.join("1").join(format!("{id}.jsonl")), "{}").unwrap();
        assert!(Adapter::has_history(&fixture, id));
        assert!(!Adapter::has_history(&fixture, "12345678"));

        assert!(
            Adapter::Claude
                .resume_with_history("codex", id, &fixture, &fixture)
                .is_err()
        );
        assert!(
            Adapter::Claude
                .resume_with_history("claude", "bad id", &fixture, &fixture)
                .is_err()
        );
        assert!(
            Adapter::Claude
                .resume_with_history("claude", id, &fixture, &fixture)
                .is_ok()
        );
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn resume_preserves_prefixes_wrappers_and_quoted_options() {
        let fixture = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&fixture).unwrap();
        let id = "12345678-abcd-4321-aaaa-123456789abc";
        std::fs::write(fixture.join(format!("{id}.jsonl")), "{}").unwrap();
        for (provider, program, options, flag) in [
            (Adapter::Claude, "FOO=1 claude", " --model opus", "--resume"),
            (
                Adapter::Claude,
                "env FOO='one two' claude",
                " --model \"$MODEL\"",
                "--resume",
            ),
            (
                Adapter::Claude,
                "~/bin/claude.sh",
                " --model opus",
                "--resume",
            ),
            (Adapter::Codex, "codex.ps1", " -p fast", "resume"),
            (
                Adapter::Codex,
                " env A=1 B=two '/my tools/codex'",
                " -c 'key=value'",
                "resume",
            ),
        ] {
            let command = format!("{program}{options}");
            assert_eq!(Adapter::default_for(&command), Some(provider));
            assert_eq!(
                provider
                    .resume_with_history(&command, id, &fixture, &fixture)
                    .unwrap(),
                format!(
                    "{program} {flag} {}{options}",
                    crate::context::quote_argument(id)
                )
            );
            assert!(
                provider
                    .resume_with_history(&format!("{program} --resume old"), id, &fixture, &fixture)
                    .is_err()
            );
        }
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn executable_probe_checks_the_program_after_assignments_and_env() {
        for command in ["FOO=1 sh", "env FOO='one two' sh", "env FOO=1 /bin/sh"] {
            require_executable(command, Path::new("/tmp"), &Default::default()).unwrap();
        }
        for command in [
            "FOO=1 patchbay-missing-provider",
            "env FOO=1 patchbay-missing-provider",
        ] {
            assert!(require_executable(command, Path::new("/tmp"), &Default::default()).is_err());
        }
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
        assert!(
            Adapter::Claude
                .resume_with_history("claude --resume=87654321", id, &fixture, &history)
                .is_err()
        );
        let command = "codex --model \"$MODEL\" -p fixture";
        let resumed = Adapter::Codex
            .resume_with_history(command, id, &fixture, &history)
            .unwrap();
        assert!(resumed.ends_with(" --model \"$MODEL\" -p fixture"));
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
