//! Validate local merge jobs and prepare a dedicated agent briefing. Git mutations belong to
//! the launched agent; preparing a job never commits, checks out, or merges anything.
use crate::context;
use crate::git::{self, Worktree};
use crate::model::{MERGE_SCOPE, Project, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub source: String,
    pub source_branch: String,
    pub destination: String,
    pub destination_branch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeOutcome {
    Merged,
    AlreadyIntegrated,
    InProgress,
    Dirty,
    NotMerged,
}

const OPERATION_MARKERS: [&str; 6] = [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
];

/// Check live Git state without changing either worktree.
/// Active operations and uncommitted work take precedence over commit ancestry.
///
/// # Errors
/// Fails for foreign, missing or changed worktrees, or Git errors.
pub fn outcome(project: &Project, request: &MergeRequest) -> Result<MergeOutcome> {
    let trees = git::worktrees(Path::new(&project.root));
    let source = checked_tree(&trees, &request.source, "source")?;
    let destination = checked_tree(&trees, &request.destination, "destination")?;
    ensure!(
        source.path != destination.path,
        "Choose a different destination worktree"
    );
    let common = git::common_dir(Path::new(&project.root))?.canonicalize()?;
    for path in [&source.path, &destination.path] {
        owned_dirs(Path::new(path), &common)?;
    }
    for path in [&source.path, &destination.path] {
        let markers = git::run(
            git::git(Path::new(path))
                .args(["rev-parse", "--path-format=absolute"])
                .args(
                    OPERATION_MARKERS
                        .iter()
                        .flat_map(|marker| ["--git-path", marker]),
                ),
        )?;
        if markers.lines().any(|path| Path::new(path).exists()) {
            return Ok(MergeOutcome::InProgress);
        }
    }
    ensure!(
        source.branch.as_deref() == Some(&request.source_branch)
            && destination.branch.as_deref() == Some(&request.destination_branch),
        "The merge branches changed"
    );
    for path in [&source.path, &destination.path] {
        if !git::run(git::git(Path::new(path)).args([
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]))?
        .is_empty()
        {
            return Ok(MergeOutcome::Dirty);
        }
    }
    let root = Path::new(&destination.path);
    let ancestor = git::git(root)
        .args([
            "merge-base",
            "--is-ancestor",
            &source.head,
            &destination.head,
        ])
        .status()?;
    if !ancestor.success() {
        ensure!(ancestor.code() == Some(1), "Couldn't check merge ancestry");
        return Ok(MergeOutcome::NotMerged);
    }
    let parents = git::run(git::git(root).args(["rev-list", "--parents", "-1", "HEAD"]))?;
    Ok(
        if parents.split_whitespace().skip(2).any(|p| p == source.head) {
            MergeOutcome::Merged
        } else {
            MergeOutcome::AlreadyIntegrated
        },
    )
}

pub struct AgentJob {
    pub terminal: TerminalSpec,
    pub spec: SessionSpec,
}

/// Read both metadata paths in one process, resolving linked-worktree indirection.
fn git_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    git::run(git::git(root).args([
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
    ]))?
    .lines()
    .map(|path| Path::new(path).canonicalize().map_err(Into::into))
    .collect()
}

pub(crate) fn check_owned_dirs(dirs: &[PathBuf], root: &Path, common: &Path) -> Result<()> {
    ensure!(
        dirs.len() == 2 && dirs[1] == common,
        "The worktree at {} isn't in this project's repository",
        root.display()
    );
    Ok(())
}

pub(crate) fn owned_dirs(root: &Path, common: &Path) -> Result<Vec<PathBuf>> {
    let dirs = git_dirs(root)?;
    check_owned_dirs(&dirs, root, common)?;
    Ok(dirs)
}

fn clean(
    tree: &mut Worktree,
    expected_branch: &str,
    role: &str,
    common: &Path,
) -> Result<Vec<PathBuf>> {
    let root = Path::new(&tree.path);
    // Read ownership, live revision and every operation marker in one process.
    let metadata = git::run(
        git::git(root)
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--git-dir",
                "--git-common-dir",
                "HEAD",
                "--symbolic-full-name",
                "HEAD",
            ])
            .args(
                OPERATION_MARKERS
                    .iter()
                    .flat_map(|marker| ["--git-path", marker]),
            ),
    )?;
    let mut lines = metadata.lines();
    let dirs = lines
        .by_ref()
        .take(2)
        .map(|path| Path::new(path).canonicalize().map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    check_owned_dirs(&dirs, root, common)?;
    let head = lines.next().context("Missing worktree HEAD")?;
    let branch = lines
        .next()
        .and_then(|line| line.strip_prefix("refs/heads/"));
    ensure!(
        branch.is_some(),
        "The {role} worktree has a detached HEAD; check out a branch first"
    );
    ensure!(
        branch == Some(expected_branch),
        "The {role} branch changed; refresh Review and try again"
    );
    tree.head = head.into();
    tree.branch = branch.map(str::to_owned);
    ensure!(
        lines.all(|path| !Path::new(path).exists()),
        "The {role} worktree has an operation in progress; finish or abort it first"
    );
    let status = git::run(git::git(root).args(["status", "--porcelain", "--untracked-files=all"]))?;
    ensure!(
        status.is_empty(),
        "The {role} worktree has uncommitted changes; commit or clear them before merging"
    );
    Ok(dirs)
}

fn checked_tree(trees: &[Worktree], path: &str, role: &str) -> Result<Worktree> {
    let tree = trees.iter().find(|t| t.path == path).with_context(|| {
        format!("The {role} worktree is missing or isn't in this project's repository")
    })?;
    Ok(tree.clone())
}

/// Validate the selected checkouts again immediately before building the launch.
///
/// # Errors
/// Fails for missing, foreign, detached, identical, dirty, or busy worktrees, or briefing I/O.
pub fn prepare(
    project: &Project,
    request: &MergeRequest,
    terminal: &TerminalSpec,
    policy: &dyn Policy,
) -> Result<AgentJob> {
    prepare_with_auto(project, request, terminal, policy, None)
}

/// Prepare a merge with optional Auto instructions.
///
/// # Errors
/// As [`prepare`].
pub fn prepare_with_auto(
    project: &Project,
    request: &MergeRequest,
    terminal: &TerminalSpec,
    policy: &dyn Policy,
    auto: Option<&context::AutoBrief>,
) -> Result<AgentJob> {
    let trees = git::worktrees(Path::new(&project.root));
    let mut source = checked_tree(&trees, &request.source, "source")?;
    let mut destination = checked_tree(&trees, &request.destination, "destination")?;
    ensure!(
        source.path != destination.path && source.branch != destination.branch,
        "Choose a different destination branch and worktree"
    );
    let common = git::common_dir(Path::new(&project.root))?.canonicalize()?;
    clean(&mut source, &request.source_branch, "source", &common)?;
    let destination_dirs = clean(
        &mut destination,
        &request.destination_branch,
        "destination",
        &common,
    )?;
    let mut terminal = terminal.clone();
    // One slot per destination, regardless of source branch or agent preset.
    terminal.id = crate::workspace::session_id(&destination.path, MERGE_SCOPE, "destination");
    terminal.name = format!(
        "Merge {} → {}",
        request.source_branch, request.destination_branch
    );
    let mut text = format!(
        "# Patchbay local merge\n\nProject: {}\n\nSource worktree: {}\nSource branch: {}\nSource HEAD: {}\n\nDestination worktree: {}\nDestination branch: {}\nDestination HEAD: {}\n\n\
         Integrate the entire committed source branch into the destination branch. Review's component filters do not limit this job.\n\n\
         Before changing anything, verify both paths still belong to this repository, both branches and HEADs still match the values above, both worktrees are clean (including untracked files), and neither has a merge, rebase, cherry-pick, or revert in progress. Stop and report if a precondition changed.\n\n\
         Work only in the destination worktree. Merge the source commit shown above using git merge --no-commit --no-ff, resolving conflicts while preserving the intent of both branches. Read the repository's contribution instructions and run the relevant checks. Complete the local merge commit only after those checks pass. If already integrated, report that no merge is needed. If blocked or checks fail, report what remains and leave the work available for user review. Never reset, discard, stash, or commit unrelated changes. Do not modify the source worktree, push, or delete branches or worktrees.\n",
        project.name,
        source.path,
        request.source_branch,
        source.head,
        destination.path,
        request.destination_branch,
        destination.head,
    );
    if let Some(findings) = crate::reviews::read(Path::new(&project.root), &request.source_branch) {
        let file = crate::reviews::file(Path::new(&project.root), &request.source_branch)?;
        text.push_str(&format!(
            "\n## Review findings\n\nFindings file: {}\nReview saved at Unix milliseconds: {}\nReviewed HEAD matches source HEAD: {}\n\nRead these findings and mention unresolved findings in your report. Do not fix them unless the merge requires it.\n",
            file.display(), findings.modified_ms, findings.reviewed_head.as_deref() == Some(source.head.as_str()),
        ));
    }
    if let Some(auto) = auto {
        text.push_str(&auto.markdown("merge"));
    }
    // Linked worktrees write their private index/HEAD and the shared object/ref store.
    let mut dirs = destination_dirs;
    dirs.sort();
    dirs.dedup();
    let mut scoped = project.clone();
    scoped.root.clone_from(&destination.path);
    scoped.components.clear();
    scoped.links.clear();
    scoped.groups.clear();
    let mut spec = context::merge_agent_spec(&scoped, &terminal, &text, dirs, policy)?;
    spec.merge_source = Some(PathBuf::from(&source.path));
    Ok(AgentJob { terminal, spec })
}

/// Validate only the recorded destination before granting resume access.
/// Unrelated worktrees never widen the grant or prevent a merge from resuming.
///
/// # Errors
/// Fails if the destination is missing, no longer registered, or belongs to another repo.
pub fn resume_roots(root: &Path, spec: &SessionSpec) -> Result<Vec<PathBuf>> {
    let common = git::common_dir(root)?.canonicalize()?;
    let trees = git::worktrees(root);
    let path = spec.cwd.canonicalize()?;
    ensure!(
        trees.iter().any(|tree| Path::new(&tree.path) == path),
        "The merge worktree at {} is no longer registered",
        path.display()
    );
    let mut roots = owned_dirs(&path, &common)?;
    roots.push(path);
    roots.sort();
    roots.dedup();
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TerminalKind;
    use crate::policy::AllowAll;
    use std::fs;

    struct Fixture {
        dir: PathBuf,
        project: Project,
        request: MergeRequest,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("patchbay-merge-{}", uuid::Uuid::new_v4()));
            let root = dir.join("main");
            fs::create_dir_all(&root).unwrap();
            git::run(git::git(&root).args(["init", "-q", "-b", "main"])).unwrap();
            git::run(git::git(&root).args(["config", "user.name", "Merge test"])).unwrap();
            git::run(git::git(&root).args(["config", "user.email", "merge@patchbay.invalid"]))
                .unwrap();
            git::run(git::git(&root).args(["config", "commit.gpgsign", "false"])).unwrap();
            fs::write(root.join("file.txt"), "base\n").unwrap();
            git::run(git::git(&root).args(["add", "."])).unwrap();
            git::run(git::git(&root).args(["commit", "-qm", "base"])).unwrap();
            let source = dir.join("feature");
            git::run(git::git(&root).args([
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                source.to_str().unwrap(),
            ]))
            .unwrap();
            let root = root.canonicalize().unwrap();
            let source = source.canonicalize().unwrap();
            let project = Project {
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Merge test".into(),
                root: root.to_string_lossy().into(),
                components: vec![],
                links: vec![],
                groups: vec![],
            };
            let request = MergeRequest {
                source: source.to_string_lossy().into(),
                source_branch: "feature".into(),
                destination: project.root.clone(),
                destination_branch: "main".into(),
            };
            Self {
                dir,
                project,
                request,
            }
        }
        fn terminal(command: &str) -> TerminalSpec {
            serde_json::from_value(serde_json::json!({"id":"agent", "name":"Agent", "kind":"agent", "command":command})).unwrap()
        }
        fn prepare(&self) -> Result<AgentJob> {
            prepare(
                &self.project,
                &self.request,
                &Self::terminal("claude"),
                &AllowAll,
            )
        }
        fn error(&self) -> String {
            self.prepare()
                .err()
                .expect("expected validation error")
                .to_string()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn outcome_checks_ancestry_operation_and_dirt() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        let source = Path::new(&f.request.source);
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::AlreadyIntegrated
        );
        fs::write(source.join("new.txt"), "feature\n").unwrap();
        git::run(git::git(source).args(["add", "."])).unwrap();
        git::run(git::git(source).args(["commit", "-qm", "feature"])).unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::NotMerged
        );
        let review =
            git::review_branch(&f.project, vec![], Some(&f.request.source), Some("main")).unwrap();
        assert!(review.ahead);
        assert!(
            review.changes[crate::model::PROJECT_SCOPE]
                .iter()
                .any(|file| file.path == "new.txt")
        );
        fs::write(source.join("dirt"), "untracked").unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::Dirty
        );
        fs::remove_file(source.join("dirt")).unwrap();
        git::run(git::git(root).args(["merge", "--no-commit", "--no-ff", "feature"])).unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::InProgress
        );
        git::run(git::git(root).args(["commit", "-qm", "merge feature"])).unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::Merged
        );
    }

    #[test]
    fn integration_requires_clean_source_and_destination() {
        let f = Fixture::new();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::AlreadyIntegrated
        );
        for path in [&f.request.source, &f.request.destination] {
            let root = Path::new(path);
            fs::write(root.join("untracked"), "uncommitted work").unwrap();
            assert_eq!(
                outcome(&f.project, &f.request).unwrap(),
                MergeOutcome::Dirty
            );
            fs::remove_file(root.join("untracked")).unwrap();
            fs::write(root.join("file.txt"), "uncommitted").unwrap();
            assert_eq!(
                outcome(&f.project, &f.request).unwrap(),
                MergeOutcome::Dirty
            );
            git::run(git::git(root).args(["checkout", "--", "file.txt"])).unwrap();
        }
        let source = Path::new(&f.request.source);
        fs::write(source.join("file.txt"), "feature").unwrap();
        git::run(git::git(source).args(["add", "file.txt"])).unwrap();
        git::run(git::git(source).args(["commit", "-qm", "feature"])).unwrap();
        let destination = Path::new(&f.request.destination);
        git::run(git::git(destination).args(["merge", "--no-ff", "-qm", "merge", "feature"]))
            .unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::Merged
        );
        for path in [source, destination] {
            fs::write(path.join("file.txt"), "later edit").unwrap();
            assert_eq!(
                outcome(&f.project, &f.request).unwrap(),
                MergeOutcome::Dirty
            );
            git::run(git::git(path).args(["checkout", "--", "file.txt"])).unwrap();
        }
    }

    #[test]
    fn detached_rebase_is_in_progress_before_branch_validation() {
        let f = Fixture::new();
        let source = Path::new(&f.request.source);
        git::run(git::git(source).args(["checkout", "--detach", "-q"])).unwrap();
        let marker = git::run(git::git(source).args([
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "rebase-merge",
        ]))
        .unwrap();
        fs::create_dir(marker).unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::InProgress
        );
    }

    #[test]
    fn auto_context_is_opt_in_for_jobs() {
        let f = Fixture::new();
        let auto = context::AutoBrief {
            goal: "Goal".into(),
            fix_floor: None,
            effort_note: "Thorough".into(),
            commit: true,
        };
        let plain = f.prepare().unwrap();
        let automatic = prepare_with_auto(
            &f.project,
            &f.request,
            &Fixture::terminal("claude"),
            &AllowAll,
            Some(&auto),
        )
        .unwrap();
        let read =
            |job: &AgentJob| fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
        assert!(!read(&plain).contains("## Auto mode"));
        assert!(read(&automatic).contains("## Auto mode"));
        for job in [plain, automatic] {
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
    }

    #[test]
    fn builds_a_destination_merge_with_native_prompt_and_no_task_plan() {
        let f = Fixture::new();
        for command in [
            "claude --model sonnet",
            "codex --model test",
            "printf fixture",
        ] {
            let job = prepare(
                &f.project,
                &f.request,
                &Fixture::terminal(command),
                &AllowAll,
            )
            .unwrap();
            assert_eq!(job.spec.cwd, PathBuf::from(&f.request.destination));
            assert_eq!(
                job.spec.merge_source,
                Some(PathBuf::from(&f.request.source))
            );
            assert!(job.spec.exclusive_cwd);
            assert!(!job.spec.dirs.contains(&PathBuf::from(&f.request.source)));
            let source_grant = format!(" --add-dir {}", context::quote_argument(&f.request.source));
            assert!(!job.spec.command.contains(&source_grant));
            assert!(
                !job.spec
                    .resume_command
                    .as_ref()
                    .unwrap()
                    .contains(&source_grant)
            );
            assert!(!job.spec.service);
            let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
            assert!(body.contains("Source branch: feature"));
            assert!(body.contains("Destination branch: main"));
            assert!(body.contains("--no-commit --no-ff"));
            assert!(body.contains("checks fail"));
            assert!(!body.contains("shared plan"));
            assert!(!job.spec.env.contains_key(crate::plans::PLAN_FILE_ENV));
            if command.starts_with("printf") {
                assert!(job.spec.notice.is_some());
            } else {
                assert!(job.spec.command.contains("Complete the local merge"));
            }
            let resume = job.spec.resume_command.as_ref().unwrap();
            assert!(
                !resume.contains("Complete the local merge described in your Patchbay briefing")
            );
            assert!(job.spec.command.starts_with(resume));
            assert!(job.spec.owns_briefing);
            assert!(job.spec.dirs.iter().any(|d| d.ends_with(".git")));
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
        // Preparation is read-only with respect to repository state.
        assert!(
            git::run(git::git(Path::new(&f.request.destination)).args(["status", "--porcelain"]))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            git::run(git::git(Path::new(&f.request.destination)).args(["rev-parse", "HEAD"]))
                .unwrap(),
            git::run(git::git(Path::new(&f.request.source)).args(["rev-parse", "HEAD"])).unwrap()
        );
    }

    #[test]
    fn merge_briefing_points_to_review_findings_and_identifies_stale_heads() {
        let f = Fixture::new();
        let review = crate::reviews::prepare(
            &f.project,
            &crate::reviews::ReviewRequest {
                worktree: f.request.source.clone(),
                branch: "feature".into(),
                base: "main".into(),
            },
            &Fixture::terminal("claude"),
            &AllowAll,
        )
        .unwrap()
        .job;
        let findings = crate::reviews::file(Path::new(&f.project.root), "feature").unwrap();
        fs::write(&findings, "P1 file.txt:1: sample finding").unwrap();
        // Ensure the file postdates the kickoff, including on coarse clocks.
        fs::File::options()
            .write(true)
            .open(&findings)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(1))
            .unwrap();
        for current in [true, false] {
            if !current {
                git::run(git::git(Path::new(&f.request.source)).args([
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "after review",
                ]))
                .unwrap();
            }
            let job = f.prepare().unwrap();
            let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
            assert!(body.contains(&findings.display().to_string()));
            assert!(body.contains(&format!("Reviewed HEAD matches source HEAD: {current}")));
            assert!(body.contains("mention unresolved findings"));
            assert!(body.contains("Do not fix them unless the merge requires it"));
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
        context::remove_owned_briefing_file(&context::owned_briefing(&review.spec).unwrap());
    }

    #[test]
    fn rejects_untracked_and_tracked_changes_in_either_worktree() {
        let f = Fixture::new();
        for (root, role) in [
            (&f.request.source, "source"),
            (&f.request.destination, "destination"),
        ] {
            let untracked = Path::new(root).join("new.txt");
            fs::write(&untracked, "new").unwrap();
            assert!(
                f.error()
                    .contains(&format!("{role} worktree has uncommitted"))
            );
            fs::remove_file(untracked).unwrap();
            fs::write(Path::new(root).join("file.txt"), "edited\n").unwrap();
            assert!(
                f.error()
                    .contains(&format!("{role} worktree has uncommitted"))
            );
            git::run(git::git(Path::new(root)).args(["checkout", "--", "file.txt"])).unwrap();
        }
    }

    #[test]
    fn rejects_missing_foreign_detached_and_stale_worktrees() {
        let mut f = Fixture::new();
        let original = f.request.source.clone();
        f.request.source = f.dir.join("missing").to_string_lossy().into();
        assert!(f.error().contains("missing or isn't"));
        f.request.source = f.dir.to_string_lossy().into();
        assert!(f.error().contains("isn't in this project's repository"));
        f.request.source = original;
        git::run(git::git(Path::new(&f.request.source)).args(["checkout", "--detach", "-q"]))
            .unwrap();
        assert!(f.error().contains("detached HEAD"));
        git::run(git::git(Path::new(&f.request.source)).args(["checkout", "-q", "-b", "changed"]))
            .unwrap();
        assert!(f.error().contains("branch changed"));
    }

    #[test]
    fn rejects_same_destination_and_in_progress_operations() {
        let mut f = Fixture::new();
        let original = f.request.destination.clone();
        f.request.destination.clone_from(&f.request.source);
        f.request
            .destination_branch
            .clone_from(&f.request.source_branch);
        assert!(f.error().contains("different destination"));
        f.request.destination = original;
        f.request.destination_branch = "main".into();
        for root in [&f.request.source, &f.request.destination] {
            for marker in [
                "MERGE_HEAD",
                "rebase-merge",
                "rebase-apply",
                "CHERRY_PICK_HEAD",
                "REVERT_HEAD",
                "sequencer",
            ] {
                let path = PathBuf::from(
                    git::run(git::git(Path::new(root)).args([
                        "rev-parse",
                        "--path-format=absolute",
                        "--git-path",
                        marker,
                    ]))
                    .unwrap(),
                );
                fs::write(&path, "marker").unwrap();
                assert!(f.error().contains("operation in progress"));
                assert_eq!(
                    outcome(&f.project, &f.request).unwrap(),
                    MergeOutcome::InProgress
                );
                fs::remove_file(path).unwrap();
            }
        }
    }

    #[test]
    fn uses_one_destination_slot_and_keeps_briefings_immutable_between_sources() {
        let mut f = Fixture::new();
        let first = f.prepare().unwrap();
        let root = Path::new(&f.project.root);
        let second = f.dir.join("second");
        git::run(git::git(root).args([
            "worktree",
            "add",
            "-q",
            "-b",
            "second",
            second.to_str().unwrap(),
        ]))
        .unwrap();
        f.request.source = second.canonicalize().unwrap().to_string_lossy().into();
        f.request.source_branch = "second".into();
        let next = prepare(
            &f.project,
            &f.request,
            &Fixture::terminal("codex"),
            &AllowAll,
        )
        .unwrap();
        assert_eq!(first.terminal.id, next.terminal.id);
        assert!(first.spec.id.is_empty());
        assert!(next.spec.id.is_empty());
        assert_ne!(
            first.spec.env[context::CONTEXT_ENV],
            next.spec.env[context::CONTEXT_ENV]
        );
        assert!(
            fs::read_to_string(&first.spec.env[context::CONTEXT_ENV])
                .unwrap()
                .contains("Source branch: feature")
        );
    }

    #[test]
    fn rejects_foreign_worktrees_on_launch_and_foreign_destinations_on_resume() {
        for destination in [false, true] {
            let mut f = Fixture::new();
            if destination {
                std::mem::swap(&mut f.request.source, &mut f.request.destination);
                std::mem::swap(
                    &mut f.request.source_branch,
                    &mut f.request.destination_branch,
                );
            }
            let job = f.prepare().unwrap();
            let replaced = if destination {
                &f.request.destination
            } else {
                &f.request.source
            };
            fs::remove_dir_all(replaced).unwrap();
            fs::create_dir_all(replaced).unwrap();
            git::run(git::git(Path::new(replaced)).args(["init", "-q", "-b", "feature"])).unwrap();
            git::run(git::git(Path::new(replaced)).args(["config", "user.name", "Foreign"]))
                .unwrap();
            git::run(git::git(Path::new(replaced)).args([
                "config",
                "user.email",
                "foreign@patchbay.invalid",
            ]))
            .unwrap();
            git::run(git::git(Path::new(replaced)).args([
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "foreign",
            ]))
            .unwrap();
            assert!(f.error().contains("isn't in this project's repository"));
            let resumed = resume_roots(Path::new(&f.project.root), &job.spec);
            if destination {
                assert!(
                    resumed
                        .unwrap_err()
                        .to_string()
                        .contains("isn't in this project's repository")
                );
            } else {
                assert!(resumed.is_ok());
            }
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
    }

    #[test]
    fn resume_only_grants_the_destination_and_survives_source_removal() {
        let f = Fixture::new();
        let job = f.prepare().unwrap();
        let unrelated = f.dir.join("unrelated");
        git::run(git::git(Path::new(&f.project.root)).args([
            "worktree",
            "add",
            "-q",
            "-b",
            "unrelated",
            unrelated.to_str().unwrap(),
        ]))
        .unwrap();
        let unrelated = unrelated.canonicalize().unwrap();
        let roots = resume_roots(Path::new(&f.project.root), &job.spec).unwrap();
        assert!(!roots.contains(&PathBuf::from(&f.request.source)));
        assert!(crate::files::resolve(&roots, Path::new(&f.request.source)).is_err());
        let record: crate::session::Record = serde_json::from_value(serde_json::json!({
            "id":"merge", "metadata": {
                "projectId":"p", "projectName":"P", "projectRoot":f.project.root,
                "componentId":MERGE_SCOPE, "terminalId":"merge", "name":"Merge", "kind":"agent"
            },
            "spec":job.spec, "snapshot":null, "history":[], "interrupted":true, "requestIds":[]
        }))
        .unwrap();
        crate::session::check_resume(&record, &roots).unwrap();
        assert!(!roots.contains(&unrelated));
        assert!(crate::files::resolve(&roots, &unrelated).is_err());
        fs::remove_file(unrelated.join(".git")).unwrap();
        assert_eq!(
            resume_roots(Path::new(&f.project.root), &job.spec).unwrap(),
            roots
        );
        git::run(git::git(Path::new(&f.project.root)).args([
            "worktree",
            "remove",
            &f.request.source,
        ]))
        .unwrap();
        assert_eq!(
            resume_roots(Path::new(&f.project.root), &job.spec).unwrap(),
            roots
        );
        crate::session::check_resume(&record, &roots).unwrap();
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn linked_destination_keeps_only_its_private_and_shared_metadata_grants() {
        let mut f = Fixture::new();
        std::mem::swap(&mut f.request.source, &mut f.request.destination);
        std::mem::swap(
            &mut f.request.source_branch,
            &mut f.request.destination_branch,
        );
        let job = f.prepare().unwrap();
        let common = git::common_dir(Path::new(&f.project.root))
            .unwrap()
            .canonicalize()
            .unwrap();
        let mut expected = owned_dirs(&job.spec.cwd, &common).unwrap();
        expected.sort();
        assert_eq!(job.spec.dirs, expected);
        let roots = resume_roots(Path::new(&f.project.root), &job.spec).unwrap();
        assert!(!roots.contains(&PathBuf::from(&f.request.source)));
        assert!(crate::files::resolve(&roots, Path::new(&f.request.source)).is_err());
        git::run(git::git(Path::new(&f.project.root)).args([
            "worktree",
            "remove",
            &f.request.destination,
        ]))
        .unwrap();
        assert!(resume_roots(Path::new(&f.project.root), &job.spec).is_err());
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn preparation_never_runs_fsmonitor_or_refreshes_the_index() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let hook = f.dir.join("fsmonitor");
        let called = f.dir.join("hook-called");
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\n", called.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git::run(git::git(Path::new(&f.project.root)).args([
            "config",
            "core.fsmonitor",
            hook.to_str().unwrap(),
        ]))
        .unwrap();
        let index = git_dirs(Path::new(&f.request.source)).unwrap()[0].join("index");
        let before = fs::read(&index).unwrap();
        // Change only the stat data, which a locking status would write back to the index.
        fs::write(Path::new(&f.request.source).join("file.txt"), "base\n").unwrap();
        let job = f.prepare().unwrap();
        assert!(!called.exists());
        assert_eq!(fs::read(index).unwrap(), before);
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn rejects_non_agent_commands() {
        let f = Fixture::new();
        let mut terminal = Fixture::terminal("claude");
        terminal.kind = TerminalKind::Shell;
        assert!(prepare(&f.project, &f.request, &terminal, &AllowAll).is_err());
    }
}
