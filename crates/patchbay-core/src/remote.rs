//! Keeping a checkout's current branch in sync with its remote: how far it is
//! ahead of or behind its upstream, and fetch, fast-forward pull, and push.
//!
//! Network commands never prompt. Credentials come from the user's own Git
//! setup (a credential helper such as `gh auth setup-git`, or SSH keys), and a
//! command that would ask for them fails with a message saying so.

use crate::branches::ensure_no_operation;
use crate::git::{git, run};
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// How long a fetch may run before it is stopped.
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Push and pull also run hooks and checkout filters (Git LFS), which can be slow.
const HOOK_TIMEOUT: Duration = Duration::from_secs(600);
/// How long to keep reading output after Git exits. A helper it started (an
/// SSH connection master) can hold the pipes open long after.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// The current branch and how it compares with its upstream.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// The checked-out branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The remote-tracking branch, such as `origin/main`.
    pub upstream: Option<String>,
    /// The configured upstream, such as `origin/feature`, when its
    /// remote-tracking branch does not exist (pruned, or never fetched).
    pub missing_upstream: Option<String>,
    /// The remote that fetch uses: the configured upstream's remote, otherwise
    /// `origin`, otherwise the only remote.
    pub remote: Option<String>,
    /// Commits on the branch that the upstream does not have.
    pub ahead: u32,
    /// Commits on the upstream that the branch does not have.
    pub behind: u32,
    /// When this checkout last fetched, in Unix milliseconds.
    pub last_fetch_ms: Option<u64>,
    /// Where Push sends the branch, such as `fork/feature`; `None` when it can't.
    pub push_to: Option<String>,
    /// Why Push would be refused.
    pub push_refused: Option<String>,
    /// Commits the push target lacks; `None` when it doesn't exist yet, so
    /// Push publishes the branch.
    pub unpushed: Option<u32>,
    /// Commits on the push target that the branch lacks, so a push would be rejected.
    pub push_behind: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Fetch,
    Pull,
    Push,
}

/// The current branch of `repo` compared with its upstream and its push
/// target, from local refs only. Counts are as fresh as the last fetch.
///
/// # Errors
/// Fails when `repo` is not a Git checkout.
pub fn sync_status(repo: &Path) -> Result<SyncStatus> {
    run(git(repo).args(["rev-parse", "--git-dir"]))?;
    let branch = run(git(repo).args(["symbolic-ref", "-q", "--short", "HEAD"]))
        .ok()
        .filter(|b| !b.is_empty());
    let tracked = branch.as_deref().and_then(|b| tracked_remote(repo, b));
    let merge = branch.as_deref().and_then(|b| merge_ref(repo, b));
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
        counts(repo, "@{upstream}")?
    } else {
        (0, 0)
    };
    let missing_upstream = match (&tracked, &merge, &upstream) {
        (Some(remote), Some(merge), None) => Some(format!(
            "{remote}/{}",
            merge.strip_prefix("refs/heads/").unwrap_or(merge)
        )),
        _ => None,
    };
    let remote = tracked.or_else(|| default_remote(repo));
    let mut status = SyncStatus {
        branch,
        upstream,
        missing_upstream,
        remote,
        ahead,
        behind,
        last_fetch_ms: last_fetch(repo),
        ..SyncStatus::default()
    };
    match push_plan(repo, &status) {
        Ok(plan) => {
            let branch = status.branch.as_deref().unwrap_or_default();
            let target = format!("refs/remotes/{}/{branch}", plan.remote);
            if run(git(repo).args(["rev-parse", "--verify", "-q", &target])).is_ok() {
                let (unpushed, behind) = counts(repo, &target)?;
                status.unpushed = Some(unpushed);
                status.push_behind = behind;
            }
            status.push_to = Some(format!("{}/{branch}", plan.remote));
        }
        Err(reason) => status.push_refused = Some(reason),
    }
    Ok(status)
}

/// Where and how Push sends the current branch.
struct PushPlan {
    remote: String,
    set_upstream: bool,
}

/// Push only updates the remote branch of the same name, on the branch's push
/// remote (`branch.<name>.pushRemote`, `remote.pushDefault`, then the
/// upstream's remote). Like `push.default=simple`, it never moves a remote
/// branch of another name.
fn push_plan(repo: &Path, status: &SyncStatus) -> std::result::Result<PushPlan, String> {
    let branch = status
        .branch
        .as_deref()
        .ok_or("Check out a branch to push")?;
    if let Some(missing) = &status.missing_upstream {
        return Err(format!(
            "{branch} tracks {missing}, which no longer exists. Fetch, or push it from a terminal."
        ));
    }
    let remote = push_remote(repo, branch)
        .or_else(|| status.remote.clone())
        .ok_or("No remote is configured")?;
    if let Some(upstream) = &status.upstream
        && status.remote.as_deref() == Some(remote.as_str())
        && merge_ref(repo, branch).as_deref() != Some(format!("refs/heads/{branch}").as_str())
    {
        return Err(format!(
            "{branch} tracks {upstream}, which has another name, so Push won't update it. \
             Push from a terminal to choose the remote branch."
        ));
    }
    Ok(PushPlan {
        remote,
        set_upstream: status.upstream.is_none(),
    })
}

/// Fetch from the remote, fast-forward to the upstream, or push the branch
/// (see [`push_plan`]), then report the new status. Pull never merges or
/// rebases, and push is never forced. Pushing a branch without an upstream
/// publishes it and sets the upstream.
///
/// # Errors
/// Fails without a remote, branch, or upstream the action needs, while a
/// merge or rebase is in progress (pull), when the branch has diverged
/// (pull) or the remote has newer commits (push), when Push would update a
/// branch of another name, when the remote rejects the credentials, and on
/// other Git errors.
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
            let upstream =
                status
                    .upstream
                    .as_deref()
                    .with_context(|| match &status.missing_upstream {
                        Some(missing) => {
                            format!("{branch} tracks {missing}, which no longer exists")
                        }
                        None => format!("{branch} has no upstream to pull from"),
                    })?;
            ensure_no_operation(repo)?;
            fetch(repo, status.remote.as_deref().unwrap_or("origin"))?;
            // Checkout filters (Git LFS) and hooks can reach the network too.
            network(
                repo,
                &["merge", "--ff-only", "--no-edit", "@{upstream}"],
                HOOK_TIMEOUT,
            )
            .map_err(|e| {
                let message = e.to_string();
                if message.contains("Not possible to fast-forward")
                    || message.contains("Diverging branches")
                {
                    anyhow!(
                        "{branch} has diverged from {upstream}; pull can only fast-forward. \
                         Merge or rebase it yourself."
                    )
                } else {
                    e
                }
            })?;
        }
        SyncAction::Push => {
            let plan = push_plan(repo, &status).map_err(|reason| anyhow!(reason))?;
            let branch = status.branch.as_deref().unwrap_or_default();
            let refspec = format!("HEAD:refs/heads/{branch}");
            let mut args = vec!["push"];
            if plan.set_upstream {
                args.push("--set-upstream");
            }
            args.extend(["--", plan.remote.as_str(), refspec.as_str()]);
            network(repo, &args, HOOK_TIMEOUT).map_err(|e| push_error(e, &plan.remote))?;
        }
    }
    sync_status(repo)
}

/// Fetches without `--prune`, so the user's `fetch.prune` setting decides.
fn fetch(repo: &Path, remote: &str) -> Result<()> {
    network(repo, &["fetch", "--", remote], FETCH_TIMEOUT)?;
    Ok(())
}

/// The remote a branch tracks, when it tracks a remote rather than a local branch.
fn tracked_remote(repo: &Path, branch: &str) -> Option<String> {
    run(git(repo).args(["config", "--get", &format!("branch.{branch}.remote")]))
        .ok()
        .filter(|r| !r.is_empty() && r != "." && !r.starts_with('-'))
}

/// The remote branch a branch merges from, such as `refs/heads/main`.
fn merge_ref(repo: &Path, branch: &str) -> Option<String> {
    run(git(repo).args(["config", "--get", &format!("branch.{branch}.merge")]))
        .ok()
        .filter(|m| !m.is_empty())
}

/// The remote Git pushes a branch to when it differs from the one it fetches from.
fn push_remote(repo: &Path, branch: &str) -> Option<String> {
    [
        format!("branch.{branch}.pushRemote"),
        "remote.pushDefault".into(),
    ]
    .iter()
    .find_map(|key| run(git(repo).args(["config", "--get", key])).ok())
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

/// Commits HEAD has that `other` lacks, and the reverse.
fn counts(repo: &Path, other: &str) -> Result<(u32, u32)> {
    let out = run(git(repo).args([
        "rev-list",
        "--left-right",
        "--count",
        &format!("HEAD...{other}"),
    ]))?;
    let mut parts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    Ok((parts.next().unwrap_or(0), parts.next().unwrap_or(0)))
}

/// Git writes `FETCH_HEAD` per worktree, so a linked worktree has its own.
fn last_fetch(repo: &Path) -> Option<u64> {
    let path = run(git(repo).args(["rev-parse", "--git-path", "FETCH_HEAD"])).ok()?;
    let modified = repo.join(path).metadata().ok()?.modified().ok()?;
    u64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// Run a Git command that may talk to a remote. It cannot prompt for
/// credentials, and it is stopped, with the hooks and helpers it started,
/// after `timeout`.
fn network(repo: &Path, args: &[&str], timeout: Duration) -> Result<String> {
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // Its own process group, so a timeout also stops hooks and helpers.
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().context("running git")?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let success = wait(&mut child, timeout)?;
    let deadline = Instant::now() + DRAIN_GRACE;
    let left = || deadline.saturating_duration_since(Instant::now());
    let stdout = stdout.recv_timeout(left()).unwrap_or_default();
    let stderr = stderr.recv_timeout(left()).unwrap_or_default();
    if !success {
        bail!(network_error(stderr.trim()));
    }
    Ok(stdout.trim().to_string())
}

/// Read a pipe to its end on another thread. The caller stops waiting after
/// Git exits, since a helper may keep the pipe open.
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_string(&mut text);
        }
        let _ = send.send(text);
    });
    receive
}

fn wait(child: &mut Child, timeout: Duration) -> Result<bool> {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if start.elapsed() > timeout {
            stop_group(child);
            let _ = child.wait();
            bail!(
                "Git did not finish within {} seconds. Check the network connection, \
                 or a Git hook that runs long (a pre-push test run, for one).",
                timeout.as_secs()
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Stop Git and everything in its process group.
fn stop_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = crate::process::background_command("kill")
            .args(["-TERM", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
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
        let unpushed = sync_status(&f.path("a")).unwrap();
        assert_eq!(unpushed.push_to.as_deref(), Some("origin/main"));
        assert_eq!(unpushed.unpushed, Some(1));
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
    fn push_never_moves_a_remote_branch_of_another_name() {
        let f = Fixture::new();
        f.git(
            "a",
            &["switch", "-q", "-c", "feat", "--track", "origin/main"],
        );
        f.commit("a", "feature");
        let status = sync_status(&f.path("a")).unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert!(status.push_refused.unwrap().contains("another name"));
        assert_eq!(status.push_to, None);
        let error = sync(&f.path("a"), SyncAction::Push)
            .unwrap_err()
            .to_string();
        assert!(error.contains("another name"), "{error}");
        assert_eq!(f.git("origin.git", &["rev-list", "--count", "main"]), "1");
    }

    #[test]
    fn push_follows_the_configured_push_remote() {
        let f = Fixture::new();
        f.git(".", &["init", "-q", "--bare", "-b", "main", "fork.git"]);
        let fork = f.path("fork.git");
        f.git("a", &["remote", "add", "fork", fork.to_str().unwrap()]);
        f.git("a", &["config", "remote.pushDefault", "fork"]);
        f.commit("a", "two");
        let before = sync_status(&f.path("a")).unwrap();
        assert_eq!(before.push_to.as_deref(), Some("fork/main"));
        assert_eq!(before.unpushed, None);
        let after = sync(&f.path("a"), SyncAction::Push).unwrap();
        assert_eq!((after.unpushed, after.push_behind), (Some(0), 0));
        assert_eq!(after.ahead, 1, "the upstream stays origin/main");
        assert_eq!(
            f.git("fork.git", &["rev-parse", "main"]),
            f.git("a", &["rev-parse", "HEAD"])
        );
        assert_eq!(f.git("origin.git", &["rev-list", "--count", "main"]), "1");
    }

    #[test]
    fn a_pruned_upstream_is_reported_and_never_republished_elsewhere() {
        let f = Fixture::new();
        f.git("a", &["switch", "-q", "-c", "gone"]);
        sync(&f.path("a"), SyncAction::Push).unwrap();
        f.git("origin.git", &["branch", "-D", "gone"]);
        // Fetch prunes only when the user's config asks it to.
        f.git("a", &["config", "fetch.prune", "true"]);
        sync(&f.path("a"), SyncAction::Fetch).unwrap();
        let status = sync_status(&f.path("a")).unwrap();
        assert_eq!(status.upstream, None);
        assert_eq!(status.missing_upstream.as_deref(), Some("origin/gone"));
        assert_eq!(status.remote.as_deref(), Some("origin"));
        let error = sync(&f.path("a"), SyncAction::Push)
            .unwrap_err()
            .to_string();
        assert!(error.contains("no longer exists"), "{error}");
    }

    #[test]
    fn a_linked_worktree_reports_its_own_fetch_time() {
        let f = Fixture::new();
        f.git("a", &["worktree", "add", "-q", "-b", "wt", "../wt"]);
        assert_eq!(sync_status(&f.path("wt")).unwrap().last_fetch_ms, None);
        sync(&f.path("wt"), SyncAction::Fetch).unwrap();
        assert!(sync_status(&f.path("wt")).unwrap().last_fetch_ms.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_holding_the_output_open_does_not_stall_a_push() {
        use std::os::unix::fs::PermissionsExt as _;
        let f = Fixture::new();
        // Like an SSH connection master: it outlives Git, holding its output pipes.
        let hooks = f
            .path("a")
            .join(f.git("a", &["rev-parse", "--git-path", "hooks"]));
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-push");
        fs::write(&hook, "#!/bin/sh\nsleep 30 &\nexit 0\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        f.commit("a", "two");
        let start = Instant::now();
        sync(&f.path("a"), SyncAction::Push).unwrap();
        assert!(start.elapsed() < Duration::from_secs(10));
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
