//! Resolve local merge destinations and prepare a dedicated agent briefing. Resolving may create
//! a task worktree; preparing a job never commits, checks out, or merges anything itself. The
//! agent commits source changes only when the user confirmed that exact list.
use crate::context;
use crate::git::{self, Worktree};
use crate::model::{MERGE_SCOPE, PLAN_SCOPE, Project, REVIEW_SCOPE, TASK_ROOT_SCOPE, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// Refuse automatic merge preparation if the reviewed commit moved during frontend checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_source_head: Option<String>,
    /// Uncommitted source changes the user agreed the merge agent should commit first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_source: Option<Vec<String>>,
    pub source: String,
    pub source_branch: String,
    pub destination: String,
    pub destination_branch: String,
}

/// Resolve a local branch to a destination checkout only when a user starts a merge.
/// A newly created checkout persists if the subsequent agent launch fails.
///
/// # Errors
/// Fails for stale source state, missing local branches, dirty/busy worktrees, source changes
/// other than `confirmed_changes`, or creation errors.
pub fn resolve_destination(
    project: &Project,
    source_path: &str,
    source_branch: &str,
    destination_branch: &str,
    confirmed_changes: Option<&[String]>,
) -> Result<MergeRequest> {
    // Concurrent dialogs in this process must adopt the same checkout and task.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = Path::new(&project.root);
    ensure!(
        source_branch != destination_branch,
        "Choose a different destination branch"
    );
    let trees = git::worktrees(root);
    let mut source = checked_tree(&trees, source_path, "source")?;
    let common = git::common_dir(root)?.canonicalize()?;
    pending_commit(&mut source, source_branch, confirmed_changes, &common)?;
    ensure!(
        git::branches(root)?.iter().any(|b| b == destination_branch),
        "Destination branch {destination_branch} no longer exists; refresh and choose a local branch"
    );
    let find_destination = || {
        git::worktrees(root)
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(destination_branch))
    };
    let mut destination = if let Some(tree) = find_destination() {
        tree
    } else {
        match crate::tasks::create_existing(root, destination_branch) {
            Ok(task) => {
                let record = Restoration {
                    source: source.path.clone(),
                    source_branch: source_branch.into(),
                    destination: task.worktree.clone(),
                    destination_branch: destination_branch.into(),
                    heads: None,
                };
                save_restoration(root, &record)?;
                checked_tree(&git::worktrees(root), &task.worktree, "destination")?
            }
            // Another process may have checked the branch out since the first read.
            Err(error) => find_destination()
                .ok_or(error)
                .with_context(|| format!("Couldn't create a worktree for {destination_branch}"))?,
        }
    };
    clean(&mut destination, destination_branch, "destination", &common)?;
    // Creation can take time: do not launch if the source changed during it.
    let commit_source = pending_commit(&mut source, source_branch, confirmed_changes, &common)?;
    Ok(MergeRequest {
        expected_source_head: None,
        commit_source,
        source: source.path,
        source_branch: source_branch.into(),
        destination: destination.path,
        destination_branch: destination_branch.into(),
    })
}

/// Backend-derived cleanup operation; never accepted as execution authority.
/// Whether an agent in `component` worked a chat's stages, so it ends with that chat's merged
/// work. Shared planners and agents on the map outlive the chat.
#[must_use]
pub fn chat_stage_scope(component: &str, task: Option<&str>) -> bool {
    matches!(component, TASK_ROOT_SCOPE | REVIEW_SCOPE | MERGE_SCOPE)
        || (component == PLAN_SCOPE && task.is_some())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub restore: bool,
    pub retry: bool,
    pub removed_worktree: String,
}

impl CleanupPreview {
    /// Whether cleanup must stop a session in `cwd`. Registered nested worktrees
    /// keep their sessions when the original checkout is restored.
    #[must_use]
    pub fn owns_session(&self, request: &MergeRequest, trees: &[Worktree], cwd: &Path) -> bool {
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let removed = Path::new(&self.removed_worktree);
        cwd.starts_with(removed)
            || (self.restore
                && git::owning_worktree(trees, &cwd)
                    .is_some_and(|tree| tree.path == request.source))
    }
}

#[derive(Serialize, Deserialize)]
struct Restoration {
    source: String,
    source_branch: String,
    destination: String,
    destination_branch: String,
    // Pinned before the first destructive step, retained for safe retries.
    heads: Option<(String, String)>,
}

const RESTORATION_PREFIX: &str = "merge-";
const RESTORATION_SUFFIX: &str = ".json";

fn restoration_file(root: &Path, destination: &str) -> Result<PathBuf> {
    Ok(crate::tasks::store_dir(root)?.join(format!(
        "{RESTORATION_PREFIX}{}{RESTORATION_SUFFIX}",
        crate::workspace::session_id(destination, "cleanup", "ownership")
    )))
}

fn save_restoration(root: &Path, record: &Restoration) -> Result<()> {
    crate::workspace::atomic_write(
        &restoration_file(root, &record.destination)?,
        &serde_json::to_vec(record)?,
    )
}

fn restoration(root: &Path, request: &MergeRequest) -> Result<Option<Restoration>> {
    let Some(record) = read_restoration(&restoration_file(root, &request.destination)?)? else {
        return Ok(None);
    };
    Ok((record.source == request.source
        && record.source_branch == request.source_branch
        && record.destination == request.destination
        && record.destination_branch == request.destination_branch)
        .then_some(record))
}

fn read_restoration(file: &Path) -> Result<Option<Restoration>> {
    match std::fs::read(file) {
        Ok(text) => Ok(Some(serde_json::from_slice(&text)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

// A partial cleanup can remove the destination before restoring the original checkout.
// The saved request still pins the refs to verify, even when Git no longer lists that path.
fn pending_restoration(
    root: &Path,
    source: &Worktree,
    source_branch: &str,
    destination_branch: &str,
) -> Result<Option<Restoration>> {
    if !(source.main || source.current) {
        return Ok(None);
    }
    let entries = match std::fs::read_dir(crate::tasks::store_dir(root)?) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut pending = None;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(RESTORATION_PREFIX)
            && name.ends_with(RESTORATION_SUFFIX)
            && let Some(record) = read_restoration(&entry.path())?
            && record.heads.is_some()
            && record.source == source.path
            && record.source_branch == source_branch
            && record.destination_branch == destination_branch
        {
            ensure!(
                pending.is_none(),
                "Multiple saved merge restorations match this branch"
            );
            pending = Some(record);
        }
    }
    Ok(pending)
}

fn branch_head(root: &Path, branch: &str) -> Result<String> {
    git::run(git::git(root).args([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("refs/heads/{branch}^{{commit}}"),
    ]))
}

fn validate_restoration(root: &Path, request: &MergeRequest, record: &Restoration) -> Result<()> {
    let trees = git::worktrees(root);
    let mut source = checked_tree(&trees, &request.source, "source")?;
    ensure!(
        source.main || source.current,
        "Restoration requires the primary or open worktree"
    );
    let common = git::common_dir(root)?.canonicalize()?;
    let source_branch = if record.heads.is_some()
        && source.branch.as_deref() == Some(&request.destination_branch)
    {
        &request.destination_branch
    } else {
        &request.source_branch
    };
    clean(&mut source, source_branch, "source", &common)?;
    if let Some((source_head, destination_head)) = &record.heads {
        ensure!(
            branch_head(root, &request.destination_branch)? == *destination_head,
            "Destination branch changed during cleanup; original folder preserved"
        );
        let branches = git::branches(root)?;
        if branches.contains(&request.source_branch) {
            ensure!(
                branch_head(root, &request.source_branch)? == *source_head,
                "Source branch changed during cleanup"
            );
        } else {
            ensure!(
                source_branch == &request.destination_branch,
                "Source branch disappeared during cleanup"
            );
        }
    } else {
        ensure!(
            matches!(
                outcome_in(root, request)?,
                MergeOutcome::Merged | MergeOutcome::AlreadyIntegrated
            ),
            "The source branch is not clean and fully integrated"
        );
    }
    ensure!(
        !trees
            .iter()
            .any(|t| t.path != source.path && t.branch.as_deref() == Some(&request.source_branch)),
        "The source branch is checked out elsewhere"
    );
    if trees.iter().any(|t| t.path == request.destination) {
        let mut destination = checked_tree(&trees, &request.destination, "destination")?;
        ensure!(
            !destination.main && !destination.current,
            "Cannot remove the primary or open destination"
        );
        clean(
            &mut destination,
            &request.destination_branch,
            "destination",
            &common,
        )?;
    } else {
        ensure!(
            record.heads.is_some() && !Path::new(&request.destination).exists(),
            "Destination worktree disappeared or was replaced"
        );
    }
    ensure!(
        !trees.iter().any(|t| t.path != source.path
            && t.path != request.destination
            && t.branch.as_deref() == Some(&request.destination_branch)),
        "Destination branch is checked out elsewhere"
    );
    Ok(())
}

/// Validate and describe the cleanup using live repository state.
///
/// # Errors
/// Fails for missing or changed worktrees, dirty or unmerged work, missing
/// restoration ownership, changed branch heads, or Git and filesystem errors.
pub fn cleanup_preview(project: &Project, request: &MergeRequest) -> Result<CleanupPreview> {
    let root = Path::new(&project.root);
    let trees = git::worktrees(root);
    let source = checked_tree(&trees, &request.source, "source")?;
    if source.main || source.current {
        let record = restoration(root, request)?.context(
            "Cannot restore this checkout automatically: destination ownership was not recorded. Release the destination branch and switch the original folder manually.")?;
        validate_restoration(root, request, &record)?;
        Ok(CleanupPreview {
            restore: true,
            retry: record.heads.is_some(),
            removed_worktree: request.destination.clone(),
        })
    } else {
        check_cleanup(project, request)?;
        Ok(CleanupPreview {
            restore: false,
            retry: false,
            removed_worktree: request.source.clone(),
        })
    }
}

fn restore_original(project: &Project, request: &MergeRequest) -> Result<()> {
    let root = Path::new(&project.root);
    let mut record = restoration(root, request)?.context("Destination ownership is missing")?;
    validate_restoration(root, request, &record)?;
    if record.heads.is_none() {
        record.heads = Some((
            branch_head(root, &request.source_branch)?,
            branch_head(root, &request.destination_branch)?,
        ));
        save_restoration(root, &record)?;
    }
    if git::worktrees(root)
        .iter()
        .any(|t| t.path == request.destination)
    {
        git::run(git::git(root).args(["worktree", "remove", "--", &request.destination]))?;
    }
    git::run(git::git(Path::new(&request.source)).args(["switch", "--", &request.destination_branch]))
        .context("Destination worktree removed; retry cleanup to return the original folder to the destination branch")?;
    if git::branches(root)?.contains(&request.source_branch) {
        git::run(git::git(root).args(["branch", "-d", "--", &request.source_branch])).context(
            "Original folder restored; retry cleanup to delete the merged feature branch",
        )?;
    }
    Ok(())
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
/// Active operations and uncommitted work take precedence over commit ancestry:
/// any in the source (it isn't in the merge), but only changes to tracked files
/// in the destination, so artifacts its checks leave behind don't hide a merge.
///
/// # Errors
/// Fails for foreign, missing or changed worktrees, or Git errors.
pub fn outcome(project: &Project, request: &MergeRequest) -> Result<MergeOutcome> {
    outcome_in(Path::new(&project.root), request)
}

fn outcome_in(root: &Path, request: &MergeRequest) -> Result<MergeOutcome> {
    if let Some(record) = restoration(root, request)?
        && record.heads.is_some()
    {
        validate_restoration(root, request, &record)?;
        return Ok(MergeOutcome::AlreadyIntegrated);
    }
    let trees = git::try_worktrees(root)?;
    let mut source = checked_tree(&trees, &request.source, "source")?;
    let mut destination = checked_tree(&trees, &request.destination, "destination")?;
    ensure!(
        source.path != destination.path,
        "Choose a different destination worktree"
    );
    let common = git::common_dir(root)?.canonicalize()?;
    let (_, source_busy) = read_tree(&mut source, &common)?;
    let (_, destination_busy) = read_tree(&mut destination, &common)?;
    if source_busy || destination_busy {
        return Ok(MergeOutcome::InProgress);
    }
    ensure!(
        source.branch.as_deref() == Some(&request.source_branch)
            && destination.branch.as_deref() == Some(&request.destination_branch),
        "The merge branches changed"
    );
    for (path, untracked) in [(&source.path, "all"), (&destination.path, "no")] {
        if !git::run(
            git::git(Path::new(path))
                .args(["status", "--porcelain"])
                .arg(format!("--untracked-files={untracked}")),
        )?
        .is_empty()
        {
            return Ok(MergeOutcome::Dirty);
        }
    }
    commit_outcome(
        Path::new(&destination.path),
        &source.head,
        &destination.head,
    )
}

/// Check integration against a local branch without needing a destination checkout.
/// Honor a saved restoration and inspect any live destination checkout before comparing refs.
///
/// # Errors
/// Fails for a foreign or changed source worktree, an invalid destination branch, or Git errors.
pub fn branch_outcome(
    root: &Path,
    source_path: &str,
    source_branch: &str,
    destination_branch: &str,
) -> Result<MergeOutcome> {
    ensure!(
        source_branch != destination_branch,
        "Choose a different destination branch"
    );
    crate::tasks::check_branch(root, destination_branch)?;
    let trees = git::try_worktrees(root)?;
    let mut source = checked_tree(&trees, source_path, "source")?;
    let request = |destination: &str| MergeRequest {
        expected_source_head: None,
        commit_source: None,
        source: source.path.clone(),
        source_branch: source_branch.into(),
        destination: destination.into(),
        destination_branch: destination_branch.into(),
    };
    if let Some(destination) = trees
        .iter()
        .find(|tree| tree.path != source.path && tree.branch.as_deref() == Some(destination_branch))
    {
        return outcome_in(root, &request(&destination.path));
    }
    if let Some(record) = pending_restoration(root, &source, source_branch, destination_branch)? {
        validate_restoration(root, &request(&record.destination), &record)?;
        return Ok(MergeOutcome::AlreadyIntegrated);
    }
    let destination_head = branch_head(root, destination_branch)?;
    let common = git::common_dir(root)?.canonicalize()?;
    // A rebase temporarily detaches HEAD, so worktree list omits that checkout's branch.
    let destination_ref = format!("refs/heads/{destination_branch}");
    for tree in trees
        .iter()
        .filter(|tree| tree.path != source.path && tree.branch.is_none())
    {
        let dirs = owned_dirs(Path::new(&tree.path), &common)?;
        for marker in ["rebase-merge", "rebase-apply"] {
            match std::fs::read_to_string(dirs[0].join(marker).join("head-name")) {
                Ok(name) if name.trim() == destination_ref => return Ok(MergeOutcome::InProgress),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    let (_, busy) = read_tree(&mut source, &common)?;
    if busy {
        return Ok(MergeOutcome::InProgress);
    }
    ensure!(
        source.branch.as_deref() == Some(source_branch),
        "The merge source branch changed"
    );
    if !status_entries(Path::new(&source.path))?.is_empty() {
        return Ok(MergeOutcome::Dirty);
    }
    commit_outcome(root, &source.head, &destination_head)
}

fn commit_outcome(root: &Path, source_head: &str, destination_head: &str) -> Result<MergeOutcome> {
    let ancestor = git::git(root)
        .args(["merge-base", "--is-ancestor", source_head, destination_head])
        .status()?;
    if !ancestor.success() {
        ensure!(ancestor.code() == Some(1), "Couldn't check merge ancestry");
        return Ok(MergeOutcome::NotMerged);
    }
    let parents = git::run(git::git(root).args(["rev-list", "--parents", "-1", destination_head]))?;
    Ok(
        if parents.split_whitespace().skip(2).any(|p| p == source_head) {
            MergeOutcome::Merged
        } else {
            MergeOutcome::AlreadyIntegrated
        },
    )
}

/// Validate cleanup immediately before stopping source sessions or removing files.
///
/// # Errors
/// Fails for primary, open, missing, or changed source worktrees, unintegrated
/// or dirty work, a source branch checked out elsewhere, or Git errors.
pub fn check_cleanup(project: &Project, request: &MergeRequest) -> Result<()> {
    let trees = git::worktrees(Path::new(&project.root));
    let source = checked_tree(&trees, &request.source, "source")?;
    ensure!(
        !source.main && !source.current,
        "Cannot delete the primary or open project worktree"
    );
    ensure!(
        matches!(
            outcome(project, request)?,
            MergeOutcome::Merged | MergeOutcome::AlreadyIntegrated
        ),
        "The source branch is not clean and fully integrated"
    );
    ensure!(
        !trees
            .iter()
            .any(|t| t.path != source.path && t.branch.as_deref() == Some(&request.source_branch)),
        "The source branch is checked out elsewhere"
    );
    Ok(())
}

/// Remove a validated worktree, then its merged local branch. Never forces deletion.
///
/// # Errors
/// Fails when cleanup validation fails, ownership cannot be saved, or Git cannot
/// remove the worktree, restore the original checkout, or delete the merged branch.
/// Earlier cleanup steps may already have completed when a later step fails.
pub fn cleanup(project: &Project, request: &MergeRequest) -> Result<()> {
    if cleanup_preview(project, request)?.restore {
        return restore_original(project, request);
    }
    check_cleanup(project, request)?;
    git::run(git::git(Path::new(&request.destination)).args([
        "worktree",
        "remove",
        "--",
        &request.source,
    ]))?;
    git::run(git::git(Path::new(&request.destination)).args([
        "branch",
        "-d",
        "--",
        &request.source_branch,
    ]))
    .context("Worktree removed, but local branch could not be deleted")?;
    Ok(())
}

/// Called while the session service excludes launches through the cleanup mutation.
pub(crate) fn cleanup_if_idle(
    project: &Project,
    request: &MergeRequest,
    records: &[crate::session::Record],
) -> Result<()> {
    let preview = cleanup_preview(project, request)?;
    let trees = git::worktrees(Path::new(&project.root));
    ensure!(
        !records.iter().any(|record| {
            record.snapshot.as_ref().is_some_and(|s| s.running)
                && preview.owns_session(request, &trees, &record.spec.cwd)
        }),
        "A terminal or agent is running in a worktree affected by cleanup; stop it and retry cleanup"
    );
    cleanup(project, request)
}

/// Report conflicting paths without checking out or reading any of those paths.
///
/// # Errors
/// Fails when Git cannot resolve the revisions or perform the merge-tree check.
pub fn conflicts(repo: &Path, source: &str, dest: &str) -> Result<Vec<String>> {
    // Resolve refs first so provider/user text can never become command options.
    let source = git::run(git::git(repo).args([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{source}^{{commit}}"),
    ]))?;
    let dest = git::run(git::git(repo).args([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{dest}^{{commit}}"),
    ]))?;
    let output = git::git(repo)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            &dest,
            &source,
        ])
        .output()?;
    ensure!(
        output.status.success() || output.status.code() == Some(1),
        "Couldn't check merge conflicts: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(output
        .stdout
        .split(|b| *b == 0)
        .skip(1)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect())
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

/// Refresh ownership, HEAD, branch and operation markers with one Git process.
fn read_tree(tree: &mut Worktree, common: &Path) -> Result<(Vec<PathBuf>, bool)> {
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
    tree.head = head.into();
    tree.branch = branch.map(str::to_owned);
    let busy = lines.any(|path| Path::new(path).exists());
    Ok((dirs, busy))
}

/// Check a worktree is on its expected branch with no Git operation in progress.
fn settled(
    tree: &mut Worktree,
    expected_branch: &str,
    role: &str,
    common: &Path,
) -> Result<Vec<PathBuf>> {
    let (dirs, busy) = read_tree(tree, common)?;
    ensure!(
        tree.branch.is_some(),
        "The {role} worktree has a detached HEAD; check out a branch first"
    );
    ensure!(
        tree.branch.as_deref() == Some(expected_branch),
        "The {role} branch changed; refresh Review and try again"
    );
    ensure!(
        !busy,
        "The {role} worktree has an operation in progress; finish or abort it first"
    );
    Ok(dirs)
}

/// Uncommitted entries, untrimmed because a leading space is part of Git's status code.
fn status_entries(root: &Path) -> Result<Vec<String>> {
    let output = git::git(root)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .stdin(Stdio::null())
        .output()
        .context("running git")?;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

fn uncommitted_error(role: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "The {role} worktree has uncommitted changes; commit or clear them before merging"
    )
}

fn clean(
    tree: &mut Worktree,
    expected_branch: &str,
    role: &str,
    common: &Path,
) -> Result<Vec<PathBuf>> {
    let dirs = settled(tree, expected_branch, role, common)?;
    if !status_entries(Path::new(&tree.path))?.is_empty() {
        return Err(uncommitted_error(role));
    }
    Ok(dirs)
}

/// The source changes to commit before merging, or `None` when the source is clean.
/// Anything other than exactly what the user confirmed stops the merge.
fn pending_commit(
    source: &mut Worktree,
    expected_branch: &str,
    confirmed: Option<&[String]>,
    common: &Path,
) -> Result<Option<Vec<String>>> {
    settled(source, expected_branch, "source", common)?;
    let changes = status_entries(Path::new(&source.path))?;
    if changes.is_empty() {
        return Ok(None);
    }
    let confirmed = confirmed.ok_or_else(|| uncommitted_error("source"))?;
    ensure!(
        confirmed == changes.as_slice(),
        "The uncommitted changes changed; review them and try again"
    );
    Ok(Some(changes))
}

/// List the source worktree's uncommitted changes so the user can decide whether to commit them.
///
/// # Errors
/// Fails for missing, foreign, detached, changed or busy worktrees, or Git errors.
pub fn source_changes(
    project: &Project,
    source_path: &str,
    source_branch: &str,
) -> Result<Vec<String>> {
    let root = Path::new(&project.root);
    let mut source = checked_tree(&git::worktrees(root), source_path, "source")?;
    let common = git::common_dir(root)?.canonicalize()?;
    settled(&mut source, source_branch, "source", &common)?;
    status_entries(Path::new(&source.path))
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
/// Fails for missing, foreign, detached, identical, dirty, or busy worktrees, source changes
/// other than the confirmed ones, or briefing I/O.
pub fn prepare(
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
    let commit = pending_commit(
        &mut source,
        &request.source_branch,
        request.commit_source.as_deref(),
        &common,
    )?;
    ensure!(
        request
            .expected_source_head
            .as_ref()
            .is_none_or(|head| *head == source.head),
        "The source changed since review; review again before merging"
    );
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
    let clean_scope = if commit.is_some() {
        "the destination worktree is clean (including untracked files; the source has only the changes listed below)"
    } else {
        "both worktrees are clean (including untracked files)"
    };
    let (commit_steps, merge_target, source_rule) = match &commit {
        Some(changes) => (
            format!(
                "## Commit the source changes first\n\nThe user asked you to commit these uncommitted source changes before merging:\n\n```\n{}\n```\n\nIn the source worktree, confirm git status --porcelain --untracked-files=all still shows exactly these entries, then run git add -A and commit on the source branch with a descriptive message that follows the repository's conventions. Do not bypass commit hooks. Stop and report, without merging, if the entries differ, the commit fails, or a listed file looks like a secret.\n\n",
                changes.join("\n")
            ),
            "the new source HEAD from that commit",
            "Apart from that commit, do not modify the source worktree. Do not push or delete branches or worktrees.",
        ),
        None => (
            String::new(),
            "the source commit shown above",
            "Do not modify the source worktree, push, or delete branches or worktrees.",
        ),
    };
    let work_scope = if commit.is_some() {
        "After committing, work only in the destination worktree."
    } else {
        "Work only in the destination worktree."
    };
    let mut text = format!(
        "# Patchbay local merge\n\nProject: {}\n\nSource worktree: {}\nSource branch: {}\nSource HEAD: {}\n\nDestination worktree: {}\nDestination branch: {}\nDestination HEAD: {}\n\n\
         Integrate the entire committed source branch into the destination branch. Review's component filters do not limit this job.\n\n\
         Before changing anything, verify both paths still belong to this repository, both branches and HEADs still match the values above, {clean_scope}, and neither has a merge, rebase, cherry-pick, or revert in progress. Stop and report if a precondition changed.\n\n\
         {commit_steps}{work_scope} Merge {merge_target} using git merge --no-commit --no-ff, resolving conflicts while preserving the intent of both branches. Read the repository's contribution instructions and run the relevant checks. Complete the local merge commit only after those checks pass. If already integrated, report that no merge is needed. If blocked or checks fail, report what remains and leave the work available for user review. Never reset, discard, stash, or commit unrelated changes. {source_rule}\n",
        project.name,
        source.path,
        request.source_branch,
        source.head,
        destination.path,
        request.destination_branch,
        destination.head,
    );
    // The commit made for this merge is newer than anything a saved review saw.
    let reviewed_head = if commit.is_some() {
        ""
    } else {
        source.head.as_str()
    };
    if let Some(section) = crate::reviews::merge_handoff(
        Path::new(&project.root),
        &request.source_branch,
        reviewed_head,
    ) {
        text.push_str(&format!("\n## {}\n\n{}\n", section.title, section.body));
    }
    if let Some(auto) = auto {
        text.push_str(&auto.markdown("merge"));
    }
    // Linked worktrees write their private index/HEAD and the shared object/ref store.
    let mut dirs = destination_dirs;
    if commit.is_some() {
        // Only a confirmed commit reaches the source; `resume_roots` keys off this entry.
        dirs.extend(owned_dirs(Path::new(&source.path), &common)?);
        dirs.push(PathBuf::from(&source.path));
    }
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

/// Validate the recorded destination before granting resume access, plus the source when this
/// run was launched to commit there. Unrelated worktrees never widen the grant, and an ordinary
/// merge resumes without its source.
///
/// # Errors
/// Fails if a granted worktree is missing, no longer registered, or belongs to another repo.
pub fn resume_roots(root: &Path, spec: &SessionSpec) -> Result<Vec<PathBuf>> {
    let common = git::common_dir(root)?.canonicalize()?;
    let trees = git::worktrees(root);
    let grant = |worktree: &Path| -> Result<Vec<PathBuf>> {
        let path = worktree.canonicalize()?;
        ensure!(
            trees.iter().any(|tree| Path::new(&tree.path) == path),
            "The merge worktree at {} is no longer registered",
            path.display()
        );
        let mut roots = owned_dirs(&path, &common)?;
        roots.push(path);
        Ok(roots)
    };
    let mut roots = grant(&spec.cwd)?;
    if let Some(source) = spec.merge_source.as_ref().filter(|s| spec.dirs.contains(s)) {
        roots.extend(grant(source)?);
    }
    roots.sort();
    roots.dedup();
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_stage_scope_leaves_shared_planners_and_map_agents() {
        for scope in [TASK_ROOT_SCOPE, REVIEW_SCOPE, MERGE_SCOPE] {
            assert!(chat_stage_scope(scope, None));
        }
        assert!(chat_stage_scope(PLAN_SCOPE, Some("task")));
        assert!(!chat_stage_scope(PLAN_SCOPE, None));
        assert!(!chat_stage_scope(crate::model::MAP_SCOPE, None));
        assert!(!chat_stage_scope("web", None));
    }
    use crate::model::TerminalKind;
    use crate::policy::AllowAll;
    use std::fs;

    struct Fixture {
        dir: PathBuf,
        project: Project,
        request: MergeRequest,
    }
    #[test]
    fn cleanup_removes_integrated_worktree_and_branch() {
        let f = Fixture::new();
        cleanup(&f.project, &f.request).unwrap();
        assert!(!Path::new(&f.request.source).exists());
        assert!(
            !git::git(Path::new(&f.project.root))
                .args(["show-ref", "--verify", "refs/heads/feature"])
                .status()
                .unwrap()
                .success()
        );
    }

    fn primary_request() -> (Fixture, MergeRequest) {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        git::run(git::git(root).args(["worktree", "remove", &f.request.source])).unwrap();
        git::run(git::git(root).args(["checkout", "feature"])).unwrap();
        fs::write(root.join("file.txt"), "feature change").unwrap();
        git::run(git::git(root).args(["commit", "-qam", "feature change"])).unwrap();
        let request =
            resolve_destination(&f.project, &f.project.root, "feature", "main", None).unwrap();
        (f, request)
    }

    fn integrate(request: &MergeRequest) {
        git::run(git::git(Path::new(&request.destination)).args([
            "merge",
            "--no-ff",
            "-qm",
            "merge feature",
            &request.source_branch,
        ]))
        .unwrap();
    }

    #[test]
    fn restoration_refuses_writers_started_after_the_stop_snapshot() {
        let (f, request) = primary_request();
        integrate(&request);
        for cwd in [&request.source, &request.destination] {
            let record = serde_json::from_value(serde_json::json!({
                "id":"late-writer",
                "metadata": {
                    "projectId":"p", "projectName":"P", "projectRoot":request.source,
                    "componentId":"root", "terminalId":"shell", "name":"Shell", "kind":"shell"
                },
                "spec": {
                    "id":"late-writer", "command":"cat", "cwd":cwd, "env":{},
                    "ready_when":"", "service":false, "notice":null
                },
                "snapshot": {
                    "data":"", "end":0, "generation":1, "running":true, "startedMs":1,
                    "status":{"active":false,"ready":false,"stopped":false}
                },
                "history":[], "interrupted":false, "requestIds":[]
            }))
            .unwrap();
            assert!(
                cleanup_if_idle(&f.project, &request, &[record])
                    .unwrap_err()
                    .to_string()
                    .contains("running")
            );
            assert!(Path::new(&request.destination).exists());
            assert_eq!(
                git::run(git::git(Path::new(&request.source)).args(["branch", "--show-current"]))
                    .unwrap(),
                "feature"
            );
        }
        cleanup_if_idle(&f.project, &request, &[]).unwrap();
    }

    #[test]
    fn restoration_preserves_dirty_busy_unmerged_and_unowned_worktrees() {
        let (f, request) = primary_request();
        assert!(cleanup(&f.project, &request).is_err());
        integrate(&request);
        for path in [&request.source, &request.destination] {
            let dirty = Path::new(path).join("untracked.txt");
            fs::write(&dirty, "keep").unwrap();
            assert!(cleanup(&f.project, &request).is_err());
            assert!(Path::new(&request.destination).exists());
            fs::remove_file(dirty).unwrap();
            let dirs = git_dirs(Path::new(path)).unwrap();
            let marker = dirs[0].join("CHERRY_PICK_HEAD");
            fs::write(&marker, "busy").unwrap();
            assert!(cleanup(&f.project, &request).is_err());
            fs::remove_file(marker).unwrap();
        }
        fs::remove_file(
            restoration_file(Path::new(&f.project.root), &request.destination).unwrap(),
        )
        .unwrap();
        assert!(
            cleanup(&f.project, &request)
                .unwrap_err()
                .to_string()
                .contains("ownership")
        );
        assert!(Path::new(&request.source).exists());
        assert!(Path::new(&request.destination).exists());
    }

    #[test]
    fn restoration_retries_after_removal_and_rejects_moved_refs() {
        for move_ref in [false, true] {
            let (f, request) = primary_request();
            integrate(&request);
            let root = Path::new(&f.project.root);
            let mut record = restoration(root, &request).unwrap().unwrap();
            record.heads = Some((
                branch_head(root, "feature").unwrap(),
                branch_head(root, "main").unwrap(),
            ));
            save_restoration(root, &record).unwrap();
            git::run(git::git(root).args(["worktree", "remove", &request.destination])).unwrap();
            assert_eq!(
                outcome(&f.project, &request).unwrap(),
                MergeOutcome::AlreadyIntegrated
            );
            let branch = || branch_outcome(root, &request.source, "feature", "main");
            assert_eq!(branch().unwrap(), MergeOutcome::AlreadyIntegrated);
            if move_ref {
                fs::write(root.join("file.txt"), "new change").unwrap();
                git::run(git::git(root).args(["commit", "-qam", "changed feature"])).unwrap();
                assert!(branch().unwrap_err().to_string().contains("during cleanup"));
                assert!(cleanup(&f.project, &request).is_err());
            } else {
                cleanup(&f.project, &request).unwrap();
                assert_eq!(
                    git::run(git::git(root).args(["branch", "--show-current"])).unwrap(),
                    "main"
                );
            }
        }
    }

    #[test]
    fn cleanup_returns_primary_feature_to_main() {
        let (f, request) = primary_request();
        let root = Path::new(&f.project.root);
        integrate(&request);
        cleanup(&f.project, &request).unwrap();
        assert_eq!(
            git::run(git::git(root).args(["branch", "--show-current"])).unwrap(),
            "main"
        );
        assert!(!Path::new(&request.destination).exists());
        assert!(!git::branches(root).unwrap().contains(&"feature".into()));
        cleanup(&f.project, &request).unwrap();
    }

    #[test]
    fn restoration_sessions_exclude_nested_worktrees_and_include_missing_components() {
        let (f, request) = primary_request();
        let root = Path::new(&f.project.root);
        let nested = root.join("independent");
        git::run(git::git(root).args([
            "worktree",
            "add",
            "-qb",
            "independent",
            nested.to_str().unwrap(),
        ]))
        .unwrap();
        fs::write(root.join(".git/info/exclude"), "independent/\n").unwrap();
        let component = root.join("component");
        fs::create_dir(&component).unwrap();
        let nested_component = nested.join("component");
        fs::create_dir(&nested_component).unwrap();
        integrate(&request);
        let preview = cleanup_preview(&f.project, &request).unwrap();
        let trees = git::worktrees(root);
        assert!(preview.owns_session(&request, &trees, root));
        assert!(preview.owns_session(&request, &trees, &component));
        assert!(preview.owns_session(&request, &trees, Path::new(&request.destination)));
        assert!(!preview.owns_session(&request, &trees, &nested));
        assert!(!preview.owns_session(&request, &trees, &nested_component));
        assert!(!preview.owns_session(&request, &trees, &f.dir.join("unrelated")));
        // Retained sessions can refer to component directories that no longer exist.
        assert!(preview.owns_session(&request, &trees, &component.join("gone")));
        assert!(!preview.owns_session(&request, &trees, &nested_component.join("gone")));
    }

    #[test]
    fn cleanup_preserves_dirty_and_unmerged_work() {
        let f = Fixture::new();
        let source = Path::new(&f.request.source);
        fs::write(source.join("new.txt"), "new work").unwrap();
        assert!(cleanup(&f.project, &f.request).is_err());
        git::run(git::git(source).args(["add", "."])).unwrap();
        git::run(git::git(source).args(["commit", "-qm", "new work"])).unwrap();
        assert!(cleanup(&f.project, &f.request).is_err());
        assert!(source.exists());
    }

    #[test]
    fn cleanup_refuses_an_active_git_operation() {
        let f = Fixture::new();
        let source = Path::new(&f.request.source);
        let dir = git::run(git::git(source).args(["rev-parse", "--absolute-git-dir"])).unwrap();
        fs::write(Path::new(dir.trim()).join("MERGE_HEAD"), "pending").unwrap();
        assert!(cleanup(&f.project, &f.request).is_err());
        assert!(source.exists());
    }

    #[test]
    fn cleanup_refuses_primary_and_changed_branches() {
        let f = Fixture::new();
        let mut request = f.request.clone();
        std::mem::swap(&mut request.source, &mut request.destination);
        std::mem::swap(&mut request.source_branch, &mut request.destination_branch);
        assert!(check_cleanup(&f.project, &request).is_err());
        request = f.request.clone();
        request.source_branch = "renamed".into();
        assert!(check_cleanup(&f.project, &request).is_err());
    }

    #[test]
    fn destination_resolution_reuses_existing_checkout_without_creating_tasks() {
        let f = Fixture::new();
        let request =
            resolve_destination(&f.project, &f.request.source, "feature", "main", None).unwrap();
        assert_eq!(request.destination, f.project.root);
        assert!(
            crate::tasks::list(Path::new(&f.project.root))
                .unwrap()
                .is_empty()
        );
        assert_eq!(git::worktrees(Path::new(&f.project.root)).len(), 2);
    }

    #[test]
    fn primary_feature_creates_persistent_main_checkout_and_retries_reuse_it() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        git::run(git::git(root).args(["worktree", "remove", &f.request.source])).unwrap();
        git::run(git::git(root).args(["checkout", "feature"])).unwrap();
        let before = git::run(git::git(root).args(["rev-parse", "HEAD"])).unwrap();
        let request =
            resolve_destination(&f.project, &f.project.root, "feature", "main", None).unwrap();
        assert_eq!(request.source, f.project.root);
        assert_ne!(request.destination, f.project.root);
        assert_eq!(
            Path::new(&request.destination).file_name().unwrap(),
            "main-main"
        );
        assert_eq!(
            git::run(git::git(root).args(["branch", "--show-current"])).unwrap(),
            "feature"
        );
        assert_eq!(
            git::run(git::git(root).args(["rev-parse", "HEAD"])).unwrap(),
            before
        );
        let trees = git::worktrees(root);
        assert!(
            trees
                .iter()
                .find(|w| w.path == request.source)
                .unwrap()
                .current
        );
        assert!(
            !trees
                .iter()
                .find(|w| w.path == request.destination)
                .unwrap()
                .current
        );
        let tasks = crate::tasks::list(root).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].worktree, request.destination);
        assert!(!tasks[0].current);
        // Even after a rejected launch, the destination survives as a normal task.
        let mut invalid = Fixture::terminal("claude");
        invalid.kind = TerminalKind::Shell;
        assert!(prepare(&f.project, &request, &invalid, &AllowAll, None).is_err());
        let retry =
            resolve_destination(&f.project, &f.project.root, "feature", "main", None).unwrap();
        assert_eq!(retry.destination, request.destination);
        assert_eq!(crate::tasks::list(root).unwrap().len(), 1);
        let job = prepare(
            &f.project,
            &retry,
            &Fixture::terminal("claude"),
            &AllowAll,
            None,
        )
        .unwrap();
        assert_eq!(job.spec.cwd, Path::new(&request.destination));
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
    }

    #[test]
    fn resolver_rejects_stale_same_missing_dirty_and_busy_branches() {
        let f = Fixture::new();
        let resolve = |source, destination| {
            resolve_destination(&f.project, &f.request.source, source, destination, None)
        };
        assert!(
            resolve("feature", "feature")
                .unwrap_err()
                .to_string()
                .contains("different destination")
        );
        assert!(
            resolve("renamed", "main")
                .unwrap_err()
                .to_string()
                .contains("source branch changed")
        );
        assert!(
            resolve("feature", "deleted")
                .unwrap_err()
                .to_string()
                .contains("no longer exists")
        );
        git::run(git::git(Path::new(&f.project.root)).args(["branch", "-m", "renamed-main"]))
            .unwrap();
        assert!(
            resolve("feature", "main")
                .unwrap_err()
                .to_string()
                .contains("no longer exists")
        );
        fs::write(Path::new(&f.request.source).join("dirty"), "work").unwrap();
        assert!(
            resolve("feature", "renamed-main")
                .unwrap_err()
                .to_string()
                .contains("uncommitted")
        );
        fs::remove_file(Path::new(&f.request.source).join("dirty")).unwrap();
        let dirs = git_dirs(Path::new(&f.request.source)).unwrap();
        fs::write(dirs[0].join("MERGE_HEAD"), "pending").unwrap();
        assert!(
            resolve("feature", "renamed-main")
                .unwrap_err()
                .to_string()
                .contains("operation in progress")
        );
        assert_eq!(git::worktrees(Path::new(&f.project.root)).len(), 2);
    }

    #[test]
    fn creation_failure_preserves_source_and_does_not_recreate_deleted_branches() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        git::run(git::git(root).args(["branch", "destination"])).unwrap();
        // Force task-store failure before worktree creation.
        let store = crate::tasks::store_dir(root).unwrap();
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("tasks.json"), "invalid").unwrap();
        assert!(
            resolve_destination(
                &f.project,
                &f.request.source,
                "feature",
                "destination",
                None
            )
            .is_err()
        );
        assert_eq!(git::worktrees(root).len(), 2);
        assert_eq!(
            git::run(git::git(Path::new(&f.request.source)).args(["branch", "--show-current"]))
                .unwrap(),
            "feature"
        );
        fs::remove_file(store.join("tasks.json")).unwrap();
        assert!(crate::tasks::create_existing(root, "deleted").is_err());
        assert!(
            !git::branches(root)
                .unwrap()
                .contains(&"deleted".to_string())
        );
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
                worktree_setup: None,
                schema_version: crate::model::SCHEMA_VERSION,
                name: "Merge test".into(),
                root: root.to_string_lossy().into(),
                components: vec![],
                links: vec![],
                groups: vec![],
            };
            let request = MergeRequest {
                expected_source_head: None,
                commit_source: None,
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
                None,
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
            git::review(&f.project, vec![], Some(&f.request.source), Some("main")).unwrap();
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
    fn branch_outcome_detects_a_merge_without_a_destination_checkout() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        let source = Path::new(&f.request.source);
        let read = || branch_outcome(root, &f.request.source, "feature", "main").unwrap();
        fs::write(source.join("feature.txt"), "feature\n").unwrap();
        git::run(git::git(source).args(["add", "."])).unwrap();
        git::run(git::git(source).args(["commit", "-qm", "feature"])).unwrap();
        git::run(git::git(root).args(["switch", "-c", "other"])).unwrap();
        assert_eq!(read(), MergeOutcome::NotMerged);

        git::run(git::git(root).args(["switch", "main"])).unwrap();
        git::run(git::git(root).args(["merge", "--no-ff", "-qm", "merge feature", "feature"]))
            .unwrap();
        git::run(git::git(root).args(["switch", "other"])).unwrap();
        let trees = git::worktrees(root);
        assert!(
            !trees
                .iter()
                .any(|tree| tree.branch.as_deref() == Some("main"))
        );
        assert_eq!(read(), MergeOutcome::Merged);
        assert_eq!(git::worktrees(root).len(), trees.len());

        fs::write(source.join("uncommitted.txt"), "new work").unwrap();
        assert_eq!(read(), MergeOutcome::Dirty);
    }

    #[test]
    fn branch_outcome_inspects_a_destination_checkout_created_since_the_caller_read() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        git::run(git::git(root).args(["switch", "-c", "other"])).unwrap();
        let read = || branch_outcome(root, &f.request.source, "feature", "main").unwrap();
        assert_eq!(read(), MergeOutcome::AlreadyIntegrated);

        git::run(git::git(root).args(["switch", "main"])).unwrap();
        fs::write(root.join("untracked"), "check artifact").unwrap();
        assert_eq!(read(), MergeOutcome::AlreadyIntegrated);
        fs::write(root.join("file.txt"), "dirty").unwrap();
        assert_eq!(read(), MergeOutcome::Dirty);

        let dirs = git_dirs(root).unwrap();
        fs::write(dirs[0].join("MERGE_HEAD"), &f.request.source_branch).unwrap();
        assert_eq!(read(), MergeOutcome::InProgress);
        fs::remove_file(dirs[0].join("MERGE_HEAD")).unwrap();

        git::run(git::git(root).args(["switch", "--detach"])).unwrap();
        let rebase = dirs[0].join("rebase-merge");
        fs::create_dir(&rebase).unwrap();
        fs::write(rebase.join("head-name"), "refs/heads/main\n").unwrap();
        assert_eq!(read(), MergeOutcome::InProgress);
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
            // New source files aren't in the merge; untracked destination files are artifacts.
            let expected = if path == &f.request.source {
                MergeOutcome::Dirty
            } else {
                MergeOutcome::AlreadyIntegrated
            };
            assert_eq!(outcome(&f.project, &f.request).unwrap(), expected);
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
        fs::write(destination.join("coverage.out"), "report").unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::Merged
        );
        // Uncommitted new files in the source would be left out of a finished merge.
        fs::write(source.join("notes.md"), "unsaved work").unwrap();
        assert_eq!(
            outcome(&f.project, &f.request).unwrap(),
            MergeOutcome::Dirty
        );
        fs::remove_file(source.join("notes.md")).unwrap();
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
    fn automatic_merge_preparation_requires_the_reviewed_source_head() {
        let mut f = Fixture::new();
        let source = Path::new(&f.request.source);
        let head = git::run(git::git(source).args(["rev-parse", "HEAD"])).unwrap();
        f.request.expected_source_head = Some(head);
        let job = f.prepare().unwrap();
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        git::run(git::git(source).args(["commit", "--allow-empty", "-qm", "Changed after review"]))
            .unwrap();
        assert!(
            f.prepare()
                .err()
                .expect("source must still match review")
                .to_string()
                .contains("The source changed since review")
        );
    }

    #[test]
    fn auto_context_is_opt_in_for_jobs() {
        let f = Fixture::new();
        let auto = context::AutoBrief {
            autonomous: false,
            goal: "Goal".into(),
            fix_floor: None,
            effort_note: "Thorough".into(),
            commit: true,
        };
        let plain = f.prepare().unwrap();
        let automatic = prepare(
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
                None,
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
    fn merge_briefing_inlines_review_findings_and_identifies_stale_heads() {
        let f = Fixture::new();
        let review = crate::reviews::prepare(
            &f.project,
            &crate::reviews::ReviewRequest {
                focus: None,
                worktree: f.request.source.clone(),
                branch: "feature".into(),
                base: "main".into(),
                lane: None,
                round: None,
            },
            &Fixture::terminal("claude"),
            &AllowAll,
            None,
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
            assert!(body.contains("P1 file.txt:1: sample finding"));
            assert!(body.contains(&format!("Reviewed HEAD matches source HEAD: {current}")));
            assert!(body.contains("mention unresolved findings"));
            assert!(body.contains("Do not fix them unless the merge requires it"));
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
        context::remove_owned_briefing_file(&context::owned_briefing(&review.spec).unwrap());
    }

    #[test]
    fn merge_briefing_includes_every_reviewer_and_never_the_old_single_file() {
        for old_single_file in [false, true] {
            let f = Fixture::new();
            let root = Path::new(&f.project.root);
            if old_single_file {
                crate::reviews::dir(root).unwrap();
                fs::write(
                    crate::reviews::file(root, "feature").unwrap(),
                    "Stale findings",
                )
                .unwrap();
            }
            for lane in ["claude", "codex"] {
                let review = crate::reviews::prepare(
                    &f.project,
                    &crate::reviews::ReviewRequest {
                        focus: None,
                        worktree: f.request.source.clone(),
                        branch: "feature".into(),
                        base: "main".into(),
                        lane: Some(lane.into()),
                        round: Some("round".into()),
                    },
                    &Fixture::terminal("claude"),
                    &AllowAll,
                    None,
                )
                .unwrap()
                .job;
                fs::write(
                    crate::reviews::lane_file(root, "feature", Some(lane)).unwrap(),
                    format!("Verdict: issues\n- [high] Finding from {lane}"),
                )
                .unwrap();
                context::remove_owned_briefing_file(
                    &context::owned_briefing(&review.spec).unwrap(),
                );
            }
            let job = f.prepare().unwrap();
            let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
            assert!(body.contains("Finding from claude"));
            assert!(body.contains("Finding from codex"));
            for lane in ["claude", "codex"] {
                assert!(
                    body.contains(
                        &crate::reviews::lane_file(root, "feature", Some(lane))
                            .unwrap()
                            .display()
                            .to_string()
                    )
                );
            }
            assert!(
                !body.contains(
                    &crate::reviews::file(root, "feature")
                        .unwrap()
                        .display()
                        .to_string()
                )
            );
            assert!(!body.contains("Stale findings"));
            assert!(!body.contains("fix each issue once"));
            assert!(body.contains("Do not fix them unless the merge requires it"));
            context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());
        }
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
            None,
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

    fn dirty_source(f: &Fixture) -> Vec<String> {
        let source = Path::new(&f.request.source);
        fs::write(source.join("file.txt"), "edited\n").unwrap();
        fs::write(source.join("new.txt"), "new\n").unwrap();
        source_changes(&f.project, &f.request.source, "feature").unwrap()
    }

    #[test]
    fn source_changes_keep_git_status_codes() {
        let f = Fixture::new();
        assert!(
            source_changes(&f.project, &f.request.source, "feature")
                .unwrap()
                .is_empty()
        );
        assert_eq!(dirty_source(&f), [" M file.txt", "?? new.txt"]);
    }

    #[test]
    fn dirty_source_merges_only_with_the_confirmed_changes() {
        let mut f = Fixture::new();
        let changes = dirty_source(&f);
        let resolve = |confirmed: Option<&[String]>| {
            resolve_destination(&f.project, &f.request.source, "feature", "main", confirmed)
        };
        assert!(
            resolve(None)
                .unwrap_err()
                .to_string()
                .contains("uncommitted")
        );
        let stale = vec![changes[0].clone()];
        assert!(
            resolve(Some(&stale))
                .unwrap_err()
                .to_string()
                .contains("review them")
        );
        let request = resolve(Some(&changes)).unwrap();
        assert_eq!(request.commit_source.as_ref(), Some(&changes));

        assert!(f.error().contains("uncommitted"));
        f.request.commit_source = Some(stale);
        assert!(f.error().contains("review them"));
        f.request = request;
        let job = f.prepare().unwrap();
        assert!(job.spec.dirs.contains(&PathBuf::from(&f.request.source)));
        let body = fs::read_to_string(&job.spec.env[context::CONTEXT_ENV]).unwrap();
        assert!(body.contains("Commit the source changes first"));
        assert!(body.contains(" M file.txt\n?? new.txt"));
        assert!(body.contains("Merge the new source HEAD"));
        assert!(!body.contains("Do not modify the source worktree, push"));
        context::remove_owned_briefing_file(&context::owned_briefing(&job.spec).unwrap());

        fs::write(Path::new(&f.request.source).join("later.txt"), "x").unwrap();
        assert!(f.error().contains("review them"));
    }

    #[test]
    fn confirmed_source_changes_do_not_excuse_a_dirty_destination() {
        let f = Fixture::new();
        let changes = dirty_source(&f);
        fs::write(Path::new(&f.project.root).join("dirty"), "work").unwrap();
        let error = resolve_destination(
            &f.project,
            &f.request.source,
            "feature",
            "main",
            Some(&changes),
        )
        .unwrap_err();
        assert!(error.to_string().contains("destination worktree"));
    }

    #[test]
    fn source_committed_after_confirmation_merges_normally() {
        let f = Fixture::new();
        let confirmed = vec![" M file.txt".to_string()];
        let request = resolve_destination(
            &f.project,
            &f.request.source,
            "feature",
            "main",
            Some(&confirmed),
        )
        .unwrap();
        assert_eq!(request.commit_source, None);
    }

    #[test]
    fn commit_runs_resume_with_the_source_until_it_is_removed() {
        let mut f = Fixture::new();
        f.request.commit_source = Some(dirty_source(&f));
        let job = f.prepare().unwrap();
        let roots = resume_roots(Path::new(&f.project.root), &job.spec).unwrap();
        assert!(roots.contains(&PathBuf::from(&f.request.source)));
        let record: crate::session::Record = serde_json::from_value(serde_json::json!({
            "id":"merge", "metadata": {
                "projectId":"p", "projectName":"P", "projectRoot":f.project.root,
                "componentId":MERGE_SCOPE, "terminalId":"merge", "name":"Merge", "kind":"agent"
            },
            "spec":job.spec, "snapshot":null, "history":[], "interrupted":true, "requestIds":[]
        }))
        .unwrap();
        crate::session::check_resume(&record, &roots).unwrap();
        git::run(git::git(Path::new(&f.project.root)).args([
            "worktree",
            "remove",
            "--force",
            &f.request.source,
        ]))
        .unwrap();
        assert!(resume_roots(Path::new(&f.project.root), &job.spec).is_err());
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
        assert!(prepare(&f.project, &f.request, &terminal, &AllowAll, None).is_err());
    }
    #[test]
    fn conflict_check_reports_paths_and_leaves_worktrees_untouched() {
        let f = Fixture::new();
        let root = Path::new(&f.project.root);
        assert!(conflicts(root, "feature", "main").unwrap().is_empty());
        for (path, text) in [
            (&f.request.source, "source\n"),
            (&f.request.destination, "destination\n"),
        ] {
            fs::write(Path::new(path).join("file.txt"), text).unwrap();
            git::run(git::git(Path::new(path)).args(["add", "file.txt"])).unwrap();
            git::run(git::git(Path::new(path)).args(["commit", "-qm", "change"])).unwrap();
        }
        assert_eq!(
            conflicts(root, "feature", "main").unwrap(),
            vec!["file.txt"]
        );
        assert!(
            git::run(git::git(root).args(["status", "--porcelain"]))
                .unwrap()
                .is_empty()
        );
        assert!(conflicts(root, "--bad-ref", "main").is_err());
    }
}
