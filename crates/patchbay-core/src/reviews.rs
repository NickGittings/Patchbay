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
    pub truncated: bool,
}

/// A prepared review whose sidecar is already recorded, so findings written as soon
/// as the agent starts are attributed to it. `rollback` restores the previous sidecar
/// when the launch is then refused.
pub struct Prepared {
    pub job: AgentJob,
    sidecar: PathBuf,
    previous: Option<Vec<u8>>,
}

impl Prepared {
    /// Put back the sidecar this review replaced, best-effort.
    pub fn rollback(self) {
        let _ = match &self.previous {
            Some(bytes) => crate::plans::write_atomic(&self.sidecar, bytes),
            None => std::fs::remove_file(&self.sidecar).map_err(Into::into),
        };
        if let Some(file) = context::owned_briefing(&self.job.spec) {
            context::remove_owned_briefing_file(&file);
        }
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
/// Call `Prepared::rollback` if the launch fails.
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
    let branch = git::run(git::git(cwd).args(["symbolic-ref", "--quiet", "--short", "HEAD"]))
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
    };
    // Atomic replacement keeps readers from pairing new findings with a partial sidecar.
    let sidecar = findings.with_extension("json");
    let previous = std::fs::read(&sidecar).ok();
    if let Err(error) = crate::plans::write_atomic(&sidecar, &serde_json::to_vec(&started)?) {
        if let Some(file) = context::owned_briefing(&spec) {
            context::remove_owned_briefing_file(&file);
        }
        return Err(error);
    }
    Ok(Prepared {
        job: AgentJob { terminal, spec },
        sidecar,
        previous,
    })
}

/// Read capped findings. Older findings remain visible, but have no reviewed HEAD.
#[must_use]
pub fn read(root: &Path, branch: &str) -> Option<Findings> {
    let file = file(root, branch).ok()?;
    let started: Started =
        serde_json::from_slice(&std::fs::read(file.with_extension("json")).ok()?).ok()?;
    if started.branch != branch {
        return None;
    }
    let handle = std::fs::File::open(file).ok()?;
    let modified_ms = crate::status::unix_ms(handle.metadata().ok()?.modified().ok()?);
    let (text, truncated) = crate::plans::read_capped(handle).ok()?;
    Some(Findings {
        text,
        modified_ms,
        reviewed_head: (modified_ms > started.started_ms).then_some(started.head),
        base: started.base,
        started_ms: started.started_ms,
        truncated,
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
    let refs =
        git::run(git::git(root).args(["for-each-ref", "--format=%(refname)", "refs/heads/"]))?;
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
        if !refs
            .lines()
            .any(|r| r == format!("refs/heads/{}", started.branch))
        {
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
