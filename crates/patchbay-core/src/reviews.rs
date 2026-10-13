//! Whole-branch review jobs and per-branch findings, stored outside the source tree.
use crate::context;
use crate::git;
use crate::merges::{AgentJob, owned_dirs};
use crate::model::{Project, REVIEW_SCOPE, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::SystemTime;

pub const REVIEW_FILE_ENV: &str = "PATCHBAY_REVIEW_FILE";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub worktree: String,
    pub branch: String,
    pub base: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    branch: String,
    head: String,
    base: String,
    merge_base: String,
    started_ms: u64,
    /// Unique per attempt, so a rollback recognises the sidecar it wrote.
    #[serde(default)]
    attempt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Findings {
    pub text: String,
    pub modified_ms: u64,
    /// Absent when the findings predate the latest review attempt.
    pub reviewed_head: Option<String>,
    pub base: String,
    /// When the review attempt started; later changes weren't reviewed.
    pub started_ms: u64,
    /// Uncommitted or untracked files in the branch's worktree changed after the
    /// attempt started, or couldn't be checked.
    pub edited_since_start: bool,
    pub truncated: bool,
}

/// Serializes sidecar writes, so a rollback can't overwrite a newer attempt's.
static SIDECARS: Mutex<()> = Mutex::new(());

/// A recorded review attempt: findings written after it count for its HEAD.
pub struct Attempt {
    sidecar: PathBuf,
    previous: Option<Vec<u8>>,
    written: Vec<u8>,
    briefing: Option<PathBuf>,
}

impl Attempt {
    fn record(sidecar: PathBuf, started: &Started, briefing: Option<PathBuf>) -> Result<Self> {
        let written = serde_json::to_vec(started)?;
        let _guard = SIDECARS.lock().unwrap_or_else(PoisonError::into_inner);
        let previous = std::fs::read(&sidecar).ok();
        // Atomic replacement keeps readers from pairing new findings with a partial sidecar.
        crate::plans::write_atomic(&sidecar, &written)?;
        Ok(Self {
            sidecar,
            previous,
            written,
            briefing,
        })
    }

    /// Put back the sidecar this attempt replaced, best-effort, unless a later attempt
    /// has replaced it since.
    pub fn rollback(self) {
        {
            let _guard = SIDECARS.lock().unwrap_or_else(PoisonError::into_inner);
            if std::fs::read(&self.sidecar).ok().as_deref() == Some(self.written.as_slice()) {
                let _ = match &self.previous {
                    Some(bytes) => crate::plans::write_atomic(&self.sidecar, bytes),
                    None => std::fs::remove_file(&self.sidecar).map_err(Into::into),
                };
            }
        }
        if let Some(file) = &self.briefing {
            context::remove_owned_briefing_file(file);
        }
    }

    /// Run `start`, rolling back unless it may have started the session: its error
    /// says whether the session may be running anyway (a lost reply), in which case
    /// that session owns this attempt.
    ///
    /// # Errors
    /// Returns `start`'s error.
    pub fn launch<T>(self, start: impl FnOnce() -> Result<T, (String, bool)>) -> Result<T, String> {
        match start() {
            Ok(value) => Ok(value),
            Err((error, true)) => Err(error),
            Err((error, false)) => {
                // A refused launch must not invalidate or re-attribute saved findings.
                self.rollback();
                Err(error)
            }
        }
    }
}

/// A prepared review whose sidecar is already recorded, so findings written as soon
/// as the agent starts are attributed to it.
pub struct Prepared {
    pub job: AgentJob,
    attempt: Attempt,
}

impl Prepared {
    /// Undo the recorded attempt and remove the briefing, best-effort.
    pub fn rollback(self) {
        self.attempt.rollback();
    }

    /// Start the job with `start`, rolling back as [`Attempt::launch`] does.
    ///
    /// # Errors
    /// Returns `start`'s error.
    pub fn launch<T>(
        self,
        start: impl FnOnce(AgentJob) -> Result<T, (String, bool)>,
    ) -> Result<T, String> {
        let Self { job, attempt } = self;
        attempt.launch(|| start(job))
    }
}

// Include branch identity because slug alone aliases feature/a, feature-a and Feature-a.
fn name(branch: &str) -> String {
    let identity = crate::workspace::session_id(branch, REVIEW_SCOPE, "findings");
    format!("{}-{}", crate::detect::slug(branch), &identity[2..18])
}

/// Create the canonical reviews folder.
///
/// # Errors
/// Fails for a non-repository root or filesystem errors.
pub fn dir(root: &Path) -> Result<PathBuf> {
    let dir = crate::tasks::store_dir(root)?.join("reviews");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.canonicalize()?)
}

/// Existing reviews folder, without creating it.
#[must_use]
pub fn existing_dir(root: &Path) -> Option<PathBuf> {
    crate::tasks::store_dir(root)
        .ok()?
        .join("reviews")
        .canonicalize()
        .ok()
}

/// Findings path, with a safe filename for any branch, inside the canonical folder
/// once it exists, so it matches the folder agents are granted.
///
/// # Errors
/// Fails when the root isn't in a repository.
pub fn file(root: &Path, branch: &str) -> Result<PathBuf> {
    let folder = match existing_dir(root) {
        Some(folder) => folder,
        None => crate::tasks::store_dir(root)?.join("reviews"),
    };
    Ok(in_dir(&folder, branch))
}

fn in_dir(folder: &Path, branch: &str) -> PathBuf {
    folder.join(format!("{}.md", name(branch)))
}

/// Prepare a review without modifying repository files or Git state.
/// Read-only behavior is requested in the briefing; the user's command is preserved.
/// Launch it with `Prepared::launch`, which rolls back a refused launch.
///
/// # Errors
/// Fails for missing, foreign, detached or changed worktrees, invalid refs, a base equal
/// to the reviewed branch, policy or I/O.
pub fn prepare(
    project: &Project,
    request: &ReviewRequest,
    terminal: &TerminalSpec,
    policy: &dyn Policy,
) -> Result<Prepared> {
    let root = Path::new(&project.root);
    ensure!(
        git::worktrees(root)
            .iter()
            .any(|t| t.path == request.worktree),
        "The review worktree is missing or isn't in this project's repository"
    );
    let cwd = Path::new(&request.worktree);
    let common = git::common_dir(root)?.canonicalize()?;
    owned_dirs(cwd, &common)?;
    let branch = current_branch(cwd)
        .context("The review worktree has a detached HEAD; check out a branch first")?;
    ensure!(
        branch == request.branch,
        "The review branch changed; refresh Review and try again"
    );
    ensure!(
        request.base != request.branch,
        "Choose a base other than the reviewed branch"
    );
    crate::tasks::check_branch(cwd, &request.base)?;
    ensure!(
        crate::tasks::verifies(cwd, &format!("{}^{{commit}}", request.base)),
        "Unknown review base: {}",
        request.base
    );
    let head = git::run(git::git(cwd).args(["rev-parse", "HEAD"]))?;
    let merge_base = git::run(git::git(cwd).args(["merge-base", &request.base, "HEAD"]))?;
    let folder = dir(root)?;
    let findings = in_dir(&folder, &request.branch);
    let mut terminal = terminal.clone();
    terminal.id = crate::workspace::session_id(&request.worktree, REVIEW_SCOPE, "review");
    terminal.name = format!("Review · {}", request.branch);
    let text = format!(
        "# Patchbay branch review\n\nProject: {}\nWorktree: {}\nBranch: {}\nHEAD: {head}\nBase branch: {}\nMerge base: {merge_base}\n\n\
         Review the entire branch's committed work with git diff {merge_base}..HEAD, its uncommitted changes with git diff HEAD (including staged changes), and untracked files. Review's component filters do not limit this job. Read the repository's contribution instructions.\n\n\
         Report findings only. Do not edit source files, stage, commit, stash, reset or check out anything. Do not change Git state or run checks that modify the tree. Fixes belong in Implementation. Read-only behavior relies on these instructions; Patchbay does not rewrite the user's agent command to enforce it.\n\n\
         Write findings ranked by severity with file:line references to $PATCHBAY_REVIEW_FILE ({}), replacing previous findings. Explain the impact and evidence for each finding. If there are no findings, say so explicitly. This findings file is the only file you may write.\n",
        project.name,
        request.worktree,
        request.branch,
        request.base,
        findings.display(),
    );
    let mut scoped = project.clone();
    scoped.root.clone_from(&request.worktree);
    scoped.components.clear();
    scoped.links.clear();
    scoped.groups.clear();
    let spec = context::job_agent_spec(
        &scoped,
        &terminal,
        &text,
        vec![folder],
        REVIEW_SCOPE,
        context::REVIEW_PROMPT,
        BTreeMap::from([(REVIEW_FILE_ENV.into(), findings.display().to_string())]),
        policy,
    )?;
    let started = Started {
        branch: request.branch.clone(),
        head,
        base: request.base.clone(),
        merge_base,
        started_ms: crate::status::unix_ms(SystemTime::now()),
        attempt: uuid::Uuid::new_v4().to_string(),
    };
    let briefing = context::owned_briefing(&spec);
    match Attempt::record(findings.with_extension("json"), &started, briefing.clone()) {
        Ok(attempt) => Ok(Prepared {
            job: AgentJob { terminal, spec },
            attempt,
        }),
        Err(error) => {
            if let Some(file) = briefing {
                context::remove_owned_briefing_file(&file);
            }
            Err(error)
        }
    }
}

/// Record a new attempt for a review session about to resume, so findings it writes
/// count for its worktree's current HEAD. `None` when the HEAD and worktree are
/// unchanged since the last attempt, so resuming alone doesn't age its findings.
///
/// # Errors
/// Fails when the branch's review record is missing, its identity doesn't match,
/// or the worktree no longer has the reviewed branch checked out.
pub fn resume_attempt(root: &Path, spec: &SessionSpec, branch: &str) -> Result<Option<Attempt>> {
    // Session summaries deliberately strip the launch environment. Use the recorded
    // branch to find the artifact, rather than depending on PATCHBAY_REVIEW_FILE.
    let findings = file(root, branch)?;
    let folder = existing_dir(root).context("The reviews folder is missing")?;
    let sidecar = findings.with_extension("json");
    let old: Started = serde_json::from_slice(
        &std::fs::read(&sidecar).context("The review's record is missing; start a new review")?,
    )?;
    ensure!(
        in_dir(&folder, &old.branch) == findings,
        "The review's findings file is outside the reviews folder"
    );
    let cwd = spec.cwd.as_path();
    let branch = current_branch(cwd).unwrap_or_default();
    ensure!(
        branch == old.branch,
        "The review worktree no longer has {} checked out; start a new review",
        old.branch
    );
    let head = git::run(git::git(cwd).args(["rev-parse", "HEAD"]))?;
    if head == old.head && !git::changed_since(cwd, old.started_ms).unwrap_or(true) {
        return Ok(None);
    }
    let merge_base = git::run(git::git(cwd).args(["merge-base", &old.base, "HEAD"]))
        .with_context(|| format!("The review base {} is gone; start a new review", old.base))?;
    let started = Started {
        head,
        merge_base,
        started_ms: crate::status::unix_ms(SystemTime::now()),
        attempt: uuid::Uuid::new_v4().to_string(),
        ..old
    };
    Attempt::record(sidecar, &started, None).map(Some)
}

/// Read capped findings. Older findings remain visible, but have no reviewed HEAD.
#[must_use]
pub fn read(root: &Path, branch: &str) -> Option<Findings> {
    load(root, branch, crate::plans::PLAN_LIMIT, None)
}

/// [`read`] up to `limit` bytes; `worktree`, when known to have `branch` checked
/// out, spares looking it up.
fn load(root: &Path, branch: &str, limit: usize, worktree: Option<&Path>) -> Option<Findings> {
    let file = file(root, branch).ok()?;
    let started: Started =
        serde_json::from_slice(&std::fs::read(file.with_extension("json")).ok()?).ok()?;
    if started.branch != branch {
        return None;
    }
    let handle = std::fs::File::open(file).ok()?;
    let modified_ms = crate::status::unix_ms(handle.metadata().ok()?.modified().ok()?);
    let (text, truncated) = crate::plans::read_limited(handle, limit).ok()?;
    let reviewed_head = (modified_ms > started.started_ms).then_some(started.head);
    let changed = |w: &Path| git::changed_since(w, started.started_ms).unwrap_or(true);
    // Findings without a reviewed HEAD are stale anyway; skip the worktree scan.
    let edited_since_start = reviewed_head.is_some()
        && match worktree {
            Some(worktree) => changed(worktree),
            None => git::worktrees(root)
                .iter()
                .find(|w| w.branch.as_deref() == Some(branch))
                .is_some_and(|w| changed(Path::new(&w.path))),
        };
    Some(Findings {
        text,
        modified_ms,
        reviewed_head,
        base: started.base,
        started_ms: started.started_ms,
        edited_since_start,
        truncated,
    })
}

/// The branch checked out in `cwd`; `None` for a detached `HEAD`.
fn current_branch(cwd: &Path) -> Option<String> {
    git::run(git::git(cwd).args(["symbolic-ref", "--quiet", "--short", "HEAD"])).ok()
}

/// How much of the findings a fix agent's briefing inlines. Claude reads the
/// briefing from a file and Codex falls back to pointing at it, so this may
/// exceed what the Review panel shows.
pub const HANDOFF_LIMIT: usize = 4 * crate::plans::PLAN_LIMIT;

/// A review session's own record: the folder it ran in (its worktree's top) and
/// the branch it recorded. The adapter reads it from the session service, never
/// from the webview.
#[derive(Debug, Clone)]
pub struct Session {
    pub cwd: PathBuf,
    pub branch: Option<String>,
}

/// The reviewed worktree (canonical), branch and its nonempty findings, checked
/// without listing worktrees: the worktree must still have the branch checked out.
fn fixable(session: &Session) -> Result<(PathBuf, &str, Findings)> {
    let branch = session
        .branch
        .as_deref()
        .context("This review predates recorded branches; start a new review")?;
    let worktree = session
        .cwd
        .canonicalize()
        .ok()
        .filter(|w| git::nearest_repo(w).as_ref() == Some(w))
        .context("The reviewed worktree no longer exists")?;
    ensure!(
        current_branch(&worktree).as_deref() == Some(branch),
        "{branch} is no longer checked out in this worktree; switch back or review again"
    );
    let findings = load(&worktree, branch, HANDOFF_LIMIT, Some(&worktree))
        .filter(|f| !f.text.trim().is_empty())
        .with_context(|| format!("No review findings are saved for {branch}"))?;
    Ok((worktree, branch, findings))
}

/// The task a fix for review `session` runs in: `None` for the project folder
/// `root` sits in. Checks everything [`handoff`] does first, so a refused fix
/// changes nothing.
///
/// # Errors
/// Fails as [`handoff`] would, or when neither a task nor the project folder
/// holds the reviewed worktree.
pub fn fix_task(root: &Path, session: &Session) -> Result<Option<String>> {
    let (worktree, ..) = fixable(session)?;
    if git::repo_root(root).as_ref() == Some(&worktree) {
        return Ok(None);
    }
    // The store is per repository, so a match is also in `root`'s repository.
    let task =
        crate::tasks::stored_at(root, &worktree)?.context("Add this worktree as a task first")?;
    Ok(Some(task.id))
}

/// Inline review `session`'s findings for a fix agent launched at `root`. Grants
/// no folders: the reviews folder would be writable to the agent.
///
/// # Errors
/// Fails for a session without a recorded branch, when `root` isn't in the
/// reviewed worktree, that worktree no longer has the branch checked out, or it
/// has no saved findings.
pub fn handoff(root: &Path, session: &Session) -> Result<context::ContextSection> {
    let (worktree, branch, findings) = fixable(session)?;
    ensure!(
        git::repo_root(root).as_ref() == Some(&worktree),
        "This launch isn't in the reviewed worktree"
    );
    let worktree = worktree.as_path();
    let text = findings.text.trim();
    let head = git::run(git::git(worktree).args(["rev-parse", "HEAD"]))?;
    let freshness = match findings.reviewed_head.as_deref() {
        None => "from an earlier attempt; a newer review hasn't written findings yet".into(),
        Some(reviewed) if reviewed != head => format!(
            "reviewed at {}; the branch has commits since, so some may be resolved",
            reviewed.get(..7).unwrap_or(reviewed)
        ),
        Some(_) if findings.edited_since_start => {
            "files changed after the review started; some may already be addressed".into()
        }
        Some(_) => format!("current for HEAD {}", &head[..head.len().min(7)]),
    };
    let age = crate::plans::ago(
        SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(findings.modified_ms),
    );
    let cut = if findings.truncated {
        format!(
            "\n\n[The findings continue past {} KiB in {}; read it only, and ask the user if you can't.]",
            HANDOFF_LIMIT / 1024,
            file(worktree, branch)?.display()
        )
    } else {
        String::new()
    };
    Ok(context::ContextSection {
        title: "Review findings".into(),
        body: format!(
            "Branch: {branch}\nBase: {}\nSaved {age}\nFreshness: {freshness}\n\n{text}{cut}",
            findings.base
        ),
    })
}

/// Remove a branch's findings and sidecar.
///
/// # Errors
/// Fails for a non-repository root or deletion errors.
pub fn remove(root: &Path, branch: &str) -> Result<()> {
    let file = file(root, branch)?;
    // Keep the branch identity for a later cleanup retry if deleting findings fails.
    for path in [file.clone(), file.with_extension("json")] {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

/// Delete saved reviews only when their recorded local branch ref is gone.
/// A review that can't be deleted is left for the next prune.
///
/// # Errors
/// Fails for an unreadable folder or ref listing.
pub fn prune(root: &Path) -> Result<()> {
    let Some(folder) = existing_dir(root) else {
        return Ok(());
    };
    // A failed ref listing must never be interpreted as deleted branches.
    let branches = git::branches(root)?;
    for entry in std::fs::read_dir(&folder)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(started) = serde_json::from_slice::<Started>(&bytes) else {
            continue;
        };
        // Never trust a sidecar's branch to remove a different artifact.
        if path != in_dir(&folder, &started.branch).with_extension("json") {
            continue;
        }
        if !branches.contains(&started.branch) {
            let _ = remove(root, &started.branch);
        }
    }
    Ok(())
}

/// Grant only the registered review worktree and existing findings folder on resume.
///
/// # Errors
/// Fails for a missing, unregistered or foreign worktree, or missing findings folder.
pub fn resume_roots(root: &Path, spec: &SessionSpec) -> Result<Vec<PathBuf>> {
    let path = spec.cwd.canonicalize()?;
    ensure!(
        git::worktrees(root)
            .iter()
            .any(|t| Path::new(&t.path) == path),
        "The review worktree at {} is no longer registered",
        path.display()
    );
    owned_dirs(&path, &git::common_dir(root)?.canonicalize()?)?;
    Ok(vec![
        path,
        existing_dir(root).context("The reviews folder is missing")?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::AllowAll;
    use std::fs;
    use std::time::{Duration, UNIX_EPOCH};

    struct Fixture {
        dir: PathBuf,
        project: Project,
        request: ReviewRequest,
    }
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("patchbay-review-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            git::run(git::git(&dir).args(["init", "-q", "-b", "main"])).unwrap();
            git::run(git::git(&dir).args(["config", "user.name", "Review test"])).unwrap();
            git::run(git::git(&dir).args(["config", "user.email", "review@patchbay.invalid"]))
                .unwrap();
            git::run(git::git(&dir).args(["config", "commit.gpgsign", "false"])).unwrap();
            fs::write(dir.join("file.txt"), "base\n").unwrap();
            git::run(git::git(&dir).args(["add", "."])).unwrap();
            git::run(git::git(&dir).args(["commit", "-qm", "base"])).unwrap();
            git::run(git::git(&dir).args(["checkout", "-qb", "feature/a"])).unwrap();
            let dir = dir.canonicalize().unwrap();
            let project = Project {
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Review test".into(),
                root: dir.to_string_lossy().into(),
                components: vec![],
                links: vec![],
                groups: vec![],
            };
            let request = ReviewRequest {
                worktree: project.root.clone(),
                branch: "feature/a".into(),
                base: "main".into(),
            };
            Self {
                dir,
                project,
                request,
            }
        }
        fn prepared(&self, command: &str) -> Result<Prepared> {
            let terminal = serde_json::from_value(serde_json::json!({"id":"agent", "name":"Agent", "kind":"agent", "command":command})).unwrap();
            prepare(&self.project, &self.request, &terminal, &AllowAll)
        }
        fn prepare(&self, command: &str) -> Result<AgentJob> {
            self.prepared(command).map(|p| p.job)
        }
        fn save(&self, text: &str, after: bool) {
            let path = file(&self.dir, &self.request.branch).unwrap();
            let sidecar: Started =
                serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            let time = if after {
                sidecar.started_ms + 10
            } else {
                sidecar.started_ms.saturating_sub(10)
            };
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(time))
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn session(cwd: &Path, branch: Option<&str>) -> Session {
        Session {
            cwd: cwd.into(),
            branch: branch.map(Into::into),
        }
    }

    /// The fix briefing for a review of `branch` in the worktree at `dir`.
    fn fix(dir: &Path, branch: &str) -> Result<context::ContextSection> {
        handoff(dir, &session(dir, Some(branch)))
    }

    /// A linked worktree of `main` with findings saved by a review there.
    fn reviewed_linked(f: &Fixture) -> PathBuf {
        let worktree = f.dir.join("linked");
        git::run(git::git(&f.dir).args([
            "worktree",
            "add",
            "-q",
            worktree.to_str().unwrap(),
            "main",
        ]))
        .unwrap();
        let request = ReviewRequest {
            worktree: worktree.display().to_string(),
            branch: "main".into(),
            base: f.request.branch.clone(),
        };
        let terminal = serde_json::from_value(
            serde_json::json!({"id":"review", "name":"Review", "kind":"agent", "command":"claude"}),
        )
        .unwrap();
        prepare(&f.project, &request, &terminal, &AllowAll).unwrap();
        let path = file(&worktree, "main").unwrap();
        let started: Started =
            serde_json::from_slice(&fs::read(path.with_extension("json")).unwrap()).unwrap();
        fs::write(&path, "Linked finding").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis(started.started_ms + 10))
            .unwrap();
        worktree
    }

    fn fix_body(f: &Fixture) -> String {
        fix(&f.dir, &f.request.branch).unwrap().body
    }

    #[test]
    fn handoff_omits_missing_blank_and_detached_findings() {
        let f = Fixture::new();
        assert!(fix(&f.dir, &f.request.branch).is_err());
        assert!(existing_dir(&f.dir).is_none());
        f.prepare("claude").unwrap();
        assert!(fix(&f.dir, &f.request.branch).is_err());
        f.save(" \n", true);
        assert!(fix(&f.dir, &f.request.branch).is_err());
        f.save("P2 file.txt:1: Fix this", true);
        git::run(git::git(&f.dir).args(["checkout", "--detach", "-q"])).unwrap();
        assert!(fix(&f.dir, &f.request.branch).is_err());
    }

    #[test]
    fn handoff_refuses_another_checked_out_branch() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        let error = fix(&f.dir, &f.request.branch).unwrap_err();
        assert!(error.to_string().contains("no longer checked out"));
    }

    #[test]
    fn fixes_need_a_recorded_branch_and_an_existing_worktree() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let error = fix_task(&f.dir, &session(&f.dir, None)).unwrap_err();
        assert!(error.to_string().contains("predates recorded branches"));
        let gone = f.dir.join("gone");
        let error = fix_task(&f.dir, &session(&gone, Some("feature/a"))).unwrap_err();
        assert!(error.to_string().contains("no longer exists"));
        // A subfolder isn't a worktree's top.
        let sub = f.dir.join("app");
        fs::create_dir_all(&sub).unwrap();
        let error = handoff(&f.dir, &session(&sub, Some("feature/a"))).unwrap_err();
        assert!(error.to_string().contains("no longer exists"));
    }

    #[test]
    fn fix_task_refuses_what_handoff_would_before_anything_changes() {
        let f = Fixture::new();
        let open = session(&f.dir, Some("feature/a"));
        f.prepare("claude").unwrap();
        let error = fix_task(&f.dir, &open).unwrap_err();
        assert!(error.to_string().contains("No review findings"));
        f.save("Finding", true);
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        let error = fix_task(&f.dir, &open).unwrap_err();
        assert!(error.to_string().contains("no longer checked out"));
    }

    #[test]
    fn fix_task_finds_the_task_else_the_project_folder() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let open = session(&f.dir, Some("feature/a"));
        // A project opened in a subfolder still reviews at the worktree's top.
        let sub = f.dir.join("app");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(fix_task(&sub, &open).unwrap(), None);
        let linked = reviewed_linked(&f);
        let other = session(&linked, Some("main"));
        let error = fix_task(&f.dir, &other).unwrap_err();
        assert!(error.to_string().contains("Add this worktree as a task"));
        let canonical = linked.canonicalize().unwrap();
        let task =
            crate::tasks::attach(&f.dir, &canonical.display().to_string(), None, vec![]).unwrap();
        assert_eq!(fix_task(&f.dir, &other).unwrap(), Some(task.id));
    }

    #[test]
    fn handoff_refuses_a_launch_outside_the_reviewed_worktree() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let linked = f.dir.join("linked");
        git::run(git::git(&f.dir).args([
            "worktree",
            "add",
            "-q",
            linked.to_str().unwrap(),
            "main",
        ]))
        .unwrap();
        let target = session(&f.dir, Some(&f.request.branch));
        let error = handoff(&linked, &target).unwrap_err();
        assert!(error.to_string().contains("isn't in the reviewed worktree"));
    }

    #[test]
    fn handoff_inlines_current_findings_without_granting_reviews() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("P2 file.txt:1: Fix this", true);
        let section = fix(&f.dir, &f.request.branch).unwrap();
        assert_eq!(section.title, "Review findings");
        for text in [
            "feature/a",
            "Base: main",
            "Saved just now",
            "current for HEAD",
            "Fix this",
        ] {
            assert!(section.body.contains(text), "{text}");
        }
        let terminal = serde_json::from_value(serde_json::json!({
            "id": "fix", "name": "Fix", "kind": "agent", "command": "claude"
        }))
        .unwrap();
        let spec = context::task_root_session_spec(
            &f.project,
            &[],
            &terminal,
            None,
            &AllowAll,
            &[section],
            Some(context::Kickoff::FixFindings),
        )
        .unwrap();
        assert!(!spec.dirs.iter().any(|d| d.ends_with("reviews")));
        assert!(!spec.command.contains("/patchbay/reviews"));
    }

    #[test]
    fn handoff_reports_commits_since_review() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        git::run(git::git(&f.dir).args(["commit", "--allow-empty", "-qm", "after review"]))
            .unwrap();
        assert!(fix_body(&f).contains("commits since"));
    }

    #[test]
    fn handoff_reports_edits_since_review() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Finding", true);
        let file = f.dir.join("file.txt");
        fs::write(&file, "edited\n").unwrap();
        fs::File::options()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(1))
            .unwrap();
        assert!(fix_body(&f).contains("files changed after the review started"));
    }

    #[test]
    fn handoff_reports_an_earlier_attempt() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("Old finding", false);
        assert!(fix_body(&f).contains("a newer review hasn't written findings yet"));
    }

    #[test]
    fn handoff_inlines_past_the_panel_limit_and_names_the_file_when_cut() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save(&"x".repeat(crate::plans::PLAN_LIMIT + 1), true);
        let body = fix_body(&f);
        assert!(body.contains(&"x".repeat(crate::plans::PLAN_LIMIT + 1)));
        assert!(!body.contains("continue past"));
        f.save(&"x".repeat(HANDOFF_LIMIT + 1), true);
        let body = fix_body(&f);
        assert!(body.contains("continue past 256 KiB"));
        let path = file(&f.dir, &f.request.branch).unwrap();
        assert!(body.contains(&path.display().to_string()));
    }

    #[test]
    fn handoff_reads_findings_from_a_linked_worktree() {
        let f = Fixture::new();
        let worktree = reviewed_linked(&f);
        let body = fix(&worktree, "main").unwrap().body;
        assert!(body.contains("Branch: main"));
        assert!(body.contains("Linked finding"));
        assert!(body.contains("current for HEAD"));
    }

    #[test]
    fn briefing_covers_merge_base_and_dirty_whole_branch_without_mutations() {
        let f = Fixture::new();
        fs::write(f.dir.join("file.txt"), "edited\n").unwrap();
        fs::write(f.dir.join("untracked.txt"), "new\n").unwrap();
        let before = git::run(git::git(&f.dir).args(["status", "--porcelain"])).unwrap();
        let index = fs::read(f.dir.join(".git/index")).unwrap();
        for command in ["claude", "codex", "printf review"] {
            let job = f.prepare(command).unwrap();
            let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
            let merge_base =
                git::run(git::git(&f.dir).args(["merge-base", "main", "HEAD"])).unwrap();
            assert!(body.contains(&format!("git diff {merge_base}..HEAD")));
            for rule in [
                "git diff HEAD",
                "untracked files",
                "Do not edit",
                "stage, commit, stash, reset or check out",
                "file:line",
                "$PATCHBAY_REVIEW_FILE",
            ] {
                assert!(body.contains(rule), "{rule}");
            }
            assert!(!job.spec.exclusive_cwd);
            assert_eq!(job.spec.env[context::COMPONENT_ENV], REVIEW_SCOPE);
            assert_eq!(
                job.spec.env[REVIEW_FILE_ENV],
                file(&f.dir, &f.request.branch)
                    .unwrap()
                    .display()
                    .to_string()
            );
            assert_eq!(job.spec.dirs, vec![dir(&f.dir).unwrap()]);
            assert_eq!(
                job.terminal.id,
                crate::workspace::session_id(&f.request.worktree, REVIEW_SCOPE, "review")
            );
            if command != "printf review" {
                assert!(job.spec.command.contains(" --add-dir "));
                assert!(job.spec.command.contains("Review the whole branch"));
                assert!(
                    !job.spec
                        .resume_command
                        .as_ref()
                        .unwrap()
                        .contains("Review the whole branch")
                );
            }
            let pending = context::owned_briefing(&job.spec).unwrap();
            let mut retained = job.spec;
            context::retain_owned_briefing(&mut retained).unwrap();
            let retained_file = context::owned_briefing(&retained).unwrap();
            assert!(
                retained_file
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("review-")
            );
            assert_ne!(pending, retained_file);
            assert_eq!(fs::read_to_string(&retained_file).unwrap(), body);
            context::remove_owned_briefing_file(&pending);
            context::remove_owned_briefing_file(&retained_file);
            assert!(!pending.exists() && !retained_file.exists());
        }
        assert_eq!(
            git::run(git::git(&f.dir).args(["status", "--porcelain"])).unwrap(),
            before
        );
        assert_eq!(fs::read(f.dir.join(".git/index")).unwrap(), index);
    }

    #[test]
    fn rejects_unknown_base_detached_changed_and_unregistered_worktrees() {
        let mut f = Fixture::new();
        for base in ["missing", "--help", "main; touch x"] {
            f.request.base = base.into();
            assert!(f.prepare("claude").is_err());
        }
        f.request.base = f.request.branch.clone();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("other than the reviewed branch")
        );
        f.request.base = "main".into();
        f.request.branch = "changed".into();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("branch changed")
        );
        f.request.branch = "feature/a".into();
        git::run(git::git(&f.dir).args(["checkout", "--detach", "-q"])).unwrap();
        assert!(
            f.prepare("claude")
                .err()
                .unwrap()
                .to_string()
                .contains("detached HEAD")
        );
        f.request.worktree = f.dir.join("missing").to_string_lossy().into();
        assert!(f.prepare("claude").is_err());
    }

    #[test]
    fn reads_current_and_old_findings_and_caps_utf8() {
        let f = Fixture::new();
        assert!(read(&f.dir, &f.request.branch).is_none());
        let job = f.prepare("claude").unwrap();
        f.save("old findings", false);
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_none()
        );
        f.save("new findings", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, "new findings");
        assert_eq!(findings.base, "main");
        assert_eq!(
            findings.reviewed_head.unwrap(),
            git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap()
        );
        f.save(
            &format!("{}é", "a".repeat(crate::plans::PLAN_LIMIT - 1)),
            true,
        );
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert!(findings.truncated);
        assert_eq!(findings.text.len(), crate::plans::PLAN_LIMIT - 1);
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn resume_never_grants_git_dirs_and_rejects_unregistered_or_foreign_cwd() {
        let f = Fixture::new();
        let mut job = f.prepare("claude").unwrap();
        let roots = resume_roots(&f.dir, &job.spec).unwrap();
        assert_eq!(roots, vec![f.dir.clone(), dir(&f.dir).unwrap()]);
        crate::files::resolve(&roots, &job.spec.cwd).unwrap();
        assert_eq!(job.spec.dirs, vec![roots[1].clone()]);
        job.spec.cwd = f.dir.join("unregistered");
        fs::create_dir(&job.spec.cwd).unwrap();
        assert!(
            resume_roots(&f.dir, &job.spec)
                .unwrap_err()
                .to_string()
                .contains("no longer registered")
        );
        job.spec.cwd = f.dir.clone();
        // Replacing the registered path's Git metadata must not grant another repository.
        let original_git = f.dir.join(".git");
        fs::rename(&original_git, f.dir.join("old-git")).unwrap();
        git::run(git::git(&f.dir).args(["init", "-q"])).unwrap();
        assert!(resume_roots(&f.dir.join("old-git"), &job.spec).is_err());
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn rollback_restores_the_previous_review_attempt() {
        let mut f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        f.prepared("claude").unwrap().rollback();
        assert!(!sidecar.exists());
        let first = f.prepare("claude").unwrap();
        f.save("findings", true);
        let before = fs::read(&sidecar).unwrap();
        git::run(git::git(&f.dir).args(["branch", "release"])).unwrap();
        f.request.base = "release".into();
        std::thread::sleep(Duration::from_millis(5));
        let refused = f.prepared("claude").unwrap();
        let briefing = context::owned_briefing(&refused.job.spec).unwrap();
        assert_ne!(fs::read(&sidecar).unwrap(), before);
        refused.rollback();
        assert_eq!(fs::read(&sidecar).unwrap(), before);
        assert!(!briefing.exists());
        let restored = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(restored.text, "findings");
        assert_eq!(restored.base, "main");
        assert!(restored.reviewed_head.is_some());
        context::remove_owned_briefing_file(&context::owned_briefing(&first.spec).unwrap());
    }

    #[test]
    fn rollback_keeps_a_newer_attempts_sidecar() {
        let f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        let refused = f.prepared("claude").unwrap();
        let running = f.prepared("claude").unwrap();
        let current = fs::read(&sidecar).unwrap();
        refused.rollback();
        assert_eq!(fs::read(&sidecar).unwrap(), current);
        context::remove_owned_briefing_file(&context::owned_briefing(&running.job.spec).unwrap());
    }

    #[test]
    fn launch_rolls_back_only_a_certain_refusal() {
        let f = Fixture::new();
        let sidecar = file(&f.dir, &f.request.branch)
            .unwrap()
            .with_extension("json");
        let lost = f.prepared("claude").unwrap();
        let briefing = context::owned_briefing(&lost.job.spec).unwrap();
        let written = fs::read(&sidecar).unwrap();
        assert!(
            lost.launch(|_| Err::<(), _>(("lost".into(), true)))
                .is_err()
        );
        assert_eq!(fs::read(&sidecar).unwrap(), written);
        context::remove_owned_briefing_file(&briefing);
        let refused = f.prepared("claude").unwrap();
        assert!(
            refused
                .launch(|_| Err::<(), _>(("refused".into(), false)))
                .is_err()
        );
        assert_eq!(fs::read(&sidecar).unwrap(), written);
    }

    #[test]
    fn edits_anywhere_in_the_worktree_after_the_start_make_findings_stale() {
        let f = Fixture::new();
        f.prepare("claude").unwrap();
        f.save("findings", true);
        let started = read(&f.dir, &f.request.branch).unwrap().started_ms;
        assert!(!read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        // Outside any project subfolder, and before the review started: reviewed.
        fs::create_dir_all(f.dir.join("other")).unwrap();
        let edit = f.dir.join("other/edit.txt");
        fs::write(&edit, "x").unwrap();
        let at = |ms: u64| {
            fs::File::options()
                .write(true)
                .open(&edit)
                .unwrap()
                .set_modified(UNIX_EPOCH + Duration::from_millis(ms))
                .unwrap();
        };
        at(started - 10);
        assert!(!read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        at(started + 10);
        assert!(read(&f.dir, &f.request.branch).unwrap().edited_since_start);
        fs::remove_file(&edit).unwrap();
        // A deletion counts its folder's mtime.
        fs::remove_file(f.dir.join("file.txt")).unwrap();
        assert!(read(&f.dir, &f.request.branch).unwrap().edited_since_start);
    }

    #[test]
    fn resuming_records_a_new_attempt_only_when_the_worktree_moved_on() {
        let f = Fixture::new();
        let mut job = f.prepare("claude").unwrap();
        let briefing = context::owned_briefing(&job.spec).unwrap();
        f.save("findings", true);
        // The adapter receives public session summaries, with no launch environment.
        job.spec.env.clear();
        assert!(
            resume_attempt(&f.dir, &job.spec, &f.request.branch)
                .unwrap()
                .is_none()
        );

        fs::write(f.dir.join("file.txt"), "next\n").unwrap();
        git::run(git::git(&f.dir).args(["commit", "-qam", "next"])).unwrap();
        let head = git::run(git::git(&f.dir).args(["rev-parse", "HEAD"])).unwrap();
        let attempt = resume_attempt(&f.dir, &job.spec, &f.request.branch)
            .unwrap()
            .unwrap();
        // Old findings predate the new attempt until the agent rewrites them.
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_none()
        );
        attempt.rollback();
        assert!(
            read(&f.dir, &f.request.branch)
                .unwrap()
                .reviewed_head
                .is_some()
        );
        let attempt = resume_attempt(&f.dir, &job.spec, &f.request.branch)
            .unwrap()
            .unwrap();
        drop(attempt);
        f.save("new findings", true);
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.reviewed_head.as_deref(), Some(head.as_str()));
        assert_eq!(findings.base, "main");

        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        assert!(resume_attempt(&f.dir, &job.spec, &f.request.branch).is_err());
        context::remove_owned_briefing_file(&briefing);
    }

    #[test]
    fn prune_skips_failed_deletions_keeps_live_findings_and_retries_later() {
        let mut f = Fixture::new();
        let failed = f.prepare("claude").unwrap();
        let failed_file = file(&f.dir, &f.request.branch).unwrap();
        // A directory at the findings path makes deletion fail on every platform.
        fs::create_dir(&failed_file).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        git::run(git::git(&f.dir).args(["branch", "-D", "feature/a"])).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-qb", "feature/live"])).unwrap();
        f.request.branch = "feature/live".into();
        let live = f.prepare("claude").unwrap();
        f.save("live findings", true);

        prune(&f.dir).unwrap();
        assert!(failed_file.with_extension("json").exists());
        let findings = read(&f.dir, &f.request.branch).unwrap();
        assert_eq!(findings.text, "live findings");
        assert_eq!(findings.base, "main");
        assert!(findings.reviewed_head.is_some());

        fs::remove_dir(&failed_file).unwrap();
        prune(&f.dir).unwrap();
        assert!(!failed_file.with_extension("json").exists());
        assert_eq!(
            read(&f.dir, &f.request.branch).unwrap().text,
            "live findings"
        );
        for spec in [failed.spec, live.spec] {
            context::remove_owned_briefing_file(&context::owned_briefing(&spec).unwrap());
        }
    }

    #[test]
    fn failed_findings_deletion_keeps_the_sidecar_for_retry() {
        let f = Fixture::new();
        let job = f.prepare("claude").unwrap();
        let file = file(&f.dir, &f.request.branch).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(remove(&f.dir, &f.request.branch).is_err());
        assert!(file.with_extension("json").exists());
        fs::remove_dir(&file).unwrap();
        remove(&f.dir, &f.request.branch).unwrap();
        assert!(!file.with_extension("json").exists());
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn remove_and_prune_use_branch_identity_and_keep_existing_refs() {
        let f = Fixture::new();
        let job = f.prepare("claude").unwrap();
        f.save("findings", true);
        let path = file(&f.dir, &f.request.branch).unwrap();
        assert_ne!(path, file(&f.dir, "feature-a").unwrap());
        prune(&f.dir).unwrap();
        assert!(path.exists());
        git::run(git::git(&f.dir).args(["checkout", "-q", "main"])).unwrap();
        git::run(git::git(&f.dir).args(["branch", "-D", "feature/a"])).unwrap();
        prune(&f.dir).unwrap();
        assert!(!path.exists() && !path.with_extension("json").exists());
        remove(&f.dir, &f.request.branch).unwrap();
        git::run(git::git(&f.dir).args(["checkout", "-qb", "feature/a"])).unwrap();
        let next = f.prepare("claude").unwrap();
        f.save("new findings", true);
        remove(&f.dir, &f.request.branch).unwrap();
        assert!(read(&f.dir, &f.request.branch).is_none());
        assert!(!path.with_extension("json").exists());
        for spec in [job.spec, next.spec] {
            context::remove_owned_briefing_file(&context::owned_briefing(&spec).unwrap());
        }
    }
}
