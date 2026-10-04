//! Git status per component. A project may span several repos (a parent folder
//! of repos, or repos added from elsewhere), so components are grouped by the
//! repo that contains them and each repo is queried once.

use crate::model::relative_path;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// Count uncommitted changes per component, running `git status` once per repo
/// (in parallel, so many sibling repos don't add up to one long poll). Each
/// changed file is attributed to the most specific component containing it.
/// `components` are `(id, canonical folder)`; `root` is the project root.
#[must_use]
pub fn status(root: &Path, components: &[(String, PathBuf)]) -> GitStatus {
    let project_repo = repo_root(root);
    let groups = group_by_repo(components);
    let changed: Vec<Option<Vec<String>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = groups
            .iter()
            .map(|g| scope.spawn(|| changed_paths(&g.root)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().ok().flatten())
            .collect()
    });
    let mut out = GitStatus::default();
    for (group, paths) in groups.iter().zip(changed) {
        if project_repo.as_ref() != Some(&group.root) {
            let name = group
                .root
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            for (id, _) in &group.members {
                out.repos.insert(id.clone(), name.clone());
            }
        }
        let Some(paths) = paths else {
            continue;
        };
        for (id, _) in &group.members {
            out.changes.insert(id.clone(), 0);
        }
        for path in paths {
            if let Some(id) = owner_of(&path, &group.members) {
                *out.changes.entry(id.to_string()).or_default() += 1;
            }
        }
    }
    out
}

/// Paths with uncommitted changes, relative to `repo`. Nested repos and
/// submodules are skipped: they are counted as their own repo. fsmonitor is
/// off so polling never starts a hook or daemon. Like `git status` in a
/// terminal this still honours the repo's own config (filters, for one), so
/// callers must pass only folders the user opened or allowed.
fn changed_paths(repo: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
        ])
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

/// Changed paths from `git status --porcelain=v2 -z` output. Submodules are
/// dropped, as are untracked folders (`dir/`, how git lists a nested repo) for
/// which `is_repo` holds; only those few entries cost a filesystem check.
fn parse_porcelain_v2(out: &str, is_repo: impl Fn(&str) -> bool) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        // Tracked entries: "<kind> <XY> <sub> ..." with the path as the last field.
        let fields = match record.as_bytes().first() {
            Some(b'1') => 9,
            Some(b'2') => {
                // A rename is followed by its original path; skip it.
                records.next();
                10
            }
            Some(b'u') => 11,
            Some(b'?') => {
                let path = &record[2..];
                match path.strip_suffix('/') {
                    Some(dir) if is_repo(dir) => {}
                    _ => paths.push(path.to_string()),
                }
                continue;
            }
            _ => continue,
        };
        let parts: Vec<&str> = record.splitn(fields, ' ').collect();
        if parts.len() == fields && !parts[2].starts_with('S') {
            paths.push(parts[fields - 1].to_string());
        }
    }
    paths
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
        let paths = parse_porcelain_v2(&out, |dir| dir == "vendor/lib");
        assert_eq!(
            paths,
            ["src/a b.rs", "new.rs", "both.rs", "notes.txt", "build/"]
        );
    }
}
