//! Keeping a checkout's current branch in sync with its remote: how far it is
//! ahead of or behind its upstream, and fetch, fast-forward pull, and push.
//!
//! Network commands never prompt. Credentials come from the user's own Git
//! setup (a credential helper such as `gh auth setup-git`, or SSH keys), and a
//! command that would ask for them fails with a message saying so.

use crate::branches::ensure_no_operation;
use crate::git::{common_dir, git, run};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// How long a fetch or push may run before it is stopped.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// The current branch and how it compares with its upstream.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// The checked-out branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The remote-tracking branch, such as `origin/main`.
    pub upstream: Option<String>,
    /// The remote that fetch and push use: the upstream's remote, otherwise
    /// `origin`, otherwise the only remote.
    pub remote: Option<String>,
    /// Commits on the branch that the upstream does not have.
    pub ahead: u32,
    /// Commits on the upstream that the branch does not have.
    pub behind: u32,
    /// When the repository last fetched, in Unix milliseconds.
    pub last_fetch_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Fetch,
    Pull,
    Push,
}

/// The current branch of `repo` compared with its upstream, from local refs
/// only. Counts are as fresh as the last fetch.
///
/// # Errors
/// Fails when `repo` is not a Git checkout.
pub fn sync_status(repo: &Path) -> Result<SyncStatus> {
    run(git(repo).args(["rev-parse", "--git-dir"]))?;
    let branch = run(git(repo).args(["symbolic-ref", "-q", "--short", "HEAD"]))
        .ok()
        .filter(|b| !b.is_empty());
    let tracked = branch.as_deref().and_then(|b| tracked_remote(repo, b));
    let upstream = tracked
        .as_ref()
        .and_then(|_| {
            run(git(repo).args([
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ]))
            .ok()
        })
        .filter(|u| !u.is_empty());
    let (ahead, behind) = if upstream.is_some() {
        counts(&run(git(repo).args([
            "rev-list",
            "--left-right",
            "--count",
            "HEAD...@{upstream}",
        ]))?)
    } else {
        (0, 0)
    };
    let remote = match upstream {
        Some(_) => tracked,
        None => default_remote(repo),
    };
    Ok(SyncStatus {
        branch,
        upstream,
        remote,
        ahead,
        behind,
        last_fetch_ms: last_fetch(repo),
    })
}

/// Fetch from the remote, fast-forward to the upstream, or push the branch,
/// then report the new status. Pull never merges or rebases, and push is
/// never forced. Pushing a branch without an upstream publishes it and sets
/// the upstream.
///
/// # Errors
/// Fails without a remote, branch, or upstream the action needs, while a
/// merge or rebase is in progress (pull), when the branch has diverged
/// (pull) or the remote has newer commits (push), when the remote rejects
/// the credentials, and on other Git errors.
pub fn sync(repo: &Path, action: SyncAction) -> Result<SyncStatus> {
    let status = sync_status(repo)?;
    match action {
        SyncAction::Fetch => {
            let remote = status
                .remote
                .as_deref()
                .context("No remote is configured")?;
            fetch(repo, remote)?;
        }
        SyncAction::Pull => {
            let branch = status
                .branch
                .as_deref()
                .context("Check out a branch before pulling")?;
            let upstream = status
                .upstream
                .as_deref()
                .with_context(|| format!("{branch} has no upstream to pull from"))?;
            ensure_no_operation(repo)?;
            fetch(repo, status.remote.as_deref().unwrap_or("origin"))?;
            run(git(repo).args(["merge", "--ff-only", "--no-edit", "@{upstream}"])).map_err(
                |e| {
                    let message = e.to_string();
                    if message.contains("Not possible to fast-forward")
                        || message.contains("Diverging branches")
                    {
                        anyhow::anyhow!(
                            "{branch} has diverged from {upstream}; pull can only fast-forward. \
                             Merge or rebase it yourself."
                        )
                    } else {
                        e
                    }
                },
            )?;
        }
        SyncAction::Push => {
            let branch = status
                .branch
                .as_deref()
                .context("Check out a branch before pushing")?;
            let remote = status
                .remote
                .as_deref()
                .context("No remote is configured")?;
            if status.upstream.is_some() {
                let target =
                    run(git(repo).args(["config", "--get", &format!("branch.{branch}.merge")]))
                        .ok()
                        .filter(|t| t.starts_with("refs/heads/"))
                        .context("The upstream branch is not a remote branch")?;
                network(repo, &["push", "--", remote, &format!("HEAD:{target}")])
                    .map_err(|e| push_error(e, remote))?;
            } else {
                network(
                    repo,
                    &[
                        "push",
                        "--set-upstream",
                        "--",
                        remote,
                        &format!("HEAD:refs/heads/{branch}"),
                    ],
                )
                .map_err(|e| push_error(e, remote))?;
            }
        }
    }
    sync_status(repo)
}

fn fetch(repo: &Path, remote: &str) -> Result<()> {
    network(repo, &["fetch", "--prune", "--", remote])?;
    Ok(())
}

/// The remote a branch tracks, when it tracks a remote rather than a local branch.
fn tracked_remote(repo: &Path, branch: &str) -> Option<String> {
    run(git(repo).args(["config", "--get", &format!("branch.{branch}.remote")]))
        .ok()
        .filter(|r| !r.is_empty() && r != "." && !r.starts_with('-'))
}

fn default_remote(repo: &Path) -> Option<String> {
    let out = run(git(repo).arg("remote")).ok()?;
    let remotes: Vec<_> = out.lines().filter(|r| !r.starts_with('-')).collect();
    if remotes.contains(&"origin") {
        return Some("origin".into());
    }
    match remotes.as_slice() {
        [only] => Some((*only).to_string()),
        _ => None,
    }
}

fn counts(out: &str) -> (u32, u32) {
    let mut parts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

fn last_fetch(repo: &Path) -> Option<u64> {
    let modified = common_dir(repo)
        .ok()?
        .join("FETCH_HEAD")
        .metadata()
        .ok()?
        .modified()
        .ok()?;
    u64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// Run a Git command that talks to a remote. It cannot prompt for
/// credentials, and it is stopped after [`NETWORK_TIMEOUT`].
fn network(repo: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = git(repo);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let custom_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || run(git(repo).args(["config", "--get", "core.sshCommand"])).is_ok();
    if !custom_ssh {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let mut child = cmd.spawn().context("running git")?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let success = wait(&mut child, NETWORK_TIMEOUT)?;
    // A killed Git can leave a helper holding the pipes open, so read only after exit.
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if !success {
        bail!(network_error(stderr.trim()));
    }
    Ok(stdout.trim().to_string())
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    })
}

fn wait(child: &mut Child, timeout: Duration) -> Result<bool> {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "Git did not finish within {} seconds; check the network connection",
                timeout.as_secs()
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn network_error(stderr: &str) -> String {
    const AUTH: [&str; 6] = [
        "could not read Username",
        "could not read Password",
        "terminal prompts disabled",
        "Authentication failed",
        "Permission denied (publickey",
        "Host key verification failed",
    ];
    if AUTH.iter().any(|m| stderr.contains(m)) {
        return "The remote rejected the credentials, or Git needed to ask for them. \
                For GitHub over HTTPS run `gh auth setup-git`; for SSH, add your key to ssh-agent."
            .into();
    }
    if stderr.is_empty() {
        "git failed".into()
    } else {
        stderr.into()
    }
}

fn push_error(e: anyhow::Error, remote: &str) -> anyhow::Error {
    let message = e.to_string();
    if message.contains("[rejected]")
        || message.contains("non-fast-forward")
        || message.contains("fetch first")
    {
        anyhow::anyhow!("{remote} has commits this branch does not; pull first")
    } else {
        e
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::{env, fs, process};

    struct Fixture(PathBuf);

    impl Fixture {
        /// A bare `origin` with one commit on `main`, and a clone of it at `a`.
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = env::temp_dir().join(format!(
                "patchbay-remote-{}-{}",
                process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let fixture = Self(dir.canonicalize().unwrap());
            fixture.git(".", &["init", "-q", "--bare", "-b", "main", "origin.git"]);
            fixture.git(".", &["clone", "-q", "origin.git", "a"]);
            fixture.git("a", &["symbolic-ref", "HEAD", "refs/heads/main"]);
            fixture.commit("a", "init");
            fixture.git("a", &["push", "-q", "-u", "origin", "main"]);
            fixture
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn git(&self, rel: &str, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(self.path(rel))
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "init.defaultBranch=main",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn commit(&self, rel: &str, name: &str) {
            fs::write(self.path(rel).join(name), name).unwrap();
            self.git(rel, &["add", "."]);
            self.git(rel, &["commit", "-qm", name]);
        }

        fn clone_b(&self) {
            self.git(".", &["clone", "-q", "origin.git", "b"]);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn status_counts_commits_ahead_of_upstream() {
        let f = Fixture::new();
        let status = sync_status(&f.path("a")).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.remote.as_deref(), Some("origin"));
        assert_eq!((status.ahead, status.behind), (0, 0));
        f.commit("a", "two");
        assert_eq!(sync_status(&f.path("a")).unwrap().ahead, 1);
    }

    #[test]
    fn push_sends_commits_and_fetch_sees_them_from_another_clone() {
        let f = Fixture::new();
        f.clone_b();
        f.commit("a", "two");
        let pushed = sync(&f.path("a"), SyncAction::Push).unwrap();
        assert_eq!((pushed.ahead, pushed.behind), (0, 0));
        assert_eq!(sync_status(&f.path("b")).unwrap().behind, 0);
        let fetched = sync(&f.path("b"), SyncAction::Fetch).unwrap();
        assert_eq!((fetched.ahead, fetched.behind), (0, 1));
        assert!(fetched.last_fetch_ms.is_some());
        let pulled = sync(&f.path("b"), SyncAction::Pull).unwrap();
        assert_eq!((pulled.ahead, pulled.behind), (0, 0));
        assert!(f.path("b/two").exists());
    }

    #[test]
    fn pull_refuses_to_merge_a_diverged_branch() {
        let f = Fixture::new();
        f.clone_b();
        f.commit("a", "two");
        sync(&f.path("a"), SyncAction::Push).unwrap();
        f.commit("b", "other");
        let error = sync(&f.path("b"), SyncAction::Pull)
            .unwrap_err()
            .to_string();
        assert!(error.contains("diverged"), "{error}");
        assert_eq!(f.git("b", &["rev-list", "--count", "HEAD"]), "2");
        let status = sync_status(&f.path("b")).unwrap();
        assert_eq!((status.ahead, status.behind), (1, 1));
    }

    #[test]
    fn push_is_rejected_when_the_remote_has_new_commits() {
        let f = Fixture::new();
        f.clone_b();
        f.commit("a", "two");
        sync(&f.path("a"), SyncAction::Push).unwrap();
        f.commit("b", "other");
        let error = sync(&f.path("b"), SyncAction::Push)
            .unwrap_err()
            .to_string();
        assert!(error.contains("pull first"), "{error}");
    }

    #[test]
    fn pushing_a_new_branch_publishes_it_and_sets_its_upstream() {
        let f = Fixture::new();
        f.git("a", &["switch", "-q", "-c", "feature/x"]);
        let before = sync_status(&f.path("a")).unwrap();
        assert_eq!(before.upstream, None);
        assert_eq!(before.remote.as_deref(), Some("origin"));
        let error = sync(&f.path("a"), SyncAction::Pull)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no upstream"), "{error}");
        let after = sync(&f.path("a"), SyncAction::Push).unwrap();
        assert_eq!(after.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!(
            f.git("origin.git", &["rev-parse", "feature/x"]),
            f.git("a", &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn detached_head_and_missing_remote_are_refused() {
        let f = Fixture::new();
        f.git("a", &["switch", "-q", "--detach"]);
        let status = sync_status(&f.path("a")).unwrap();
        assert_eq!(status.branch, None);
        assert!(sync(&f.path("a"), SyncAction::Push).is_err());
        f.git("a", &["switch", "-q", "main"]);
        f.git("a", &["remote", "remove", "origin"]);
        let error = sync(&f.path("a"), SyncAction::Fetch)
            .unwrap_err()
            .to_string();
        assert!(error.contains("No remote"), "{error}");
    }

    #[test]
    fn pull_waits_for_an_active_merge_to_finish() {
        let f = Fixture::new();
        f.commit("a", "two");
        let head = f.git("a", &["rev-parse", "HEAD"]);
        let marker = f.git("a", &["rev-parse", "--git-path", "MERGE_HEAD"]);
        fs::write(f.path("a").join(marker), head).unwrap();
        let error = sync(&f.path("a"), SyncAction::Pull)
            .unwrap_err()
            .to_string();
        assert!(error.contains("active Git operation"), "{error}");
    }

    #[test]
    fn credential_failures_explain_how_to_sign_in() {
        let message = network_error(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        );
        assert!(message.contains("gh auth setup-git"));
        assert_eq!(network_error("fatal: boom"), "fatal: boom");
    }
}
