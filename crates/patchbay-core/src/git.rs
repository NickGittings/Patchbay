//! Git status per component. A project may span several repos (a parent folder
//! of repos, or repos added from elsewhere), so components are grouped by the
//! repo that contains them and each repo is queried once.

use crate::model::{PROJECT_SCOPE, Project, normalize, relative_path};
use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// The nearest folder at or above `dir` containing `.git` (a directory, or a
/// file for worktrees and submodules). Returns a canonical path.
#[must_use]
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    nearest_repo(&dir.canonicalize().ok()?)
}

/// [`repo_root`] for a folder that is already canonical.
fn nearest_repo(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// Components that live in one repo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoGroup {
    pub root: PathBuf,
    /// `(component id, folder prefix within the repo)`; the prefix is empty for
    /// the repo root and otherwise ends in `/`.
    pub members: Vec<(String, String)>,
}

impl RepoGroup {
    /// Pathspecs limiting a query to the members' folders, so a component (or
    /// the project scope) deep inside a large repo doesn't scan all of it.
    /// Empty, meaning the whole repo, when a member sits at the repo root.
    fn pathspecs(&self) -> Vec<String> {
        if self.members.iter().any(|(_, prefix)| prefix.is_empty()) {
            return Vec::new();
        }
        self.members
            .iter()
            .map(|(_, prefix)| prefix.trim_end_matches('/').to_string())
            .collect()
    }
}

/// Group components, given as `(id, canonical folder)`, by containing repo.
/// Components whose folder is not in a repo are left out.
#[must_use]
pub fn group_by_repo(components: &[(String, PathBuf)]) -> Vec<RepoGroup> {
    let mut groups: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    for (id, dir) in components {
        let Some(root) = nearest_repo(dir) else {
            continue;
        };
        let rel = relative_path(&root, dir);
        let prefix = if rel == "." {
            String::new()
        } else {
            format!("{rel}/")
        };
        groups.entry(root).or_default().push((id.clone(), prefix));
    }
    groups
        .into_iter()
        .map(|(root, members)| RepoGroup { root, members })
        .collect()
}

/// The component owning `path` (relative to the repo root): the member with the
/// longest matching folder prefix, so nested components take their own files.
#[must_use]
pub fn owner_of<'a>(path: &str, members: &'a [(String, String)]) -> Option<&'a str> {
    members
        .iter()
        .filter(|(_, prefix)| path.starts_with(prefix.as_str()))
        .max_by_key(|(_, prefix)| prefix.len())
        .map(|(id, _)| id.as_str())
}

/// Uncommitted-change counts plus which repo each component belongs to.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Changed files per component. Components not in a repo are absent.
    pub changes: HashMap<String, usize>,
    /// Repo folder name per component, only for components whose repo is not
    /// the project root's, so the canvas can label them.
    pub repos: HashMap<String, String>,
}

/// How a file differs from `HEAD`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    TypeChanged,
    Conflicted,
    Untracked,
}

/// One uncommitted change, as listed for review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the project root (`../billing/…` for a sibling repo), like
    /// every other path the webview sees.
    pub path: String,
    pub kind: ChangeKind,
    /// The path before a rename, relative to the project root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// Last modification, in Unix milliseconds; absent for deleted files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    /// Lines added and removed against `HEAD`; absent for binary files and
    /// untracked files too large to count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

/// A file's diff against `HEAD`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Unified diff text, cut at [`MAX_DIFF_BYTES`].
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
}

/// Diffs larger than this are cut, so a generated file can't flood the webview.
pub const MAX_DIFF_BYTES: usize = 1 << 20;

/// A changed path from `git status`, relative to its repo.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    path: String,
    kind: ChangeKind,
    old_path: Option<String>,
}

impl Entry {
    /// `counts` are a repo's [`line_counts`]; untracked files are counted here.
    fn into_changed(
        self,
        root: &Path,
        repo: &Path,
        counts: &HashMap<String, (u32, u32)>,
    ) -> ChangedFile {
        let abs = repo.join(&self.path);
        let modified_ms = (self.kind != ChangeKind::Deleted)
            .then(|| modified_ms(&abs))
            .flatten();
        let (added, removed) = if self.kind == ChangeKind::Untracked {
            (cached_line_count(&abs), Some(0))
        } else {
            counts
                .get(&self.path)
                .map_or((None, None), |&(a, r)| (Some(a), Some(r)))
        };
        ChangedFile {
            path: relative_path(root, &abs),
            kind: self.kind,
            old_path: self
                .old_path
                .map(|old| relative_path(root, &repo.join(old))),
            modified_ms,
            added,
            removed: added.and(removed),
        }
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = path.symlink_metadata().ok()?.modified().ok()?;
    let since = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// Line counts of untracked files by path, with the size and mtime they were
/// counted at, so refreshes don't re-read files that haven't changed.
#[derive(Default)]
struct LineCache {
    /// Path → (size, mtime, lines, the refresh that last used it).
    entries: HashMap<PathBuf, (u64, Option<SystemTime>, Option<u32>, u64)>,
    /// Bumped by every [`changes`] refresh.
    refresh: u64,
    /// Size at which entries the last two refreshes didn't use are dropped.
    prune_at: usize,
}
static LINE_CACHE: LazyLock<Mutex<LineCache>> = LazyLock::new(Mutex::default);
/// The cache is pruned no sooner than at this many entries.
const LINE_CACHE_LIMIT: usize = 20_000;

/// Start a refresh, so entries it uses survive the next prune.
fn next_line_refresh() {
    if let Ok(mut cache) = LINE_CACHE.lock() {
        cache.refresh += 1;
    }
}

/// [`count_lines`], reusing the last count while the file's size and mtime
/// are unchanged. Only entries no recent refresh used are evicted, so a repo
/// with more untracked files than [`LINE_CACHE_LIMIT`] still hits the cache.
fn cached_line_count(path: &Path) -> Option<u32> {
    let meta = path.symlink_metadata().ok()?;
    let stamp = (meta.len(), meta.modified().ok());
    if let Ok(mut cache) = LINE_CACHE.lock() {
        let refresh = cache.refresh;
        if let Some(entry) = cache.entries.get_mut(path)
            && (entry.0, entry.1) == stamp
        {
            entry.3 = refresh;
            return entry.2;
        }
    }
    let lines = count_lines(path);
    if let Ok(mut cache) = LINE_CACHE.lock() {
        let cache = &mut *cache;
        if cache.entries.len() >= cache.prune_at.max(LINE_CACHE_LIMIT) {
            let recent = cache.refresh.saturating_sub(1);
            cache.entries.retain(|_, e| e.3 >= recent);
            // A working set past the limit grows the cache instead of
            // pruning on every insert.
            cache.prune_at = cache.entries.len() * 2;
        }
        let refresh = cache.refresh;
        cache
            .entries
            .insert(path.to_path_buf(), (stamp.0, stamp.1, lines, refresh));
    }
    lines
}

/// Lines in an untracked regular file, or `None` for a binary file, one
/// larger than [`MAX_DIFF_BYTES`], or anything else (a symlink or a FIFO).
fn count_lines(path: &Path) -> Option<u32> {
    if !path.symlink_metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_DIFF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_DIFF_BYTES || bytes.contains(&0) {
        return None;
    }
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
    let unterminated = usize::from(bytes.last().is_some_and(|&b| b != b'\n'));
    u32::try_from(newlines + unterminated).ok()
}

/// Run `query` for every group's repo at once (in parallel, so many sibling
/// repos don't add up to one long refresh). `None` where it panicked.
fn per_repo<T: Send>(
    groups: &[RepoGroup],
    query: impl Fn(&RepoGroup) -> T + Sync,
) -> Vec<Option<T>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = groups.iter().map(|g| scope.spawn(|| query(g))).collect();
        handles.into_iter().map(|h| h.join().ok()).collect()
    })
}

/// Run `git status` for every group. `None` where git failed.
fn query_groups(groups: &[RepoGroup]) -> Vec<Option<Vec<Entry>>> {
    per_repo(groups, |g| changed_entries(&g.root, &g.pathspecs()))
        .into_iter()
        .map(Option::flatten)
        .collect()
}

/// `components` plus a [`PROJECT_SCOPE`] member at `root` that takes the
/// changed files under the root no component contains, unless a component
/// already sits at the root.
fn with_project_scope(root: &Path, components: &[(String, PathBuf)]) -> Vec<(String, PathBuf)> {
    let mut all = components.to_vec();
    if !components.iter().any(|(_, dir)| dir == root) {
        all.push((PROJECT_SCOPE.to_string(), root.to_path_buf()));
    }
    all
}

/// Count uncommitted changes per component, running `git status` once per
/// repo. Each changed file is attributed to the most specific component
/// containing it; files under `root` that no component contains count for
/// [`PROJECT_SCOPE`]. `components` are `(id, canonical folder)`; `root` is the
/// canonical project root.
#[must_use]
pub fn status(root: &Path, components: &[(String, PathBuf)]) -> GitStatus {
    let project_repo = repo_root(root);
    let groups = group_by_repo(&with_project_scope(root, components));
    let mut out = GitStatus::default();
    for (group, entries) in groups.iter().zip(query_groups(&groups)) {
        if project_repo.as_ref() != Some(&group.root) {
            let name = group
                .root
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            for (id, _) in &group.members {
                out.repos.insert(id.clone(), name.clone());
            }
        }
        let Some(entries) = entries else {
            continue;
        };
        for (id, _) in &group.members {
            out.changes.insert(id.clone(), 0);
        }
        for entry in entries {
            if let Some(id) = owner_of(&entry.path, &group.members) {
                *out.changes.entry(id.to_string()).or_default() += 1;
            }
        }
    }
    out
}

/// The changed files per component, attributed like [`status`] counts them,
/// so the lists match the counts (including [`PROJECT_SCOPE`]). Components in
/// a repo get a (possibly empty) list sorted by path; the rest are absent.
#[must_use]
pub fn changes(root: &Path, components: &[(String, PathBuf)]) -> HashMap<String, Vec<ChangedFile>> {
    changes_in(
        root,
        &group_by_repo(&with_project_scope(root, components)),
        None,
    )
}

/// One component's [`changes`]. Only the repo containing it is queried, but
/// with every component of that repo, so files are attributed the same way.
#[must_use]
pub fn component_changes(
    root: &Path,
    components: &[(String, PathBuf)],
    component_id: &str,
) -> Vec<ChangedFile> {
    let groups: Vec<RepoGroup> = group_by_repo(&with_project_scope(root, components))
        .into_iter()
        .filter(|g| g.members.iter().any(|(id, _)| id == component_id))
        .collect();
    changes_in(root, &groups, Some(component_id))
        .remove(component_id)
        .unwrap_or_default()
}

/// The changed files per member of `groups`, or only `only`'s, so other
/// members' untracked files aren't read just to be dropped. Files are built
/// (stat and line count) inside each repo's thread.
fn changes_in(
    root: &Path,
    groups: &[RepoGroup],
    only: Option<&str>,
) -> HashMap<String, Vec<ChangedFile>> {
    next_line_refresh();
    let results = per_repo(groups, |g| {
        let pathspecs = g.pathspecs();
        let entries = changed_entries(&g.root, &pathspecs)?;
        let counts = line_counts(&g.root, &pathspecs);
        let mut out: HashMap<String, Vec<ChangedFile>> = g
            .members
            .iter()
            .filter(|(id, _)| only.is_none_or(|only| id == only))
            .map(|(id, _)| (id.clone(), Vec::new()))
            .collect();
        for entry in entries {
            let Some(id) = owner_of(&entry.path, &g.members) else {
                continue;
            };
            if let Some(files) = out.get_mut(id) {
                files.push(entry.into_changed(root, &g.root, &counts));
            }
        }
        Some(out)
    });
    let mut out: HashMap<String, Vec<ChangedFile>> = HashMap::new();
    for result in results.into_iter().flatten().flatten() {
        out.extend(result);
    }
    for files in out.values_mut() {
        files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    out
}

/// A component that depends on changed components.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Affected {
    pub id: String,
    /// The changed components it depends on, directly or not.
    pub via: Vec<String>,
}

/// Everything the review view shows: changes per component, and the components
/// that depend on changed ones.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub changes: HashMap<String, Vec<ChangedFile>>,
    pub affected: Vec<Affected>,
}

/// [`changes`] for `components` (`(id, canonical folder)`, only folders the
/// user allowed) in `worktree` (see [`in_worktree`]), plus the components of
/// `project` that depend on a changed one. Those can include components not
/// in `components`, since that only reads the map.
///
/// # Errors
/// Fails if `worktree` isn't one of the project repo's worktrees, or the
/// project folder doesn't exist in it.
pub fn review(
    project: &Project,
    components: Vec<(String, PathBuf)>,
    worktree: Option<&str>,
) -> Result<Review> {
    let (root, components) = in_worktree(Path::new(&project.root), components, worktree)?;
    let changes = changes(&root, &components);
    let mut changed: Vec<String> = changes
        .iter()
        .filter(|(id, files)| !files.is_empty() && id.as_str() != PROJECT_SCOPE)
        .map(|(id, _)| id.clone())
        .collect();
    changed.sort();
    let affected = project
        .dependents(&changed)
        .into_iter()
        .map(|(id, via)| Affected { id, via })
        .collect();
    Ok(Review { changes, affected })
}

/// Which changed file to diff: `path` (relative to the project root) as
/// listed by [`changes`] for `component_id`, with the `old_path` it lists for
/// a rename, so the rename is detected.
#[derive(Debug, Clone, Copy)]
pub struct DiffTarget<'a> {
    pub component_id: &'a str,
    pub path: &'a str,
    pub old_path: Option<&'a str>,
}

/// The diff against `HEAD` of a changed file in `worktree` (see
/// [`in_worktree`]). The file must be one of the component's [`changes`]:
/// only listed paths are read, so the webview can't use this to read
/// arbitrary files. Untracked files diff as fully added; in a repo without
/// commits everything diffs against the empty tree. External diff drivers and
/// textconv filters are off, since they would run commands a repo's config
/// names.
///
/// # Errors
/// Fails if `worktree` isn't usable, the component isn't in a repo, the path
/// isn't one of its changes, or git fails.
pub fn diff(
    root: &Path,
    components: Vec<(String, PathBuf)>,
    worktree: Option<&str>,
    target: DiffTarget<'_>,
) -> Result<FileDiff> {
    let (root, components) = in_worktree(root, components, worktree)?;
    let DiffTarget {
        component_id,
        path,
        old_path,
    } = target;
    let group = group_by_repo(&with_project_scope(&root, &components))
        .into_iter()
        .find(|g| g.members.iter().any(|(id, _)| id == component_id))
        .ok_or_else(|| anyhow!("This component isn't in a git repo"))?;
    let not_listed = || anyhow!("{path} has no uncommitted changes");
    // Ask git about just this file (and its rename source), not the whole repo.
    let in_repo = |p: &str| {
        let abs = normalize(&root.join(p));
        (abs != group.root && abs.starts_with(&group.root))
            .then(|| relative_path(&group.root, &abs))
    };
    let mut pathspecs = vec![in_repo(path).ok_or_else(not_listed)?];
    pathspecs.extend(old_path.and_then(in_repo));
    let entry = changed_entries(&group.root, &pathspecs)
        .ok_or_else(|| anyhow!("git status failed"))?
        .into_iter()
        .filter(|e| owner_of(&e.path, &group.members) == Some(component_id))
        .find(|e| relative_path(&root, &group.root.join(&e.path)) == path)
        .ok_or_else(not_listed)?;
    let repo = &group.root;
    let mut args: Vec<String> = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
        .map(String::from)
        .into();
    if entry.kind == ChangeKind::Untracked {
        args.extend(["--no-index", "--", "/dev/null"].map(String::from));
        args.push(entry.path);
    } else {
        args.extend(["-M".to_string(), base_tree(repo)?, "--".to_string()]);
        args.push(entry.path);
        args.extend(entry.old_path);
    }
    // `--no-index` exits 1 when the files differ.
    run_capped(repo, &args, &[0, 1])
}

/// Lines added and removed per changed tracked path (relative to `repo`, the
/// new path for a rename), from one `git diff --numstat` against `HEAD`, like
/// [`diff`] compares, limited to `pathspecs` (none for the whole repo).
/// Binary files are absent; so is everything if git fails.
fn line_counts(repo: &Path, pathspecs: &[String]) -> HashMap<String, (u32, u32)> {
    let Ok(base) = base_tree(repo) else {
        return HashMap::new();
    };
    let output = git(repo)
        .args([
            "diff",
            "--numstat",
            "-z",
            "-M",
            "--no-ext-diff",
            "--no-textconv",
            &base,
            "--",
        ])
        .args(pathspecs)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match output {
        Ok(o) if o.status.success() => parse_numstat(&String::from_utf8_lossy(&o.stdout)),
        _ => HashMap::new(),
    }
}

/// `git diff --numstat -z` output: `added\tremoved\tpath\0`, or for a rename
/// `added\tremoved\t\0old\0new\0`. Binary files (`-\t-`) are skipped.
fn parse_numstat(out: &str) -> HashMap<String, (u32, u32)> {
    let mut counts = HashMap::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            records.next();
            records.next().unwrap_or_default()
        } else {
            path
        };
        if let (Ok(a), Ok(r)) = (added.parse(), removed.parse()) {
            counts.insert(path.to_string(), (a, r));
        }
    }
    counts
}

/// A worktree of the project root's repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Absolute and canonical; [`in_worktree`] takes it back.
    pub path: String,
    /// Short branch name; absent for a detached `HEAD`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub head: String,
    /// The repo's main worktree, which git lists first.
    pub main: bool,
    /// The worktree the project is open in.
    pub current: bool,
}

/// The worktrees of the repo containing `root` (canonical), main first. Bare
/// and missing (prunable) worktrees are left out; empty if `root` isn't in a
/// repo or git fails.
#[must_use]
pub fn worktrees(root: &Path) -> Vec<Worktree> {
    let Some(repo) = nearest_repo(root) else {
        return Vec::new();
    };
    let output = git(&repo)
        .args(["worktree", "list", "--porcelain"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_worktrees(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .enumerate()
        .filter(|(_, w)| !w.bare)
        .filter_map(|(i, w)| {
            let path = Path::new(&w.path).canonicalize().ok()?;
            Some(Worktree {
                current: path == repo,
                path: path.to_string_lossy().into_owned(),
                branch: w.branch,
                head: w.head,
                main: i == 0,
            })
        })
        .collect()
}

#[derive(Debug, Default, PartialEq, Eq)]
struct RawWorktree {
    path: String,
    head: String,
    branch: Option<String>,
    bare: bool,
}

/// `git worktree list --porcelain`: blank-line separated blocks of
/// `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` or `detached`,
/// and flags such as `bare`, `locked` and `prunable`.
fn parse_worktrees(out: &str) -> Vec<RawWorktree> {
    let mut list = Vec::new();
    let mut current: Option<RawWorktree> = None;
    for line in out.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            list.extend(current.take());
            current = Some(RawWorktree {
                path: path.to_string(),
                ..RawWorktree::default()
            });
            continue;
        }
        let Some(w) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            w.head = head.to_string();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            let short = branch.strip_prefix("refs/heads/").unwrap_or(branch);
            w.branch = Some(short.to_string());
        } else if line == "bare" {
            w.bare = true;
        }
    }
    list.extend(current);
    list
}

/// `root` and `components` (canonical) as they are in `worktree`, a path
/// [`worktrees`] returned for the project root's repo, so the webview can only
/// pick the repo's own worktrees. Components outside that repo, or whose
/// folder doesn't exist in the worktree, are left out. `None`, or the current
/// worktree, returns them unchanged. Worktrees share the repo's config, so
/// running git there trusts no more than the open project already does.
///
/// # Errors
/// Fails if `worktree` isn't one of the repo's worktrees, or the project
/// folder doesn't exist in it.
pub fn in_worktree(
    root: &Path,
    components: Vec<(String, PathBuf)>,
    worktree: Option<&str>,
) -> Result<(PathBuf, Vec<(String, PathBuf)>)> {
    let Some(worktree) = worktree else {
        return Ok((root.to_path_buf(), components));
    };
    let repo = nearest_repo(root).ok_or_else(|| anyhow!("The project isn't in a git repo"))?;
    let target = worktrees(root)
        .into_iter()
        .find(|w| w.path == worktree)
        .map(|w| PathBuf::from(w.path))
        .ok_or_else(|| anyhow!("{worktree} isn't a worktree of this repo"))?;
    if target == repo {
        return Ok((root.to_path_buf(), components));
    }
    let mapped = |dir: &Path| -> Option<PathBuf> {
        let rel = dir.strip_prefix(&repo).ok()?;
        let dir = target.join(rel).canonicalize().ok()?;
        (dir.starts_with(&target) && dir.is_dir()).then_some(dir)
    };
    let new_root =
        mapped(root).ok_or_else(|| anyhow!("The project folder isn't in that worktree"))?;
    let components = components
        .into_iter()
        .filter(|(_, dir)| nearest_repo(dir).as_ref() == Some(&repo))
        .filter_map(|(id, dir)| Some((id, mapped(&dir)?)))
        .collect();
    Ok((new_root, components))
}

/// `HEAD`, or the empty tree in a repo without commits.
fn base_tree(repo: &Path) -> Result<String> {
    if git(repo)
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .stdout(Stdio::null())
        .status()?
        .success()
    {
        return Ok("HEAD".into());
    }
    // Hashing an empty tree works for SHA-1 and SHA-256 repos alike.
    let out = git(repo)
        .args(["hash-object", "-t", "tree", "--stdin"])
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        bail!("git hash-object failed");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run git in `repo`, keeping at most [`MAX_DIFF_BYTES`] of its output.
fn run_capped(repo: &Path, args: &[String], ok: &[i32]) -> Result<FileDiff> {
    let mut child = git(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("git diff has no output"))?
        .take(MAX_DIFF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_DIFF_BYTES;
    if truncated {
        bytes.truncate(MAX_DIFF_BYTES);
        let _ = child.kill();
    }
    let status = child.wait()?;
    if !truncated && !status.code().is_some_and(|c| ok.contains(&c)) {
        bail!("git diff failed ({status})");
    }
    let patch = String::from_utf8_lossy(&bytes).into_owned();
    let binary = patch
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    Ok(FileDiff {
        patch,
        binary,
        truncated,
    })
}

/// `git -C repo` with fsmonitor off, so refreshes and review never start a
/// hook or daemon, and without optional locks, so they never rewrite the
/// index (which would wake the watcher again). Pathspecs are literal, so
/// folder and file names like `[id]` match only themselves.
fn git(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args([
        "-c",
        "core.fsmonitor=false",
        "--no-optional-locks",
        "--literal-pathspecs",
    ]);
    cmd
}

/// Paths with uncommitted changes, relative to `repo`.
#[cfg(test)]
fn changed_paths(repo: &Path) -> Option<Vec<String>> {
    Some(
        changed_entries(repo, &[])?
            .into_iter()
            .map(|e| e.path)
            .collect(),
    )
}

/// Uncommitted changes, relative to `repo`, limited to `pathspecs` (none for
/// the whole repo). Nested repos and submodules are skipped: they are counted
/// as their own repo. Like `git status` in a terminal this still honours the
/// repo's own config (filters, for one), so callers must pass only folders
/// the user opened or allowed.
fn changed_entries(repo: &Path, pathspecs: &[String]) -> Option<Vec<Entry>> {
    let output = git(repo)
        .args([
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--",
        ])
        .args(pathspecs)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_porcelain_v2(
        &String::from_utf8_lossy(&output.stdout),
        |dir| repo.join(dir).join(".git").exists(),
    ))
}

/// How a tracked entry's `XY` field compares to `HEAD`.
fn kind_of(xy: &str) -> ChangeKind {
    let mut letters = xy.chars();
    let (x, y) = (letters.next(), letters.next());
    match (x, y) {
        (_, Some('D')) | (Some('D'), _) => ChangeKind::Deleted,
        // `.A` is an intent-to-add file (`git add -N`), also absent from HEAD.
        (Some('A' | 'C'), _) | (_, Some('A')) => ChangeKind::Added,
        (Some('R'), _) => ChangeKind::Renamed,
        (Some('T'), _) | (_, Some('T')) => ChangeKind::TypeChanged,
        _ => ChangeKind::Modified,
    }
}

/// Changes from `git status --porcelain=v2 -z` output. Submodules are
/// dropped, as are untracked folders (`dir/`, how git lists a nested repo) for
/// which `is_repo` holds; only those few entries cost a filesystem check.
/// A path is listed once: after `git rm --cached` git reports it both as a
/// staged deletion and as untracked, and the deletion (listed first) is what
/// a diff against `HEAD` shows.
fn parse_porcelain_v2(out: &str, is_repo: impl Fn(&str) -> bool) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut seen = HashSet::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        // Tracked entries: "<kind> <XY> <sub> ..." with the path as the last field.
        let (fields, original) = match record.as_bytes().first() {
            // A rename or copy is followed by its original path.
            Some(b'1') => (9, None),
            Some(b'2') => (10, records.next()),
            Some(b'u') => (11, None),
            Some(b'?') => {
                let path = &record[2..];
                match path.strip_suffix('/') {
                    Some(dir) if is_repo(dir) => {}
                    _ if !seen.insert(path) => {}
                    _ => entries.push(Entry {
                        path: path.to_string(),
                        kind: ChangeKind::Untracked,
                        old_path: None,
                    }),
                }
                continue;
            }
            _ => continue,
        };
        let parts: Vec<&str> = record.splitn(fields, ' ').collect();
        if parts.len() != fields || parts[2].starts_with('S') {
            continue;
        }
        // Staged, then deleted from the working tree: compared with `HEAD`, an
        // added or copied path never existed, and a renamed one is just the
        // deletion of its original path.
        let (path, original) = match parts[1].as_bytes() {
            [b'A' | b'C', b'D'] if fields != 11 => continue,
            [b'R', b'D'] if fields != 11 => match original {
                Some(old) => (old, None),
                None => continue,
            },
            _ => (parts[fields - 1], original),
        };
        if !seen.insert(path) {
            continue;
        }
        let kind = if fields == 11 {
            ChangeKind::Conflicted
        } else {
            kind_of(parts[1])
        };
        entries.push(Entry {
            path: path.to_string(),
            kind,
            old_path: original
                .filter(|_| kind == ChangeKind::Renamed)
                .map(str::to_string),
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::normalize;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::{env, fs, process};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = env::temp_dir().join(format!(
                "patchbay-git-{}-{}",
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

        /// `git init` with one committed file; false if git is unavailable.
        fn repo(&self, rel: &str) -> bool {
            let dir = self.0.join(rel);
            fs::create_dir_all(&dir).unwrap();
            self.write(&format!("{rel}/README"), "hi");
            let git = |args: &[&str]| {
                Command::new("git")
                    .arg("-C")
                    .arg(&dir)
                    .args([
                        "-c",
                        "user.name=t",
                        "-c",
                        "user.email=t@t",
                        "-c",
                        "commit.gpgsign=false",
                    ])
                    .args(args)
                    .output()
                    .is_ok_and(|o| o.status.success())
            };
            git(&["init", "-q"]) && git(&["add", "."]) && git(&["commit", "-qm", "init"])
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// [`diff`] of a listed file in the open worktree.
    fn d(root: &Path, c: &[(String, PathBuf)], id: &str, path: &str) -> Result<FileDiff> {
        renamed_diff(root, c, id, path, None)
    }

    fn renamed_diff(
        root: &Path,
        c: &[(String, PathBuf)],
        id: &str,
        path: &str,
        old_path: Option<&str>,
    ) -> Result<FileDiff> {
        let target = DiffTarget {
            component_id: id,
            path,
            old_path,
        };
        diff(root, c.to_vec(), None, target)
    }

    fn components(root: &Path, components: &[(&str, &str)]) -> Vec<(String, PathBuf)> {
        components
            .iter()
            .map(|(id, path)| ((*id).to_string(), normalize(&root.join(path))))
            .collect()
    }

    #[test]
    fn status_does_not_rewrite_the_index_to_refresh_file_stats() {
        let f = Fixture::new();
        if !f.repo("repo") {
            return;
        }
        let repo = f.0.join("repo");
        let index = repo.join(".git/index");
        let before = fs::read(&index).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        // Same content, changed stat: an ordinary status may update the index.
        f.write("repo/README", "hi");
        assert!(changed_paths(&repo).unwrap().is_empty());
        assert_eq!(fs::read(index).unwrap(), before);
    }

    #[test]
    fn owner_prefers_the_most_specific_folder() {
        let members = vec![
            ("root".to_string(), String::new()),
            ("web".to_string(), "apps/web/".to_string()),
        ];
        assert_eq!(owner_of("apps/web/src/a.ts", &members), Some("web"));
        assert_eq!(owner_of("apps/webby/a.ts", &members), Some("root"));
        assert_eq!(owner_of("README", &members), Some("root"));
    }

    #[test]
    fn counts_each_repo_under_a_plain_parent_folder() {
        let f = Fixture::new();
        if !(f.repo("web") && f.repo("api")) {
            return;
        }
        f.write("web/src/a.ts", "");
        f.write("api/x.py", "");
        f.write("api/y.py", "");
        let c = components(&f.0, &[("web", "web"), ("api", "api"), ("loose", "notes")]);
        fs::create_dir_all(f.0.join("notes")).unwrap();
        let s = status(&f.0, &c);
        assert_eq!(s.changes.get("web"), Some(&1));
        assert_eq!(s.changes.get("api"), Some(&2));
        assert_eq!(s.changes.get("loose"), None);
        assert_eq!(s.repos.get("web").map(String::as_str), Some("web"));
    }

    #[test]
    fn nested_repo_is_not_an_untracked_file_of_its_parent() {
        let f = Fixture::new();
        if !(f.repo(".") && f.repo("vendor/lib")) {
            return;
        }
        f.write("vendor/lib/changed.rs", "");
        let c = components(&f.0, &[("root", "."), ("lib", "vendor/lib")]);
        let s = status(&f.0, &c);
        assert_eq!(s.changes.get("root"), Some(&0));
        assert_eq!(s.changes.get("lib"), Some(&1));
        assert_eq!(s.repos.get("root"), None);
        assert_eq!(s.repos.get("lib").map(String::as_str), Some("lib"));
    }

    #[test]
    fn sibling_repo_outside_the_root_is_included() {
        let f = Fixture::new();
        if !(f.repo("shop") && f.repo("billing")) {
            return;
        }
        f.write("billing/src/pay.go", "");
        let root = f.0.join("shop");
        let c = components(&root, &[("shop", "."), ("billing", "../billing")]);
        let groups = group_by_repo(&c);
        assert_eq!(groups.len(), 2);
        assert_eq!(status(&root, &c).changes.get("billing"), Some(&1));
    }

    #[test]
    fn parses_porcelain_v2() {
        let out = [
            "1 .M N... 100644 100644 100644 abc abc src/a b.rs",
            "1 .M SC.. 160000 160000 160000 abc abc vendor/sub",
            "2 R. N... 100644 100644 100644 abc abc R100 new.rs",
            "old.rs",
            "u UU N... 100644 100644 100644 100644 a b c both.rs",
            "? notes.txt",
            "? vendor/lib/",
            "? build/",
            "",
        ]
        .join("\0");
        let entries = parse_porcelain_v2(&out, |dir| dir == "vendor/lib");
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            ["src/a b.rs", "new.rs", "both.rs", "notes.txt", "build/"]
        );
        let kinds: Vec<ChangeKind> = entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            [
                ChangeKind::Modified,
                ChangeKind::Renamed,
                ChangeKind::Conflicted,
                ChangeKind::Untracked,
                ChangeKind::Untracked,
            ]
        );
        assert_eq!(entries[1].old_path.as_deref(), Some("old.rs"));
        assert_eq!(entries[0].old_path, None);
    }

    #[test]
    fn kinds_compare_against_head() {
        assert_eq!(kind_of(".M"), ChangeKind::Modified);
        assert_eq!(kind_of("M."), ChangeKind::Modified);
        assert_eq!(kind_of("A."), ChangeKind::Added);
        assert_eq!(kind_of("AM"), ChangeKind::Added);
        assert_eq!(kind_of(".D"), ChangeKind::Deleted);
        assert_eq!(kind_of("D."), ChangeKind::Deleted);
        assert_eq!(kind_of("R."), ChangeKind::Renamed);
        assert_eq!(kind_of(".T"), ChangeKind::TypeChanged);
        assert_eq!(kind_of(".A"), ChangeKind::Added);
    }

    #[test]
    fn staged_then_deleted_files_compare_against_head() {
        let out = [
            "2 RD N... 100644 100644 000000 abc abc R100 new.rs",
            "old.rs",
            "1 AD N... 000000 100644 000000 000 def added.rs",
            "2 CD N... 100644 100644 000000 abc abc C100 copy.rs",
            "src.rs",
            "",
        ]
        .join("\0");
        let entries = parse_porcelain_v2(&out, |_| false);
        assert_eq!(
            entries,
            [Entry {
                path: "old.rs".to_string(),
                kind: ChangeKind::Deleted,
                old_path: None,
            }]
        );
    }

    #[test]
    fn a_path_both_deleted_and_untracked_is_listed_once() {
        let out = "1 D. N... 100644 000000 000000 abc 000 .env\0? .env\0";
        let entries = parse_porcelain_v2(out, |_| false);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, ChangeKind::Deleted);

        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        assert!(run_git(&f.0, &["rm", "-q", "--cached", "README"]));
        let c = components(&f.0, &[("root", ".")]);
        let all = changes(&f.0, &c);
        assert_eq!(all["root"].len(), 1);
        assert_eq!(all["root"][0].kind, ChangeKind::Deleted);
        assert!(d(&f.0, &c, "root", "README").unwrap().patch.contains("-hi"));
    }

    #[test]
    fn project_scope_inside_a_larger_repo_only_queries_the_project_folder() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("elsewhere/big.txt", "x");
        f.write("code/parent/notes.md", "n");
        f.write("code/parent/[id]/page.tsx", "p");
        let root = f.0.join("code/parent");
        let all = changes(&root, &[]);
        let paths: Vec<&str> = all[PROJECT_SCOPE].iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["[id]/page.tsx", "notes.md"]);
        assert!(!all.contains_key("elsewhere"));
        assert!(d(&root, &[], PROJECT_SCOPE, "[id]/page.tsx").is_ok());
        assert!(d(&root, &[], PROJECT_SCOPE, "../../elsewhere/big.txt").is_err());
    }

    #[test]
    fn component_changes_only_lists_that_component() {
        let f = Fixture::new();
        if !(f.repo("web") && f.repo("api")) {
            return;
        }
        f.write("web/a.ts", "x");
        f.write("api/b.py", "y");
        let c = components(&f.0, &[("web", "web"), ("api", "api")]);
        let web = component_changes(&f.0, &c, "web");
        assert_eq!(web.len(), 1);
        assert_eq!(web[0].path, "web/a.ts");
        assert!(component_changes(&f.0, &c, "missing").is_empty());
    }

    #[test]
    fn untracked_line_counts_follow_edits() {
        let f = Fixture::new();
        f.write("a.txt", "one\n");
        let path = f.0.join("a.txt");
        assert_eq!(cached_line_count(&path), Some(1));
        f.write("a.txt", "one\ntwo\nthree\n");
        assert_eq!(cached_line_count(&path), Some(3));
    }

    /// Run git in `dir` with a throwaway identity; false if it failed.
    fn run_git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn changes_list_files_per_component_with_project_paths() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("README", "changed");
        f.write("apps/web/new.ts", "x");
        let c = components(&f.0, &[("root", "."), ("web", "apps/web")]);
        let all = changes(&f.0, &c);
        let root: Vec<_> = all["root"]
            .iter()
            .map(|c| (c.path.as_str(), c.kind))
            .collect();
        assert_eq!(root, [("README", ChangeKind::Modified)]);
        let web = &all["web"];
        assert_eq!(web.len(), 1);
        assert_eq!(web[0].path, "apps/web/new.ts");
        assert_eq!(web[0].kind, ChangeKind::Untracked);
        assert!(web[0].modified_ms.is_some());
    }

    #[test]
    fn changes_use_paths_relative_to_the_project_for_sibling_repos() {
        let f = Fixture::new();
        if !(f.repo("shop") && f.repo("billing")) {
            return;
        }
        fs::remove_file(f.0.join("billing/README")).unwrap();
        let root = f.0.join("shop");
        let c = components(&root, &[("shop", "."), ("billing", "../billing")]);
        let all = changes(&root, &c);
        assert!(all["shop"].is_empty());
        assert_eq!(all["billing"][0].path, "../billing/README");
        assert_eq!(all["billing"][0].kind, ChangeKind::Deleted);
        assert_eq!(all["billing"][0].modified_ms, None);
    }

    #[test]
    fn diffs_modified_untracked_and_renamed_files() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("README", "bye");
        f.write("new.txt", "fresh\n");
        let c = components(&f.0, &[("root", ".")]);
        let modified = d(&f.0, &c, "root", "README").unwrap();
        assert!(modified.patch.contains("-hi"), "{}", modified.patch);
        assert!(modified.patch.contains("+bye"), "{}", modified.patch);
        assert!(!modified.binary && !modified.truncated);
        let added = d(&f.0, &c, "root", "new.txt").unwrap();
        assert!(added.patch.contains("+fresh"), "{}", added.patch);

        f.write("README", "hi");
        assert!(run_git(&f.0, &["mv", "README", "README.md"]));
        let renamed = &changes(&f.0, &c)["root"];
        assert_eq!(renamed[0].kind, ChangeKind::Renamed);
        assert_eq!(renamed[0].old_path.as_deref(), Some("README"));
        let patch = renamed_diff(&f.0, &c, "root", "README.md", Some("README"))
            .unwrap()
            .patch;
        assert!(patch.contains("rename from README"), "{patch}");
    }

    #[test]
    fn diff_rejects_paths_that_are_not_listed_changes() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("apps/web/a.ts", "x");
        let c = components(&f.0, &[("root", "."), ("web", "apps/web")]);
        assert!(d(&f.0, &c, "root", "README").is_err());
        assert!(d(&f.0, &c, "root", "/etc/passwd").is_err());
        // Listed, but owned by the nested component.
        assert!(d(&f.0, &c, "root", "apps/web/a.ts").is_err());
        assert!(d(&f.0, &c, "web", "apps/web/a.ts").is_ok());
    }

    #[test]
    fn diff_works_before_the_first_commit_and_flags_binaries() {
        let f = Fixture::new();
        if !run_git(&f.0, &["init", "-q"]) {
            return;
        }
        f.write("a.txt", "one\n");
        fs::write(f.0.join("blob.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
        assert!(run_git(&f.0, &["add", "."]));
        let c = components(&f.0, &[("root", ".")]);
        let text = d(&f.0, &c, "root", "a.txt").unwrap();
        assert!(text.patch.contains("+one"), "{}", text.patch);
        assert!(d(&f.0, &c, "root", "blob.bin").unwrap().binary);
    }

    #[test]
    fn review_flags_components_that_depend_on_changes() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("lib/x.rs", "");
        fs::create_dir_all(f.0.join("app")).unwrap();
        let project: Project = serde_json::from_value(serde_json::json!({
            "name": "p",
            "root": f.0.display().to_string(),
            "components": [
                { "id": "lib", "name": "lib", "path": "lib" },
                { "id": "app", "name": "app", "path": "app" },
            ],
            "links": [{ "id": "l", "source": "app", "target": "lib" }],
        }))
        .unwrap();
        let c = components(&f.0, &[("lib", "lib"), ("app", "app")]);
        let r = review(&project, c.clone(), None).unwrap();
        assert_eq!(r.changes["lib"].len(), 1);
        assert!(r.changes["app"].is_empty());
        assert_eq!(
            r.affected,
            [Affected {
                id: "app".into(),
                via: vec!["lib".into()]
            }]
        );
    }

    #[test]
    fn large_diffs_are_truncated() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("big.txt", &"line of text\n".repeat(MAX_DIFF_BYTES / 8));
        let c = components(&f.0, &[("root", ".")]);
        let big = d(&f.0, &c, "root", "big.txt").unwrap();
        assert!(big.truncated);
        assert_eq!(big.patch.len(), MAX_DIFF_BYTES);
    }

    #[test]
    fn files_no_component_contains_belong_to_the_project_scope() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("README", "one\ntwo\n");
        f.write("apps/web/new.ts", "a\nb\nc");
        let c = components(&f.0, &[("web", "apps/web")]);
        let all = changes(&f.0, &c);
        let project = &all[PROJECT_SCOPE];
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].path, "README");
        assert_eq!((project[0].added, project[0].removed), (Some(2), Some(1)));
        let web = &all["web"];
        assert_eq!((web[0].added, web[0].removed), (Some(3), Some(0)));
        assert_eq!(status(&f.0, &c).changes.get(PROJECT_SCOPE), Some(&1));
        assert!(
            d(&f.0, &c, PROJECT_SCOPE, "README")
                .unwrap()
                .patch
                .contains("+two")
        );
        assert!(d(&f.0, &c, PROJECT_SCOPE, "apps/web/new.ts").is_err());

        let project = Project {
            schema_version: crate::model::SCHEMA_VERSION,
            name: "p".into(),
            root: f.0.to_string_lossy().into_owned(),
            components: Vec::new(),
            links: Vec::new(),
            groups: vec![],
        };
        assert!(
            review(&project, c.clone(), None)
                .unwrap()
                .affected
                .is_empty()
        );
    }

    #[test]
    fn a_component_at_the_root_keeps_root_files() {
        let f = Fixture::new();
        if !f.repo(".") {
            return;
        }
        f.write("README", "changed");
        let c = components(&f.0, &[("root", ".")]);
        let all = changes(&f.0, &c);
        assert!(!all.contains_key(PROJECT_SCOPE));
        assert_eq!(all["root"].len(), 1);
    }

    #[test]
    fn numstat_handles_renames_and_binaries() {
        let counts = parse_numstat("3\t1\ta.txt\0-\t-\tlogo.png\x002\t0\t\0old.rs\0new.rs\0");
        assert_eq!(counts.get("a.txt"), Some(&(3, 1)));
        assert_eq!(counts.get("logo.png"), None);
        assert_eq!(counts.get("new.rs"), Some(&(2, 0)));
        assert_eq!(counts.len(), 2);
    }

    #[test]
    fn parses_worktree_list() {
        let list = parse_worktrees(
            "worktree /r\nHEAD abc\nbranch refs/heads/main\n\n\
             worktree /w\nHEAD def\ndetached\nlocked\n\n\
             worktree /b\nbare\n",
        );
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "/w");
        assert_eq!(list[1].head, "def");
        assert_eq!(list[1].branch, None);
        assert!(list[2].bare);
    }

    #[test]
    fn reviews_changes_in_another_worktree() {
        let f = Fixture::new();
        if !f.repo("main") {
            return;
        }
        let main = f.0.join("main");
        f.write("main/apps/web/a.ts", "x");
        let commit = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&main)
                .args(["-c", "user.name=t", "-c", "user.email=t@t"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .is_ok_and(|o| o.status.success())
        };
        assert!(commit(&["add", "."]) && commit(&["commit", "-qm", "web"]));
        let wt_dir = f.0.join("wt");
        assert!(commit(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            wt_dir.to_str().unwrap()
        ]));
        f.write("wt/apps/web/a.ts", "y\n");
        f.write("wt/notes.md", "n");

        let list = worktrees(&main);
        assert_eq!(list.len(), 2);
        assert!(list[0].main && list[0].current);
        let wt = &list[1];
        assert_eq!(wt.branch.as_deref(), Some("feature"));
        assert!(!wt.main && !wt.current);

        let c = components(&main, &[("web", "apps/web")]);
        // The current worktree is unchanged.
        assert!(changes(&main, &c)["web"].is_empty());
        let (root, mapped) = in_worktree(&main, c.clone(), Some(&wt.path)).unwrap();
        let target = DiffTarget {
            component_id: "web",
            path: "apps/web/a.ts",
            old_path: None,
        };
        let through = diff(&main, c.clone(), Some(&wt.path), target).unwrap();
        assert!(through.patch.contains("+y"), "{}", through.patch);
        assert_eq!(root, wt_dir.canonicalize().unwrap());
        let all = changes(&root, &mapped);
        assert_eq!(all["web"][0].path, "apps/web/a.ts");
        assert_eq!(all[PROJECT_SCOPE][0].path, "notes.md");
        assert!(
            d(&root, &mapped, "web", "apps/web/a.ts")
                .unwrap()
                .patch
                .contains("+y")
        );

        assert!(in_worktree(&main, c.clone(), Some(f.0.to_str().unwrap())).is_err());
        let (same, _) = in_worktree(&main, c, Some(&list[0].path)).unwrap();
        assert_eq!(same, main);
    }
}
