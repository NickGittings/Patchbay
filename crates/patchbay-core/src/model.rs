use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component as PathPart, Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 2;
/// Saved at the repo root so the map can be committed alongside the code.
pub const PROJECT_FILE: &str = "patchbay.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub name: String,
    /// Absolute repo root. Not written to disk so the file stays portable.
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

    /// Absolute folder of a component, with `.` and `..` resolved lexically.
    pub fn component_dir(&self, component: &Component) -> PathBuf {
        normalize(&Path::new(&self.root).join(&component.path))
    }

    /// Whether a component's folder lies outside the project root.
    #[must_use]
    pub fn is_external(&self, component: &Component) -> bool {
        !self
            .component_dir(component)
            .starts_with(normalize(Path::new(&self.root)))
    }

    /// Folders of components outside the project root: the project's other
    /// readable roots besides `root` itself.
    #[must_use]
    pub fn external_dirs(&self) -> Vec<PathBuf> {
        self.components
            .iter()
            .filter(|c| self.is_external(c))
            .map(|c| self.component_dir(c))
            .collect()
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
        project.root = root.display().to_string();
        Ok(Some(project))
    }

    pub fn save(&self) -> Result<PathBuf> {
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
        return target.to_string_lossy().replace('\\', "/");
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

/// Session ids identify one terminal of one component.
pub fn session_id(component_id: &str, terminal_id: &str) -> String {
    format!("{component_id}/{terminal_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

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
