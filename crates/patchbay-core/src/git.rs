//! Git status per component. A project may span several repos (a parent folder
//! of repos, or repos added from elsewhere), so components are grouped by the
//! repo that contains them and each repo is queried once.

use crate::model::{Project, relative_path};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The nearest folder at or above `dir` containing `.git` (a directory, or a
/// file for worktrees and submodules). Returns a canonical path.
#[must_use]
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let dir = dir.canonicalize().ok()?;
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

/// Group the project's components by containing repo. Components whose folder
/// is missing or not in a repo are left out.
#[must_use]
pub fn group_by_repo(project: &Project) -> Vec<RepoGroup> {
    let mut groups: BTreeMap<PathBuf, Vec<(String, String)>> = BTreeMap::new();
    for c in &project.components {
        let Ok(dir) = project.component_dir(c).canonicalize() else {
            continue;
        };
        let Some(root) = repo_root(&dir) else {
            continue;
        };
        let rel = relative_path(&root, &dir);
        let prefix = if rel == "." {
            String::new()
        } else {
            format!("{rel}/")
        };
        groups.entry(root).or_default().push((c.id.clone(), prefix));
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
#[must_use]
pub fn status(project: &Project) -> GitStatus {
    let project_repo = repo_root(Path::new(&project.root));
    let groups = group_by_repo(project);
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
/// submodules are skipped: they are counted as their own repo.
fn changed_paths(repo: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                // "XY path" or "XY old -> new"
                let path = line.get(3..)?;
                let path = path.rsplit(" -> ").next().unwrap_or(path).trim_matches('"');
                let nested = repo.join(path.trim_end_matches('/')).join(".git").exists();
                (!nested).then(|| path.to_string())
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Component, ComponentKind, Position, SCHEMA_VERSION};
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

    fn project(root: &Path, components: &[(&str, &str)]) -> Project {
        Project {
            schema_version: SCHEMA_VERSION,
            name: "shop".into(),
            root: root.display().to_string(),
            components: components
                .iter()
                .map(|(id, path)| Component {
                    id: (*id).into(),
                    name: (*id).into(),
                    kind: ComponentKind::Other,
                    path: (*path).into(),
                    notes: String::new(),
                    terminals: vec![],
                    position: Position::default(),
                })
                .collect(),
            links: vec![],
        }
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
        let p = project(&f.0, &[("web", "web"), ("api", "api"), ("loose", "notes")]);
        fs::create_dir_all(f.0.join("notes")).unwrap();
        let s = status(&p);
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
        let p = project(&f.0, &[("root", "."), ("lib", "vendor/lib")]);
        let s = status(&p);
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
        let p = project(
            &f.0.join("shop"),
            &[("shop", "."), ("billing", "../billing")],
        );
        let groups = group_by_repo(&p);
        assert_eq!(groups.len(), 2);
        assert_eq!(status(&p).changes.get("billing"), Some(&1));
    }
}
