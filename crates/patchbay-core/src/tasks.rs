//! Tasks: named pieces of work, each on its own branch and worktree of the
//! project's repo, sharing the project's map. Terminals started for a task run
//! in its worktree (see [`project_in`]), so several tasks can run the same
//! component's terminals side by side.
//!
//! Tasks belong to the user, not the project: they are stored in the repo's
//! common git directory (`<git-common-dir>/patchbay/tasks.json`), which every
//! worktree shares and nothing commits.

use crate::context::ContextSection;
use crate::detect::slug;
use crate::git::{self, git, nearest_repo};
use crate::model::Project;
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_VERSION: u32 = 1;

/// Serializes read-modify-write cycles of the store within this process.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// ASCII letters and digits only, so it can end a session id.
    pub id: String,
    pub title: String,
    /// Canonical worktree folder, as [`git::worktrees`] lists it.
    pub worktree: String,
    /// The branch checked out there when last listed; absent when detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// What the branch was created from, when Patchbay created it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Components the task is about, as the user picked them.
    #[serde(default)]
    pub components: Vec<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_ms: u64,
    /// The worktree no longer exists. Recomputed on every listing.
    #[serde(default)]
    pub missing: bool,
    /// The project is open in this worktree. Recomputed on every listing.
    #[serde(default)]
    pub current: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    tasks: Vec<Task>,
}

/// A task to create on a new (or existing, unchecked-out) branch.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub title: String,
    pub branch: String,
    /// Commit-ish to branch from; the open worktree's `HEAD` when absent.
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub components: Vec<String>,
}

/// Fields of a task the user can edit.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub components: Option<Vec<String>>,
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn repo_of(root: &Path) -> Result<PathBuf> {
    nearest_repo(root).ok_or_else(|| anyhow!("Tasks need the project to be in a git repo"))
}

/// Run a git command, failing with its own error message.
fn run(cmd: &mut Command) -> Result<String> {
    let out = cmd.stdin(Stdio::null()).output().context("running git")?;
    if !out.status.success() {
        let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(if message.is_empty() {
            "git failed".to_string()
        } else {
            message
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn store_file(root: &Path) -> Result<PathBuf> {
    let repo = repo_of(root)?;
    let dir = run(git(&repo).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]))?;
    Ok(PathBuf::from(dir).join("patchbay").join("tasks.json"))
}

fn load(file: &Path) -> Result<Store> {
    match std::fs::read_to_string(file) {
        Ok(text) => {
            serde_json::from_str(&text).with_context(|| format!("parsing {}", file.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.into()),
    }
}

fn save(file: &Path, store: &mut Store) -> Result<()> {
    store.version = STORE_VERSION;
    let dir = file
        .parent()
        .ok_or_else(|| anyhow!("bad task store path"))?;
    std::fs::create_dir_all(dir)?;
    let mut text = serde_json::to_string_pretty(store)?;
    text.push('\n');
    let tmp = dir.join(format!(".tasks.{}.tmp", std::process::id()));
    std::fs::write(&tmp, text)?;
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// Update the derived fields (`branch`, `missing`, `current`) from git.
fn reconcile(root: &Path, tasks: &mut [Task]) {
    let trees = git::worktrees(root);
    for task in tasks {
        if let Some(w) = trees.iter().find(|w| w.path == task.worktree) {
            task.missing = false;
            task.current = w.current;
            task.branch.clone_from(&w.branch);
        } else {
            task.missing = true;
            task.current = false;
        }
    }
}

/// Load, change and save the store under the lock.
fn modify<T>(root: &Path, change: impl FnOnce(&mut Vec<Task>) -> Result<T>) -> Result<T> {
    let file = store_file(root)?;
    let _guard = lock();
    let mut store = load(&file)?;
    let out = change(&mut store.tasks)?;
    save(&file, &mut store)?;
    Ok(out)
}

/// The tasks of the repo containing `root` (canonical), oldest first.
///
/// # Errors
/// Fails if `root` isn't in a repo or the store can't be read.
pub fn list(root: &Path) -> Result<Vec<Task>> {
    let file = store_file(root)?;
    let mut tasks = {
        let _guard = lock();
        load(&file)?.tasks
    };
    reconcile(root, &mut tasks);
    Ok(tasks)
}

/// A task as stored, without asking git about its worktree. For callers that
/// validate the worktree themselves ([`git::in_worktree`] does).
///
/// # Errors
/// Fails if the store can't be read or there is no such task.
pub fn stored(root: &Path, id: &str) -> Result<Task> {
    let file = store_file(root)?;
    let _guard = lock();
    load(&file)?
        .tasks
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow!("There is no task {id}"))
}

/// One task whose worktree exists.
///
/// # Errors
/// Fails if there is no such task or its worktree is gone.
pub fn find(root: &Path, id: &str) -> Result<Task> {
    let task = list(root)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow!("There is no task {id}"))?;
    if task.missing {
        bail!("The worktree of “{}” no longer exists", task.title);
    }
    Ok(task)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn new_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut n = now_ms()
        .wrapping_mul(1000)
        .wrapping_add(NEXT.fetch_add(1, Ordering::Relaxed) % 1000);
    let mut digits = Vec::new();
    while n > 0 {
        let d = u32::try_from(n % 36).unwrap_or(0);
        digits.push(char::from_digit(d, 36).unwrap_or('0'));
        n /= 36;
    }
    format!("t{}", digits.iter().rev().collect::<String>())
}

/// Reject anything git could read as an option.
fn not_an_option(value: &str, what: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') {
        bail!("That isn't a valid {what}");
    }
    Ok(())
}

fn check_branch(repo: &Path, branch: &str) -> Result<()> {
    not_an_option(branch, "branch name")?;
    run(git(repo).args(["check-ref-format", "--branch", branch]))
        .map_err(|_| anyhow!("“{branch}” isn't a valid branch name"))?;
    Ok(())
}

/// Whether exactly one remote has `branch`, so `git worktree add <path> <branch>`
/// creates a local branch tracking it.
fn on_one_remote(repo: &Path, branch: &str) -> bool {
    run(git(repo).args(["for-each-ref", "--format=%(refname)", "refs/remotes"])).is_ok_and(|out| {
        out.lines()
            .filter(|r| {
                r.ends_with(&format!("/{branch}"))
                    && r.split('/').count() == branch.split('/').count() + 3
            })
            .count()
            == 1
    })
}

fn verifies(repo: &Path, rev: &str) -> bool {
    run(git(repo).args(["rev-parse", "--verify", "-q", rev])).is_ok()
}

/// A folder beside the main worktree named after it and the branch, e.g.
/// `shop-fix-login` for branch `fix/login` of `shop`.
fn free_path(main: &Path, branch: &str) -> Result<PathBuf> {
    let parent = main
        .parent()
        .ok_or_else(|| anyhow!("The repo has no parent folder for worktrees"))?;
    let name = main
        .file_name()
        .map_or_else(|| "repo".into(), |n| n.to_string_lossy().into_owned());
    let base = format!("{name}-{}", slug(branch));
    (1..100)
        .map(|i| {
            if i == 1 {
                parent.join(&base)
            } else {
                parent.join(format!("{base}-{i}"))
            }
        })
        .find(|p| !p.exists())
        .ok_or_else(|| anyhow!("No free folder for the worktree beside {}", main.display()))
}

/// Create a worktree beside the repo's main worktree for `draft.branch`
/// (created from `draft.base`, or the open `HEAD`, unless it already exists),
/// and a task for it.
///
/// # Errors
/// Fails for an invalid branch or base, or if git refuses (for example when
/// the branch is checked out elsewhere).
pub fn create(root: &Path, draft: TaskDraft) -> Result<Task> {
    let title = draft.title.trim();
    if title.is_empty() {
        bail!("Give the task a title");
    }
    let repo = repo_of(root)?;
    let branch = draft.branch.trim();
    check_branch(&repo, branch)?;
    let base = draft
        .base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty());
    if let Some(base) = base {
        not_an_option(base, "base")?;
        if !verifies(&repo, &format!("{base}^{{commit}}")) {
            bail!("“{base}” isn't a branch or commit");
        }
    }
    let main = git::worktrees(root)
        .into_iter()
        .find(|w| w.main)
        .map_or_else(|| repo.clone(), |w| PathBuf::from(w.path));
    let path = free_path(&main, branch)?;
    // Fail before touching git if the store can't be read.
    load(&store_file(root)?)?;
    let existing = verifies(&repo, &format!("refs/heads/{branch}"));
    let mut cmd = git(&repo);
    cmd.args(["worktree", "add"]);
    if !existing && base.is_none() && on_one_remote(&repo, branch) {
        // git checks out a local branch tracking the remote one.
        cmd.arg(&path).arg(branch);
    } else if existing {
        if base.is_some() {
            bail!("Branch {branch} already exists; leave the base empty to use it");
        }
        cmd.arg(&path).arg(branch);
    } else {
        cmd.arg("-b").arg(branch).arg(&path);
        cmd.args(base);
    }
    run(&mut cmd)?;
    let worktree = path.canonicalize()?.to_string_lossy().into_owned();
    let task = Task {
        id: new_id(),
        title: title.to_string(),
        worktree,
        branch: Some(branch.to_string()),
        base: base.map(str::to_string),
        components: draft.components,
        notes: String::new(),
        created_ms: now_ms(),
        missing: false,
        current: false,
    };
    let saved = modify(root, |tasks| {
        tasks.push(task.clone());
        Ok(())
    });
    if let Err(e) = saved {
        // Don't leave a worktree (and branch) behind that no task knows about.
        let _ = run(git(&repo).args(["worktree", "remove", "--force", &task.worktree]));
        if !existing {
            let _ = run(git(&repo).args(["branch", "-D", branch]));
        }
        return Err(e);
    }
    find(root, &task.id)
}

/// Make a task of an existing worktree of the repo (one [`git::worktrees`]
/// lists, other than the open one).
///
/// # Errors
/// Fails if `worktree` isn't one of the repo's worktrees, is the open one, or
/// already has a task.
pub fn attach(
    root: &Path,
    worktree: &str,
    title: Option<String>,
    components: Vec<String>,
) -> Result<Task> {
    let tree = git::worktrees(root)
        .into_iter()
        .find(|w| w.path == worktree)
        .ok_or_else(|| anyhow!("{worktree} isn't a worktree of this repo"))?;
    if tree.current {
        bail!("That is the worktree the project is open in");
    }
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| tree.branch.clone())
        .unwrap_or_else(|| {
            Path::new(&tree.path)
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        });
    let task = Task {
        id: new_id(),
        title,
        worktree: tree.path.clone(),
        branch: tree.branch,
        base: None,
        components,
        notes: String::new(),
        created_ms: now_ms(),
        missing: false,
        current: false,
    };
    modify(root, |tasks| {
        if tasks.iter().any(|t| t.worktree == tree.path) {
            bail!("That worktree already has a task");
        }
        tasks.push(task.clone());
        Ok(())
    })?;
    find(root, &task.id)
}

/// Edit a task's title, notes or components.
///
/// # Errors
/// Fails if there is no such task or the store can't be written.
pub fn update(root: &Path, id: &str, patch: TaskPatch) -> Result<Task> {
    let mut task = modify(root, |tasks| {
        let task = tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow!("There is no task {id}"))?;
        if let Some(title) = patch.title.map(|t| t.trim().to_string()) {
            if title.is_empty() {
                bail!("Give the task a title");
            }
            task.title = title;
        }
        if let Some(notes) = patch.notes {
            task.notes = notes;
        }
        if let Some(components) = patch.components {
            task.components = components;
        }
        Ok(task.clone())
    })?;
    reconcile(root, std::slice::from_mut(&mut task));
    Ok(task)
}

/// Check that [`remove`] with `delete_worktree` would succeed: the project
/// isn't open in the task's worktree and it has no uncommitted or untracked
/// changes. Lets callers ask before stopping the task's terminals.
///
/// # Errors
/// Fails with the reason the worktree can't be removed.
pub fn check_removable(root: &Path, id: &str) -> Result<Task> {
    let task = list(root)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| anyhow!("There is no task {id}"))?;
    if task.missing {
        return Ok(task);
    }
    if task.current {
        bail!("The project is open in this task's worktree");
    }
    let dirty = run(git(Path::new(&task.worktree)).args(["status", "--porcelain"]))?;
    if !dirty.is_empty() {
        bail!(
            "“{}” has uncommitted or untracked changes; commit or discard them first",
            task.title
        );
    }
    Ok(task)
}

/// Forget a task and, with `delete_worktree`, remove its worktree. git refuses
/// to remove a worktree with uncommitted or untracked changes, and the branch
/// is always kept.
///
/// # Errors
/// Fails if there is no such task, the project is open in its worktree, or git
/// refuses to remove it.
pub fn remove(root: &Path, id: &str, delete_worktree: bool) -> Result<()> {
    let task = if delete_worktree {
        check_removable(root, id)?
    } else {
        list(root)?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow!("There is no task {id}"))?
    };
    if delete_worktree && !task.missing {
        run(git(&repo_of(root)?).args(["worktree", "remove", &task.worktree]))?;
    }
    modify(root, |tasks| {
        tasks.retain(|t| t.id != id);
        Ok(())
    })
}

/// `project` (already trusted and restricted) as it is in `task`'s worktree:
/// the root moves into the worktree and components that aren't in it (other
/// repos, or folders the branch doesn't have) are dropped with their links.
/// Returns the names of the dropped components too.
///
/// # Errors
/// Fails if the worktree isn't usable, or a `required` component isn't in it.
pub fn project_in(
    project: &Project,
    task: &Task,
    required: &[String],
) -> Result<(Project, Vec<String>)> {
    let components = project
        .components
        .iter()
        .map(|c| (c.id.clone(), project.component_dir(c)))
        .collect();
    let (root, mapped) =
        git::in_worktree(Path::new(&project.root), components, Some(&task.worktree))?;
    let kept: HashSet<String> = mapped.into_iter().map(|(id, _)| id).collect();
    for id in required {
        if !kept.contains(id) {
            let name = project.component(id).map_or(id.as_str(), |c| &c.name);
            bail!("{name} isn't in the worktree of “{}”", task.title);
        }
    }
    let mut out = project.clone();
    out.root = root.display().to_string();
    let dropped = out
        .components
        .iter()
        .filter(|c| !kept.contains(&c.id))
        .map(|c| c.name.clone())
        .collect();
    out.components.retain(|c| kept.contains(&c.id));
    out.links
        .retain(|l| kept.contains(&l.source) && kept.contains(&l.target));
    for group in &mut out.groups {
        group.component_ids.retain(|id| kept.contains(id));
    }
    Ok((out, dropped))
}

/// The briefing section telling an agent which task it works on.
#[must_use]
pub fn context_section(project: &Project, task: &Task, dropped: &[String]) -> ContextSection {
    let mut body = format!("You are working on the task “{}”", task.title);
    if let Some(branch) = &task.branch {
        let _ = write!(body, " on branch `{branch}`");
    }
    let _ = writeln!(
        body,
        ", in its own git worktree at `{}`. Make changes there only.",
        task.worktree
    );
    let names: Vec<&str> = task
        .components
        .iter()
        .filter_map(|id| project.component(id).map(|c| c.name.as_str()))
        .collect();
    if !names.is_empty() {
        let _ = writeln!(body, "\nThe task is about: {}.", names.join(", "));
    }
    if !task.notes.trim().is_empty() {
        let _ = writeln!(body, "\nNotes:\n\n{}", task.notes.trim());
    }
    if !dropped.is_empty() {
        let _ = writeln!(
            body,
            "\nNot in this worktree (in other repos, or not on this branch): {}.",
            dropped.join(", ")
        );
    }
    ContextSection {
        title: "Task".into(),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, process};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = env::temp_dir().join(format!(
                "patchbay-tasks-{}-{}",
                process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn write(&self, rel: &str, text: &str) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }

        fn git(&self, rel: &str, args: &[&str]) -> bool {
            Command::new("git")
                .arg("-C")
                .arg(self.0.join(rel))
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .is_ok_and(|o| o.status.success())
        }

        /// A repo `shop` with `apps/web` committed; false without git.
        fn repo(&self) -> Option<PathBuf> {
            self.write("shop/apps/web/a.ts", "x");
            self.write("billing/b.ts", "x");
            (self.git("shop", &["init", "-q", "-b", "main"])
                && self.git("shop", &["add", "."])
                && self.git("shop", &["commit", "-qm", "init"]))
            .then(|| self.0.join("shop"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn project(root: &Path) -> Project {
        serde_json::from_value(serde_json::json!({
            "name": "shop",
            "root": root.display().to_string(),
            "components": [
                { "id": "web", "name": "Web", "path": "apps/web" },
                { "id": "billing", "name": "Billing", "path": "../billing" }
            ],
            "links": [{ "id": "l", "source": "web", "target": "billing" }]
        }))
        .unwrap()
    }

    #[test]
    fn creates_lists_maps_and_removes_a_task() {
        let f = Fixture::new();
        let Some(root) = f.repo() else {
            return;
        };
        assert!(list(&root).unwrap().is_empty());
        let draft = |branch: &str| TaskDraft {
            title: "Fix login".into(),
            branch: branch.into(),
            base: None,
            components: vec!["web".into()],
        };
        assert!(create(&root, draft("-x")).is_err());
        assert!(create(&root, draft("bad..name")).is_err());
        let task = create(&root, draft("fix/login")).unwrap();
        assert_eq!(task.branch.as_deref(), Some("fix/login"));
        let expected = f.0.join("shop-fix-login");
        assert_eq!(Path::new(&task.worktree), expected);
        assert!(!task.missing && !task.current);
        // The store lives in the common git dir, so the worktree sees it too.
        assert_eq!(list(&expected).unwrap()[0].id, task.id);
        assert!(list(&expected).unwrap()[0].current);
        // Branch already checked out.
        assert!(create(&root, draft("fix/login")).is_err());

        let p = project(&root);
        let (mapped, dropped) = project_in(&p, &task, &["web".into()]).unwrap();
        assert_eq!(Path::new(&mapped.root), expected);
        assert_eq!(dropped, ["Billing"]);
        assert_eq!(mapped.components.len(), 1);
        assert!(mapped.links.is_empty());
        assert_eq!(
            mapped.component_dir(&mapped.components[0]),
            expected.join("apps/web")
        );
        assert!(project_in(&p, &task, &["billing".into()]).is_err());
        let section = context_section(&p, &task, &dropped);
        assert!(section.body.contains("fix/login") && section.body.contains("Web"));

        let edited = update(
            &root,
            &task.id,
            TaskPatch {
                notes: Some("n".into()),
                ..TaskPatch::default()
            },
        )
        .unwrap();
        assert_eq!(edited.notes, "n");

        // A dirty worktree isn't removed.
        f.write("shop-fix-login/new.txt", "x");
        assert!(remove(&root, &task.id, true).is_err());
        fs::remove_file(expected.join("new.txt")).unwrap();
        remove(&root, &task.id, true).unwrap();
        assert!(!expected.exists());
        assert!(list(&root).unwrap().is_empty());
        // The branch is kept.
        assert!(verifies(&root, "refs/heads/fix/login"));
    }

    #[test]
    fn checks_out_a_branch_that_only_a_remote_has() {
        let f = Fixture::new();
        if f.repo().is_none() {
            return;
        }
        assert!(f.git("shop", &["branch", "feature/x"]));
        assert!(f.git(".", &["clone", "-q", "shop", "copy"]));
        let copy = f.0.join("copy");
        assert!(!verifies(&copy, "refs/heads/feature/x"));
        let task = create(
            &copy,
            TaskDraft {
                title: "Remote".into(),
                branch: "feature/x".into(),
                base: None,
                components: vec![],
            },
        )
        .unwrap();
        assert_eq!(task.branch.as_deref(), Some("feature/x"));
        let upstream =
            run(git(Path::new(&task.worktree)).args(["rev-parse", "--abbrev-ref", "@{upstream}"]))
                .unwrap();
        assert_eq!(upstream, "origin/feature/x");
        assert!(check_removable(&copy, &task.id).is_ok());
        f.write("copy-feature-x/dirty.txt", "x");
        assert!(check_removable(&copy, &task.id).is_err());
    }

    #[test]
    fn attaches_existing_worktrees_once() {
        let f = Fixture::new();
        let Some(root) = f.repo() else {
            return;
        };
        let wt = f.0.join("elsewhere");
        assert!(f.git(
            "shop",
            &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]
        ));
        let wt = wt.canonicalize().unwrap().to_string_lossy().into_owned();
        assert!(attach(&root, root.to_str().unwrap(), None, vec![]).is_err());
        assert!(attach(&root, f.0.to_str().unwrap(), None, vec![]).is_err());
        let task = attach(&root, &wt, None, vec![]).unwrap();
        assert_eq!(task.title, "side");
        assert!(attach(&root, &wt, None, vec![]).is_err());
        fs::remove_dir_all(&wt).unwrap();
        assert!(list(&root).unwrap()[0].missing);
        assert!(find(&root, &task.id).is_err());
        remove(&root, &task.id, true).unwrap();
        assert!(list(&root).unwrap().is_empty());
    }
}
