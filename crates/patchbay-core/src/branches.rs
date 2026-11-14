//! Explicit local branch management for the open project checkout.
use crate::{
    git,
    session::{Record, Request},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BranchAction {
    Switch { branch: String },
    Rename { branch: String },
    Delete { branch: String },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchResult {
    Applied,
    NeedsStop,
}

/// Validate before asking to stop work, then stop only this worktree's writers on confirmation.
/// Recheck Git and session state after stopping; retained terminal history is preserved.
pub fn apply_with_sessions(
    root: &Path,
    expected_head: &str,
    expected_branch: Option<&str>,
    action: &BranchAction,
    stop_sessions: bool,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<BranchResult> {
    validate(root, expected_head, expected_branch, action)?;
    if !matches!(action, BranchAction::Delete { .. }) {
        let running = running_sessions(root, call)?;
        if !running.is_empty() {
            if !stop_sessions {
                return Ok(BranchResult::NeedsStop);
            }
            for id in &running {
                call(Request::Stop { id: id.clone() })?;
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let remaining = running_sessions(root, call)?;
                if remaining.is_empty() {
                    break;
                }
                ensure!(
                    remaining.iter().all(|id| running.contains(id)),
                    "A terminal or agent started in this worktree; try changing the branch again"
                );
                ensure!(
                    Instant::now() < deadline,
                    "Terminals or agents are still stopping; try changing the branch again"
                );
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    apply(root, expected_head, expected_branch, action)?;
    Ok(BranchResult::Applied)
}

fn running_sessions(
    root: &Path,
    call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
) -> Result<Vec<String>> {
    let root = root.canonicalize()?;
    let trees = git::worktrees(&root);
    let records: Vec<Record> = serde_json::from_value(call(Request::List)?)?;
    Ok(records
        .into_iter()
        .filter(|r| r.snapshot.as_ref().is_some_and(|s| s.running))
        .filter(|r| {
            r.spec.cwd.canonicalize().is_ok_and(|cwd| {
                // A linked worktree can live inside the source folder. Assign a session to
                // the deepest matching worktree so switching source leaves that work alone.
                trees
                    .iter()
                    .filter(|t| cwd.starts_with(&t.path))
                    .max_by_key(|t| Path::new(&t.path).components().count())
                    .is_some_and(|t| Path::new(&t.path) == root)
            })
        })
        .map(|r| r.id)
        .collect())
}

/// Change the open checkout or delete an integrated, unused local branch.
/// The caller must stop concurrent writers before switching or renaming.
/// Never forces a checkout, branch deletion, or rename.
pub fn apply(
    root: &Path,
    expected_head: &str,
    expected_branch: Option<&str>,
    action: &BranchAction,
) -> Result<()> {
    validate(root, expected_head, expected_branch, action)?;
    let repo = git::repo_root(root).context("Open project is not in a Git worktree")?;
    match action {
        BranchAction::Switch { branch } => {
            git::run(git::git(&repo).args(["switch", "--no-guess", "--", branch]))?;
        }
        BranchAction::Rename { branch } => {
            let old = expected_branch.context("A detached checkout has no branch to rename")?;
            git::run(git::git(&repo).args(["branch", "-m", "--", old, branch]))?;
        }
        BranchAction::Delete { branch } => {
            git::run(git::git(&repo).args(["branch", "-d", "--", branch]))?;
        }
    }
    Ok(())
}

fn validate(
    root: &Path,
    expected_head: &str,
    expected_branch: Option<&str>,
    action: &BranchAction,
) -> Result<()> {
    let trees = git::worktrees(root);
    let current = trees
        .iter()
        .find(|t| t.current)
        .context("Open project is not in a Git worktree")?;
    ensure!(
        current.head == expected_head && current.branch.as_deref() == expected_branch,
        "The source checkout changed; refresh the branch list and try again"
    );
    let repo = Path::new(&current.path);
    for marker in [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
    ] {
        let path = git::run(git::git(repo).args(["rev-parse", "--git-path", marker]))?;
        ensure!(
            !repo.join(path).exists(),
            "Finish or abort the active Git operation first"
        );
    }
    let branch = match action {
        BranchAction::Switch { branch }
        | BranchAction::Rename { branch }
        | BranchAction::Delete { branch } => branch,
    };
    // Validate names before passing any user-provided text to Git subcommands.
    git::run(git::git(repo).args(["check-ref-format", "--branch", branch]))?;
    ensure!(
        !branch.starts_with('-') && !branch.starts_with('@'),
        "Choose a literal local branch name"
    );
    let branches = git::branches(repo)?;
    match action {
        BranchAction::Switch { .. } => {
            ensure!(branches.contains(branch), "Choose an existing local branch");
            ensure!(
                !trees.iter().any(|t| t.branch.as_ref() == Some(branch)),
                "This branch is already checked out in a worktree"
            );
            ensure!(
                git::run(git::git(repo).args(["status", "--porcelain", "--untracked-files=all"]))?
                    .is_empty(),
                "Commit or move uncommitted and untracked files before switching branches"
            );
        }
        BranchAction::Rename { .. } => {
            current
                .branch
                .as_ref()
                .context("A detached checkout has no branch to rename")?;
            ensure!(
                !branches.contains(branch),
                "A local branch with this name already exists"
            );
        }
        BranchAction::Delete { .. } => {
            ensure!(branches.contains(branch), "Local branch no longer exists");
            ensure!(
                !trees.iter().any(|t| t.branch.as_ref() == Some(branch)),
                "Switch away from this branch in every worktree before deleting it"
            );
            let head = git::run(git::git(repo).args([
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("refs/heads/{branch}^{{commit}}"),
            ]))?;
            ensure!(
                git::git(repo)
                    .args(["merge-base", "--is-ancestor", &head, "HEAD"])
                    .status()?
                    .success(),
                "Branch has commits not merged into the source checkout; merge it before deleting"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("patchbay-branches-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            for args in [
                vec!["init", "-qb", "main"],
                vec!["config", "user.name", "Test"],
                vec!["config", "user.email", "test@invalid"],
                vec!["config", "commit.gpgsign", "false"],
                vec!["commit", "--allow-empty", "-qm", "base"],
                vec!["branch", "feature"],
            ] {
                git::run(git::git(&root).args(args)).unwrap();
            }
            Self(root.canonicalize().unwrap())
        }
        fn apply(&self, action: BranchAction) -> Result<()> {
            let current = git::worktrees(&self.0)
                .into_iter()
                .find(|t| t.current)
                .unwrap();
            apply(&self.0, &current.head, current.branch.as_deref(), &action)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(id: &str, cwd: &Path, kind: &str, running: bool) -> Record {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "metadata": {
                "projectId": id, "projectName": "Project", "projectRoot": cwd,
                "componentId": "root", "terminalId": id, "name": id, "kind": kind
            },
            "spec": {
                "id": id, "command": "cat", "cwd": cwd, "env": {},
                "ready_when": "", "service": false, "notice": null
            },
            "snapshot": {
                "data": "", "end": 0, "generation": 1, "running": running,
                "startedMs": 1,
                "status": { "active": false, "ready": false, "stopped": false }
            },
            "history": [], "interrupted": false, "requestIds": []
        }))
        .unwrap()
    }

    fn apply_sessions(
        f: &Fixture,
        stop: bool,
        call: &mut impl FnMut(Request) -> Result<serde_json::Value>,
    ) -> Result<BranchResult> {
        let head = git::run(git::git(&f.0).args(["rev-parse", "HEAD"]))?;
        apply_with_sessions(
            &f.0,
            &head,
            Some("main"),
            &BranchAction::Switch {
                branch: "feature".into(),
            },
            stop,
            call,
        )
    }

    #[test]
    fn running_work_requires_confirmation_before_any_stop_or_switch() {
        let f = Fixture::new();
        let records = vec![record("shell", &f.0, "shell", true)];
        let result = apply_sessions(&f, false, &mut |request| {
            assert!(matches!(request, Request::List));
            Ok(serde_json::to_value(&records)?)
        })
        .unwrap();
        assert_eq!(result, BranchResult::NeedsStop);
        assert!(
            git::worktrees(&f.0)
                .iter()
                .any(|t| t.current && t.branch.as_deref() == Some("main"))
        );
    }

    #[test]
    fn confirmation_stops_shells_and_agents_only_in_the_selected_worktree() {
        let f = Fixture::new();
        let linked = f.0.join("linked");
        git::run(git::git(&f.0).args(["worktree", "add", "-b", "other", linked.to_str().unwrap()]))
            .unwrap();
        fs::write(f.0.join(".git/info/exclude"), "linked/\n").unwrap();
        let component = f.0.join("component");
        fs::create_dir(&component).unwrap();
        let mut records = vec![
            record("shell", &component, "shell", true),
            record("agent", &f.0, "agent", true),
            record("linked", &linked, "agent", true),
            record("exited", &f.0, "shell", false),
        ];
        let mut stopped = vec![];
        let result = apply_sessions(&f, true, &mut |request| match request {
            Request::List => Ok(serde_json::to_value(&records)?),
            Request::Stop { id } => {
                stopped.push(id.clone());
                records
                    .iter_mut()
                    .find(|r| r.id == id)
                    .unwrap()
                    .snapshot
                    .as_mut()
                    .unwrap()
                    .running = false;
                Ok(serde_json::Value::Null)
            }
            _ => panic!("unexpected session request"),
        })
        .unwrap();
        assert_eq!(result, BranchResult::Applied);
        assert_eq!(stopped, vec!["shell", "agent"]);
        assert!(records[2].snapshot.as_ref().unwrap().running);
        assert_eq!(records.len(), 4, "stopped terminal records are retained");
        assert!(
            git::worktrees(&f.0)
                .iter()
                .any(|t| t.current && t.branch.as_deref() == Some("feature"))
        );
    }

    #[test]
    fn git_validation_and_stop_failures_preserve_the_branch() {
        let f = Fixture::new();
        fs::write(f.0.join("keep.txt"), "keep").unwrap();
        assert!(
            apply_sessions(&f, true, &mut |_| panic!("must validate before stopping")).is_err()
        );
        fs::remove_file(f.0.join("keep.txt")).unwrap();
        let result = apply_sessions(&f, true, &mut |request| match request {
            Request::List => Ok(serde_json::to_value(vec![record(
                "agent", &f.0, "agent", true,
            )])?),
            Request::Stop { .. } => anyhow::bail!("stop failed"),
            _ => panic!("unexpected session request"),
        });
        assert!(result.unwrap_err().to_string().contains("stop failed"));
        assert!(
            git::worktrees(&f.0)
                .iter()
                .any(|t| t.current && t.branch.as_deref() == Some("main"))
        );
    }

    #[test]
    fn checks_git_again_after_stopping_writers() {
        let f = Fixture::new();
        let mut stopped = false;
        let result = apply_sessions(&f, true, &mut |request| match request {
            Request::List => Ok(serde_json::to_value(vec![record(
                "agent", &f.0, "agent", !stopped,
            )])?),
            Request::Stop { .. } => {
                stopped = true;
                fs::write(f.0.join("last-write.txt"), "written during stop")?;
                Ok(serde_json::Value::Null)
            }
            _ => panic!("unexpected session request"),
        });
        assert!(result.unwrap_err().to_string().contains("uncommitted"));
        assert!(f.0.join("last-write.txt").exists());
        assert!(
            git::worktrees(&f.0)
                .iter()
                .any(|t| t.current && t.branch.as_deref() == Some("main"))
        );
    }

    #[test]
    fn waits_for_exit_and_refuses_a_new_writer() {
        for new_writer in [false, true] {
            let f = Fixture::new();
            let mut lists = 0;
            let result = apply_sessions(&f, true, &mut |request| match request {
                Request::List => {
                    lists += 1;
                    assert!(
                        git::worktrees(&f.0)
                            .iter()
                            .any(|t| { t.current && t.branch.as_deref() == Some("main") })
                    );
                    let id = if new_writer && lists > 1 {
                        "new"
                    } else {
                        "agent"
                    };
                    Ok(serde_json::to_value(vec![record(
                        id,
                        &f.0,
                        "agent",
                        lists < 3,
                    )])?)
                }
                Request::Stop { .. } => Ok(serde_json::Value::Null),
                _ => panic!("unexpected session request"),
            });
            if new_writer {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("started in this worktree")
                );
                assert_eq!(lists, 2);
            } else {
                assert_eq!(result.unwrap(), BranchResult::Applied);
                assert_eq!(lists, 3);
            }
        }
    }

    #[test]
    fn source_switch_rename_and_delete_preserve_the_checkout() {
        let f = Fixture::new();
        f.apply(BranchAction::Switch {
            branch: "feature".into(),
        })
        .unwrap();
        f.apply(BranchAction::Rename {
            branch: "finished".into(),
        })
        .unwrap();
        assert!(
            f.apply(BranchAction::Delete {
                branch: "finished".into()
            })
            .is_err()
        );
        f.apply(BranchAction::Switch {
            branch: "main".into(),
        })
        .unwrap();
        f.apply(BranchAction::Delete {
            branch: "finished".into(),
        })
        .unwrap();
        assert_eq!(git::branches(&f.0).unwrap(), vec!["main"]);
        assert!(f.0.exists());
    }

    #[test]
    fn refuses_dirty_busy_stale_and_other_worktree_branches() {
        let f = Fixture::new();
        let switch = BranchAction::Switch {
            branch: "feature".into(),
        };
        fs::write(f.0.join("keep.txt"), "keep").unwrap();
        assert!(f.apply(switch).is_err());
        fs::remove_file(f.0.join("keep.txt")).unwrap();
        fs::write(f.0.join(".git/CHERRY_PICK_HEAD"), "busy").unwrap();
        assert!(
            f.apply(BranchAction::Switch {
                branch: "feature".into()
            })
            .is_err()
        );
        fs::remove_file(f.0.join(".git/CHERRY_PICK_HEAD")).unwrap();
        assert!(
            apply(
                &f.0,
                "stale",
                Some("main"),
                &BranchAction::Switch {
                    branch: "feature".into()
                }
            )
            .is_err()
        );
        let linked = f.0.join("linked");
        git::run(git::git(&f.0).args(["worktree", "add", linked.to_str().unwrap(), "feature"]))
            .unwrap();
        assert!(
            f.apply(BranchAction::Switch {
                branch: "feature".into()
            })
            .is_err()
        );
        assert!(
            f.apply(BranchAction::Delete {
                branch: "feature".into()
            })
            .is_err()
        );
    }

    #[test]
    fn refuses_unmerged_branch_deletion_and_invalid_names() {
        let f = Fixture::new();
        f.apply(BranchAction::Switch {
            branch: "feature".into(),
        })
        .unwrap();
        git::run(git::git(&f.0).args(["commit", "--allow-empty", "-qm", "feature"])).unwrap();
        f.apply(BranchAction::Switch {
            branch: "main".into(),
        })
        .unwrap();
        assert!(
            f.apply(BranchAction::Delete {
                branch: "feature".into()
            })
            .is_err()
        );
        assert!(
            f.apply(BranchAction::Rename {
                branch: "--force".into()
            })
            .is_err()
        );
        assert!(
            f.apply(BranchAction::Switch {
                branch: "missing".into()
            })
            .is_err()
        );
        assert!(
            f.apply(BranchAction::Rename {
                branch: "feature".into()
            })
            .is_err()
        );
    }
}
