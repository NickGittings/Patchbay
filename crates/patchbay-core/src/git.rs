//! Git status per component. A project may span several repos (a parent folder
//! of repos, or repos added from elsewhere), so components are grouped by the
//! repo that contains them and each repo is queried once.

use crate::model::{Project, relative_path};
use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    fn into_changed(self, root: &Path, repo: &Path) -> ChangedFile {
        let abs = repo.join(&self.path);
        let modified_ms = (self.kind != ChangeKind::Deleted)
            .then(|| modified_ms(&abs))
            .flatten();
        ChangedFile {
            path: relative_path(root, &abs),
            kind: self.kind,
            old_path: self
                .old_path
                .map(|old| relative_path(root, &repo.join(old))),
            modified_ms,
        }
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = path.symlink_metadata().ok()?.modified().ok()?;
    let since = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// Run `git status` for every group at once (in parallel, so many sibling
/// repos don't add up to one long refresh). `None` where git failed.
fn query_groups(groups: &[RepoGroup]) -> Vec<Option<Vec<Entry>>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = groups
            .iter()
            .map(|g| scope.spawn(|| changed_entries(&g.root)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().ok().flatten())
            .collect()
    })
}

/// Count uncommitted changes per component, running `git status` once per
/// repo. Each changed file is attributed to the most specific component
/// containing it. `components` are `(id, canonical folder)`; `root` is the
/// project root.
#[must_use]
pub fn status(root: &Path, components: &[(String, PathBuf)]) -> GitStatus {
    let project_repo = repo_root(root);
    let groups = group_by_repo(components);
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
/// so the lists match the counts. Components in a repo get a (possibly empty)
/// list sorted by path; the rest are absent.
#[must_use]
pub fn changes(root: &Path, components: &[(String, PathBuf)]) -> HashMap<String, Vec<ChangedFile>> {
    let groups = group_by_repo(components);
    let mut out: HashMap<String, Vec<ChangedFile>> = HashMap::new();
    for (group, entries) in groups.iter().zip(query_groups(&groups)) {
        let Some(entries) = entries else {
            continue;
        };
        for (id, _) in &group.members {
            out.insert(id.clone(), Vec::new());
        }
        for entry in entries {
            if let Some(id) = owner_of(&entry.path, &group.members) {
                let file = entry.into_changed(root, &group.root);
                out.entry(id.to_string()).or_default().push(file);
            }
        }
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
/// user allowed), plus the components of `project` that depend on a changed
/// one. Those can include components not in `components`, since that only
/// reads the map.
#[must_use]
pub fn review(project: &Project, components: &[(String, PathBuf)]) -> Review {
    let changes = changes(Path::new(&project.root), components);
    let mut changed: Vec<String> = changes
        .iter()
        .filter(|(_, files)| !files.is_empty())
        .map(|(id, _)| id.clone())
        .collect();
    changed.sort();
    let affected = project
        .dependents(&changed)
        .into_iter()
        .map(|(id, via)| Affected { id, via })
        .collect();
    Review { changes, affected }
}

/// The diff against `HEAD` of `path` (relative to the project root), which
/// must be one of `component_id`'s [`changes`]: only listed paths are read, so
/// the webview can't use this to read arbitrary files. Untracked files diff as
/// fully added; in a repo without commits everything diffs against the empty
/// tree. External diff drivers and textconv filters are off, since they would
/// run commands a repo's config names.
///
/// # Errors
/// Fails if the component isn't in a repo, `path` isn't one of its changes, or
/// git fails.
pub fn diff(
    root: &Path,
    components: &[(String, PathBuf)],
    component_id: &str,
    path: &str,
) -> Result<FileDiff> {
    let group = group_by_repo(components)
        .into_iter()
        .find(|g| g.members.iter().any(|(id, _)| id == component_id))
        .ok_or_else(|| anyhow!("This component isn't in a git repo"))?;
    let entry = changed_entries(&group.root)
        .ok_or_else(|| anyhow!("git status failed"))?
        .into_iter()
        .filter(|e| owner_of(&e.path, &group.members) == Some(component_id))
        .find(|e| relative_path(root, &group.root.join(&e.path)) == path)
        .ok_or_else(|| anyhow!("{path} has no uncommitted changes"))?;
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
/// index (which would wake the watcher again).
fn git(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .args(["-c", "core.fsmonitor=false", "--no-optional-locks"]);
    cmd
}

/// Paths with uncommitted changes, relative to `repo`.
#[cfg(test)]
fn changed_paths(repo: &Path) -> Option<Vec<String>> {
    Some(changed_entries(repo)?.into_iter().map(|e| e.path).collect())
}

/// Uncommitted changes, relative to `repo`. Nested repos and submodules are
/// skipped: they are counted as their own repo. Like `git status` in a
/// terminal this still honours the repo's own config (filters, for one), so
/// callers must pass only folders the user opened or allowed.
fn changed_entries(repo: &Path) -> Option<Vec<Entry>> {
    let output = git(repo)
        .args(["status", "--porcelain=v2", "-z", "--untracked-files=all"])
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
        (Some('A' | 'C'), _) => ChangeKind::Added,
        (Some('R'), _) => ChangeKind::Renamed,
        (Some('T'), _) | (_, Some('T')) => ChangeKind::TypeChanged,
        _ => ChangeKind::Modified,
    }
}

/// Changes from `git status --porcelain=v2 -z` output. Submodules are
/// dropped, as are untracked folders (`dir/`, how git lists a nested repo) for
/// which `is_repo` holds; only those few entries cost a filesystem check.
fn parse_porcelain_v2(out: &str, is_repo: impl Fn(&str) -> bool) -> Vec<Entry> {
    let mut entries = Vec::new();
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
        let kind = if fields == 11 {
            ChangeKind::Conflicted
        } else {
            kind_of(parts[1])
        };
        entries.push(Entry {
            path: parts[fields - 1].to_string(),
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
        let modified = diff(&f.0, &c, "root", "README").unwrap();
        assert!(modified.patch.contains("-hi"), "{}", modified.patch);
        assert!(modified.patch.contains("+bye"), "{}", modified.patch);
        assert!(!modified.binary && !modified.truncated);
        let added = diff(&f.0, &c, "root", "new.txt").unwrap();
        assert!(added.patch.contains("+fresh"), "{}", added.patch);

        f.write("README", "hi");
        assert!(run_git(&f.0, &["mv", "README", "README.md"]));
        let renamed = &changes(&f.0, &c)["root"];
        assert_eq!(renamed[0].kind, ChangeKind::Renamed);
        assert_eq!(renamed[0].old_path.as_deref(), Some("README"));
        let patch = diff(&f.0, &c, "root", "README.md").unwrap().patch;
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
        assert!(diff(&f.0, &c, "root", "README").is_err());
        assert!(diff(&f.0, &c, "root", "/etc/passwd").is_err());
        // Listed, but owned by the nested component.
        assert!(diff(&f.0, &c, "root", "apps/web/a.ts").is_err());
        assert!(diff(&f.0, &c, "web", "apps/web/a.ts").is_ok());
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
        let text = diff(&f.0, &c, "root", "a.txt").unwrap();
        assert!(text.patch.contains("+one"), "{}", text.patch);
        assert!(diff(&f.0, &c, "root", "blob.bin").unwrap().binary);
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
        let r = review(&project, &c);
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
        let big = diff(&f.0, &c, "root", "big.txt").unwrap();
        assert!(big.truncated);
        assert_eq!(big.patch.len(), MAX_DIFF_BYTES);
    }
}
