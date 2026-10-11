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
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub source: String,
    pub source_branch: String,
    pub destination: String,
    pub destination_branch: String,
}

pub struct MergeJob {
    pub terminal: TerminalSpec,
    pub spec: SessionSpec,
}

fn git_output(root: &Path, args: &[&str]) -> Result<String> {
    let out = git::git(root).args(args).stdin(Stdio::null()).output()?;
    ensure!(
        out.status.success(),
        "Git check failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}

/// Read both metadata paths in one process, resolving linked-worktree indirection.
fn git_dirs(root: &Path) -> Result<Vec<PathBuf>> {
    git_output(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ],
    )?
    .lines()
    .map(|path| Path::new(path).canonicalize().map_err(Into::into))
    .collect()
}

fn owned_dirs(root: &Path, common: &Path) -> Result<Vec<PathBuf>> {
    let dirs = git_dirs(root)?;
    ensure!(
        dirs.len() == 2 && dirs[1] == common,
        "The worktree at {} isn't in this project's repository",
        root.display()
    );
    Ok(dirs)
}

fn clean(tree: &mut Worktree, role: &str, common: &Path) -> Result<Vec<PathBuf>> {
    let root = Path::new(&tree.path);
    // Read ownership, live revision and every operation marker in one process.
    let metadata = git_output(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
            "HEAD",
            "--symbolic-full-name",
            "HEAD",
            "--git-path",
            "MERGE_HEAD",
            "--git-path",
            "rebase-merge",
            "--git-path",
            "rebase-apply",
            "--git-path",
            "CHERRY_PICK_HEAD",
            "--git-path",
            "REVERT_HEAD",
            "--git-path",
            "sequencer",
        ],
    )?;
    let mut lines = metadata.lines();
    let dirs = lines
        .by_ref()
        .take(2)
        .map(|path| Path::new(path).canonicalize().map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        dirs.len() == 2 && dirs[1] == common,
        "The {role} worktree isn't in this project's repository"
    );
    let head = lines.next().context("Missing worktree HEAD")?;
    let branch = lines
        .next()
        .and_then(|line| line.strip_prefix("refs/heads/"));
    ensure!(
        branch.is_some(),
        "The {role} worktree has a detached HEAD; check out a branch first"
    );
    ensure!(
        branch == tree.branch.as_deref(),
        "The {role} branch changed; refresh Review and try again"
    );
    tree.head = head.into();
    ensure!(
        lines.all(|path| !Path::new(path).exists()),
        "The {role} worktree has an operation in progress; finish or abort it first"
    );
    let status = git_output(root, &["status", "--porcelain", "--untracked-files=all"])?;
    ensure!(
        status.is_empty(),
        "The {role} worktree has uncommitted changes; commit or clear them before merging"
    );
    Ok(dirs)
}

fn checked_tree(trees: &[Worktree], path: &str, branch: &str, role: &str) -> Result<Worktree> {
    let tree = trees.iter().find(|t| t.path == path).with_context(|| {
        format!("The {role} worktree is missing or isn't in this project's repository")
    })?;
    ensure!(
        tree.branch.is_some(),
        "The {role} worktree has a detached HEAD; check out a branch first"
    );
    ensure!(
        tree.branch.as_deref() == Some(branch),
        "The {role} branch changed; refresh Review and try again"
    );
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
) -> Result<MergeJob> {
    let trees = git::worktrees(Path::new(&project.root));
    let mut source = checked_tree(&trees, &request.source, &request.source_branch, "source")?;
    let mut destination = checked_tree(
        &trees,
        &request.destination,
        &request.destination_branch,
        "destination",
    )?;
    ensure!(
        source.path != destination.path && source.branch != destination.branch,
        "Choose a different destination branch and worktree"
    );
    let common = git_dirs(Path::new(&project.root))?
        .pop()
        .context("Missing Git common directory")?;
    clean(&mut source, "source", &common)?;
    let destination_dirs = clean(&mut destination, "destination", &common)?;
    let mut terminal = terminal.clone();
    // One slot per destination, regardless of source branch or agent preset.
    terminal.id = crate::workspace::session_id(&destination.path, MERGE_SCOPE, "destination");
    terminal.name = format!(
        "Merge {} → {}",
        request.source_branch, request.destination_branch
    );
    let text = format!(
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
    // Keep the recorded source first so recovery can validate this exact pair.
    let mut dirs = vec![PathBuf::from(&source.path)];
    // Linked worktrees write their private index/HEAD and the shared object/ref store.
    for dir in destination_dirs {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    let mut scoped = project.clone();
    scoped.root.clone_from(&destination.path);
    scoped.components.clear();
    scoped.links.clear();
    scoped.groups.clear();
    let spec = context::merge_agent_spec(&scoped, &terminal, &text, dirs, policy)?;
    Ok(MergeJob { terminal, spec })
}

/// Validate only the recorded source and destination before granting resume access.
/// Unrelated worktrees never widen the grant or prevent a merge from resuming.
///
/// # Errors
/// Fails if either selected checkout is missing, no longer registered, or belongs to another repo.
pub fn resume_roots(root: &Path, spec: &SessionSpec) -> Result<Vec<PathBuf>> {
    let common = git_dirs(root)?
        .pop()
        .context("Missing Git common directory")?;
    let trees = git::worktrees(root);
    let source = spec.dirs.first().context("Missing recorded merge source")?;
    let mut roots = Vec::new();
    for path in [&spec.cwd, source] {
        let path = path.canonicalize()?;
        ensure!(
            trees.iter().any(|tree| Path::new(&tree.path) == path),
            "The merge worktree at {} is no longer registered",
            path.display()
        );
        let dirs = owned_dirs(&path, &common)?;
        // Only destination metadata was granted on launch.
        if path == spec.cwd {
            roots.extend(dirs);
        }
        roots.push(path);
    }
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
            git_output(&root, &["init", "-q", "-b", "main"]).unwrap();
            git_output(&root, &["config", "user.name", "Merge test"]).unwrap();
            git_output(&root, &["config", "user.email", "merge@patchbay.invalid"]).unwrap();
            git_output(&root, &["config", "commit.gpgsign", "false"]).unwrap();
            fs::write(root.join("file.txt"), "base\n").unwrap();
            git_output(&root, &["add", "."]).unwrap();
            git_output(&root, &["commit", "-qm", "base"]).unwrap();
            let source = dir.join("feature");
            git_output(
                &root,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "feature",
                    source.to_str().unwrap(),
                ],
            )
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
        fn prepare(&self) -> Result<MergeJob> {
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
            assert!(job.spec.dirs.iter().any(|d| d.ends_with(".git")));
        }
        // Preparation is read-only with respect to repository state.
        assert!(
            git_output(
                Path::new(&f.request.destination),
                &["status", "--porcelain"]
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            git_output(Path::new(&f.request.destination), &["rev-parse", "HEAD"]).unwrap(),
            git_output(Path::new(&f.request.source), &["rev-parse", "HEAD"]).unwrap()
        );
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
            git_output(Path::new(root), &["checkout", "--", "file.txt"]).unwrap();
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
        git_output(
            Path::new(&f.request.source),
            &["checkout", "--detach", "-q"],
        )
        .unwrap();
        assert!(f.error().contains("detached HEAD"));
        git_output(
            Path::new(&f.request.source),
            &["checkout", "-q", "-b", "changed"],
        )
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
                    git_output(
                        Path::new(root),
                        &["rev-parse", "--path-format=absolute", "--git-path", marker],
                    )
                    .unwrap(),
                );
                fs::write(&path, "marker").unwrap();
                assert!(f.error().contains("operation in progress"));
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
        git_output(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "second",
                second.to_str().unwrap(),
            ],
        )
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
    fn rejects_foreign_repositories_at_stale_registered_paths_on_launch_and_resume() {
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
            git_output(Path::new(replaced), &["init", "-q", "-b", "feature"]).unwrap();
            git_output(Path::new(replaced), &["config", "user.name", "Foreign"]).unwrap();
            git_output(
                Path::new(replaced),
                &["config", "user.email", "foreign@patchbay.invalid"],
            )
            .unwrap();
            git_output(
                Path::new(replaced),
                &[
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "foreign",
                ],
            )
            .unwrap();
            assert!(f.error().contains("isn't in this project's repository"));
            assert!(
                resume_roots(Path::new(&f.project.root), &job.spec)
                    .unwrap_err()
                    .to_string()
                    .contains("isn't in this project's repository")
            );
            context::remove_merge_briefing(&job.spec);
        }
    }

    #[test]
    fn resume_only_grants_the_original_pair_and_ignores_broken_unrelated_worktrees() {
        let f = Fixture::new();
        let job = f.prepare().unwrap();
        let unrelated = f.dir.join("unrelated");
        git_output(
            Path::new(&f.project.root),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "unrelated",
                unrelated.to_str().unwrap(),
            ],
        )
        .unwrap();
        let unrelated = unrelated.canonicalize().unwrap();
        let roots = resume_roots(Path::new(&f.project.root), &job.spec).unwrap();
        assert!(!roots.contains(&unrelated));
        assert!(crate::files::resolve(&roots, &unrelated).is_err());
        fs::remove_file(unrelated.join(".git")).unwrap();
        assert_eq!(
            resume_roots(Path::new(&f.project.root), &job.spec).unwrap(),
            roots
        );
        fs::remove_dir_all(&f.request.source).unwrap();
        assert!(resume_roots(Path::new(&f.project.root), &job.spec).is_err());
        context::remove_merge_briefing(&job.spec);
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
        git_output(
            Path::new(&f.project.root),
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        )
        .unwrap();
        let index = git_dirs(Path::new(&f.request.source)).unwrap()[0].join("index");
        let before = fs::read(&index).unwrap();
        // Change only the stat data, which a locking status would write back to the index.
        fs::write(Path::new(&f.request.source).join("file.txt"), "base\n").unwrap();
        let job = f.prepare().unwrap();
        assert!(!called.exists());
        assert_eq!(fs::read(index).unwrap(), before);
        context::remove_merge_briefing(&job.spec);
    }

    #[test]
    fn rejects_non_agent_commands() {
        let f = Fixture::new();
        let mut terminal = Fixture::terminal("claude");
        terminal.kind = TerminalKind::Shell;
        assert!(prepare(&f.project, &f.request, &terminal, &AllowAll).is_err());
    }
}
