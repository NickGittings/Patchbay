use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Component as PathPart, Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 2;
/// Reserved component scope for project-level planner sessions.
pub const PLAN_SCOPE: &str = "@plan";
/// Reserved component id for changed files under the project root that no
/// component contains (root files like `README.md`), as git reports them.
pub const PROJECT_SCOPE: &str = "@project";
/// Saved at the repo root so the map can be committed alongside the code.
pub const PROJECT_FILE: &str = "patchbay.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub name: String,
    /// Canonical absolute repo root. Not written to disk so the file stays portable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub root: String,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub links: Vec<Link>,
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    Frontend,
    Backend,
    Service,
    Library,
    Database,
    App,
    #[default]
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ComponentKind,
    /// Folder relative to the project root; "." is the root itself. May start
    /// with `../` for a repo that lives beside the project folder.
    pub path: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub terminals: Vec<TerminalSpec>,
    #[serde(default)]
    pub position: Position,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    /// Interactive login shell.
    #[default]
    Shell,
    /// A command such as a dev server or test run.
    Task,
    /// An AI agent CLI; launched with the component's context.
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpec {
    pub id: String,
    pub name: String,
    /// Empty for an interactive shell.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub kind: TerminalKind,
    /// Output text (case-insensitive) that means a service is ready. A local
    /// URL in the output counts as ready without it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ready_when: String,
}

/// `source` depends on `target`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    DependsOn,
    UsedBy,
}

impl Project {
    pub fn component(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }

    /// Absolute folder of a component, resolved like the OS would (see
    /// [`resolve_dir`]), so terminals, file access and git agree on it.
    pub fn component_dir(&self, component: &Component) -> PathBuf {
        resolve_dir(&Path::new(&self.root).join(&component.path))
    }

    /// Whether a component's folder lies outside the project root.
    #[must_use]
    pub fn is_external(&self, component: &Component) -> bool {
        !self.component_dir(component).starts_with(&self.root)
    }

    /// Folders of components outside the project root: the project's other
    /// readable roots besides `root` itself.
    #[must_use]
    pub fn external_dirs(&self) -> Vec<PathBuf> {
        self.components
            .iter()
            .map(|c| self.component_dir(c))
            .filter(|dir| !dir.starts_with(&self.root))
            .collect()
    }

    /// Components that may be affected by changes to `changed`: everything that
    /// depends on them, directly or through other components (a `Link` means
    /// `source` depends on `target`). Each comes with the changed components
    /// it depends on, sorted; changed components themselves are left out.
    /// Ordered by distance from the nearest change, then by id.
    #[must_use]
    pub fn dependents(&self, changed: &[String]) -> Vec<(String, Vec<String>)> {
        let mut found: BTreeMap<&str, (usize, Vec<String>)> = BTreeMap::new();
        for start in changed {
            let mut seen = HashSet::from([start.as_str()]);
            let mut frontier = vec![start.as_str()];
            let mut depth = 0;
            while !frontier.is_empty() {
                depth += 1;
                let mut next = Vec::new();
                for link in &self.links {
                    if frontier.contains(&link.target.as_str()) && seen.insert(&link.source) {
                        next.push(link.source.as_str());
                    }
                }
                for id in &next {
                    if changed.iter().any(|c| c == id) {
                        continue;
                    }
                    let entry = found.entry(id).or_insert((depth, Vec::new()));
                    entry.0 = entry.0.min(depth);
                    entry.1.push(start.clone());
                }
                frontier = next;
            }
        }
        let mut out: Vec<(usize, String, Vec<String>)> = found
            .into_iter()
            .map(|(id, (depth, mut via))| {
                via.sort();
                via.dedup();
                (depth, id.to_string(), via)
            })
            .collect();
        out.sort();
        out.into_iter().map(|(_, id, via)| (id, via)).collect()
    }

    /// Components linked to `id`, with the direction of the relationship.
    pub fn neighbours(&self, id: &str) -> Vec<(&Component, Relation)> {
        self.links
            .iter()
            .filter_map(|l| {
                if l.source == id {
                    self.component(&l.target).map(|c| (c, Relation::DependsOn))
                } else if l.target == id {
                    self.component(&l.source).map(|c| (c, Relation::UsedBy))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Load `patchbay.json` from `root`, if present.
    pub fn load(root: &Path) -> Result<Option<Self>> {
        let file = root.join(PROJECT_FILE);
        if !file.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&file)?;
        let mut project: Self =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", file.display()))?;
        project.root = root.canonicalize()?.display().to_string();
        project.validate()?;
        Ok(Some(project))
    }

    /// Check invariants required by component and planner session routing.
    ///
    /// # Errors
    /// Fails if a component uses a reserved id.
    pub fn validate(&self) -> Result<()> {
        if self.components.iter().any(|c| c.id == PLAN_SCOPE) {
            anyhow::bail!("Component id {PLAN_SCOPE} is reserved for planner sessions");
        }
        if self.components.iter().any(|c| c.id == PROJECT_SCOPE) {
            anyhow::bail!("Component id {PROJECT_SCOPE} is reserved for project files");
        }
        Ok(())
    }

    pub fn save(&self) -> Result<PathBuf> {
        self.validate()?;
        let file = Path::new(&self.root).join(PROJECT_FILE);
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        std::fs::write(&file, text)?;
        Ok(file)
    }
}

/// Resolve `.` and `..` without touching the filesystem. Leading `..` of a
/// relative path are kept, `..` above a filesystem root is dropped, and an
/// empty result is `.`.
#[must_use]
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            PathPart::CurDir => {}
            PathPart::ParentDir => match out.components().next_back() {
                Some(PathPart::Normal(_)) => {
                    out.pop();
                }
                Some(PathPart::RootDir | PathPart::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    out
}

/// `path` with symlinks resolved when it exists (as the OS resolves it: `..`
/// after a symlink leaves the link's target), otherwise with `.` and `..`
/// resolved lexically.
#[must_use]
pub fn resolve_dir(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| normalize(path))
}

/// Check that `dir` can hold a component of the project at `root`: it must not
/// contain the project (`..`, `/`, a parent folder), which would make the
/// whole enclosing tree readable. Both paths should be canonical.
///
/// # Errors
/// Fails if `dir` is a strict ancestor of `root`.
pub fn check_component_dir(root: &Path, dir: &Path) -> Result<()> {
    if dir != root && root.starts_with(dir) {
        anyhow::bail!("That folder contains the project; pick a folder inside or beside it");
    }
    Ok(())
}

/// `target` relative to `base` with `/` separators, e.g. `../billing/api`.
/// Both should be absolute. Falls back to `target` itself when they share no
/// root (different Windows drives).
#[must_use]
pub fn relative_path(base: &Path, target: &Path) -> String {
    let base: Vec<_> = normalize(base)
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    let target_parts: Vec<_> = normalize(target)
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    let common = base
        .iter()
        .zip(&target_parts)
        .take_while(|(a, b)| a == b)
        .count();
    if common == 0 {
        return plain_path(&target.to_string_lossy());
    }
    let parts: Vec<String> = std::iter::repeat_n("..".to_string(), base.len() - common)
        .chain(
            target_parts[common..]
                .iter()
                .map(|p| p.to_string_lossy().into_owned()),
        )
        .collect();
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

/// A path for display and storage with `/` separators, dropping the Windows
/// verbatim prefix that `canonicalize` adds: `\\?\D:\x` becomes `D:/x` and
/// `\\?\UNC\host\share` becomes `//host/share`, which Windows parses again.
fn plain_path(path: &str) -> String {
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    };
    path.replace('\\', "/")
}

/// Session ids identify one terminal of one component.
pub fn session_id(component_id: &str, terminal_id: &str) -> String {
    format!("{component_id}/{terminal_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project whose links are `(source, target)`: source depends on target.
    fn linked(links: &[(&str, &str)]) -> Project {
        let links: Vec<_> = links
            .iter()
            .map(|(s, t)| serde_json::json!({ "id": format!("{s}-{t}"), "source": s, "target": t }))
            .collect();
        serde_json::from_value(serde_json::json!({ "name": "p", "links": links })).unwrap()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn dependents_follow_used_by_links_transitively() {
        // web -> api -> core, cli -> core
        let p = linked(&[("web", "api"), ("api", "core"), ("cli", "core")]);
        assert_eq!(
            p.dependents(&ids(&["core"])),
            [
                ("api".to_string(), ids(&["core"])),
                ("cli".to_string(), ids(&["core"])),
                ("web".to_string(), ids(&["core"])),
            ]
        );
        assert!(p.dependents(&ids(&["web"])).is_empty());
    }

    #[test]
    fn dependents_leave_out_changed_components_and_merge_paths() {
        // Diamond: app -> a -> lib, app -> b -> lib.
        let p = linked(&[("app", "a"), ("app", "b"), ("a", "lib"), ("b", "lib")]);
        assert_eq!(
            p.dependents(&ids(&["lib", "a"])),
            [
                ("app".to_string(), ids(&["a", "lib"])),
                ("b".to_string(), ids(&["lib"])),
            ]
        );
    }

    #[test]
    fn dependents_survive_cycles() {
        let p = linked(&[("a", "b"), ("b", "a"), ("c", "a")]);
        assert_eq!(
            p.dependents(&ids(&["a"])),
            [
                ("b".to_string(), ids(&["a"])),
                ("c".to_string(), ids(&["a"])),
            ]
        );
    }

    #[test]
    fn normalizes_dots() {
        assert_eq!(
            normalize(Path::new("/code/shop/./web/../../billing")),
            PathBuf::from("/code/billing")
        );
        assert_eq!(
            normalize(Path::new("../../billing")),
            PathBuf::from("../../billing")
        );
        assert_eq!(normalize(Path::new("a/../../b")), PathBuf::from("../b"));
        assert_eq!(normalize(Path::new("./.")), PathBuf::from("."));
        assert_eq!(normalize(Path::new("/a/../../x")), PathBuf::from("/x"));
    }

    #[test]
    fn plain_paths_drop_the_verbatim_prefix() {
        assert_eq!(plain_path(r"\\?\D:\billing\api"), "D:/billing/api");
        assert_eq!(plain_path(r"\\?\UNC\host\share\x"), "//host/share/x");
        assert_eq!(plain_path("/elsewhere"), "/elsewhere");
    }

    #[test]
    fn component_dir_must_not_contain_the_project() {
        let root = Path::new("/code/shop");
        assert!(check_component_dir(root, Path::new("/code/shop")).is_ok());
        assert!(check_component_dir(root, Path::new("/code/shop/web")).is_ok());
        assert!(check_component_dir(root, Path::new("/code/billing")).is_ok());
        assert!(check_component_dir(root, Path::new("/code")).is_err());
        assert!(check_component_dir(root, Path::new("/")).is_err());
    }

    #[test]
    fn relative_paths_between_siblings_and_children() {
        let root = Path::new("/code/shop");
        assert_eq!(relative_path(root, Path::new("/code/shop")), ".");
        assert_eq!(
            relative_path(root, Path::new("/code/shop/apps/web")),
            "apps/web"
        );
        assert_eq!(
            relative_path(root, Path::new("/code/billing/api")),
            "../billing/api"
        );
        assert_eq!(
            relative_path(root, Path::new("/elsewhere")),
            "../../elsewhere"
        );
    }

    #[test]
    fn external_components_resolve_outside_the_root() {
        let component = |path: &str| Component {
            id: "c".into(),
            name: "C".into(),
            kind: ComponentKind::Other,
            path: path.into(),
            notes: String::new(),
            terminals: vec![],
            position: Position::default(),
        };
        let project = Project {
            schema_version: SCHEMA_VERSION,
            name: "shop".into(),
            root: "/code/shop".into(),
            components: vec![],
            links: vec![],
        };
        let billing = component("../billing");
        assert_eq!(
            project.component_dir(&billing),
            PathBuf::from("/code/billing")
        );
        assert!(project.is_external(&billing));
        assert!(!project.is_external(&component("apps/web")));
        assert!(!project.is_external(&component(".")));
    }
}
