use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Component as PathPart, Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA_VERSION: u32 = 4;
/// Reserved component scope for project-level planner sessions.
pub const PLAN_SCOPE: &str = "@plan";
/// Root implementation sessions have no planner instructions.
pub const TASK_ROOT_SCOPE: &str = "@task";
/// Dedicated local merge agent sessions.
pub const MERGE_SCOPE: &str = "@merge";
/// Reserved scope for whole-branch review agents.
pub const REVIEW_SCOPE: &str = "@review";
/// Reserved component id for changed files under the project root that no
/// component contains (root files like `README.md`), as git reports them.
pub const PROJECT_SCOPE: &str = "@project";
/// Saved at the repo root so the map can be committed alongside the code.
pub const PROJECT_FILE: &str = "patchbay.json";

/// Result of a fingerprint-checked map write.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ProjectSave {
    Saved { path: PathBuf, fingerprint: String },
    Conflict { fingerprint: String },
}

static MAP_WRITING: Mutex<()> = Mutex::new(());

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<ComponentGroup>,
}

/// A reusable environment. Ordering is opt-in and follows links within the group.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentGroup {
    pub id: String,
    pub name: String,
    pub component_ids: Vec<String>,
    #[serde(default)]
    pub ordered_startup: bool,
    #[serde(default = "readiness_timeout")]
    pub readiness_timeout_seconds: u64,
}

fn readiness_timeout() -> u64 {
    30
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalAction {
    Development,
    Validation,
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

/// Origin of a detected structure. Absent records remain unclassified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionProvenance {
    pub detector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection: Option<DetectionProvenance>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<crate::adapters::Adapter>,
    pub id: String,
    pub name: String,
    /// Empty for an interactive shell.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub kind: TerminalKind,
    /// Output text (case-insensitive) that means a service is ready. A local
    /// URL counts only when no explicit text is configured.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ready_when: String,
    /// Task commands included in graph actions; absent means manual only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<TerminalAction>,
}

/// `source` depends on `target`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection: Option<DetectionProvenance>,
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
        // Saving would drop fields this build doesn't know about.
        anyhow::ensure!(
            project.schema_version <= SCHEMA_VERSION,
            "{} was saved by a newer Patchbay (format {}, this build reads up to {SCHEMA_VERSION})",
            file.display(),
            project.schema_version
        );
        project.root = root.canonicalize()?.display().to_string();
        project.validate()?;
        Ok(Some(project))
    }

    /// Check session routing and group membership. Every command that takes
    /// the map runs this, so settings a user may leave half-edited (a graph
    /// action without a command, a timeout) are checked by the action instead.
    ///
    /// # Errors
    /// Fails for reserved or duplicate ids, or invalid group members.
    pub fn validate(&self) -> Result<()> {
        if self.components.iter().any(|c| c.id == TASK_ROOT_SCOPE) {
            anyhow::bail!("Component id {TASK_ROOT_SCOPE} is reserved for task root sessions");
        }
        for scope in [MERGE_SCOPE, REVIEW_SCOPE] {
            if self.components.iter().any(|c| c.id == scope) {
                anyhow::bail!("Component id {scope} is reserved for job agent sessions");
            }
        }
        if self.components.iter().any(|c| c.id == PLAN_SCOPE) {
            anyhow::bail!("Component id {PLAN_SCOPE} is reserved for planner sessions");
        }
        if self.components.iter().any(|c| c.id == PROJECT_SCOPE) {
            anyhow::bail!("Component id {PROJECT_SCOPE} is reserved for project files");
        }
        let mut component_ids = HashSet::new();
        for component in &self.components {
            anyhow::ensure!(
                component_ids.insert(&component.id),
                "Duplicate component id {}",
                component.id
            );
            let mut terminal_ids = HashSet::new();
            for terminal in &component.terminals {
                anyhow::ensure!(
                    terminal_ids.insert(&terminal.id),
                    "Duplicate terminal id {}/{}",
                    component.id,
                    terminal.id
                );
            }
        }
        let mut group_ids = HashSet::new();
        for group in &self.groups {
            anyhow::ensure!(
                !group.id.is_empty() && group_ids.insert(&group.id),
                "Empty or duplicate group id {}",
                group.id
            );
            let mut members = HashSet::new();
            for id in &group.component_ids {
                anyhow::ensure!(
                    self.component(id).is_some(),
                    "Group {} references unknown component {id}",
                    group.id
                );
                anyhow::ensure!(
                    members.insert(id),
                    "Group {} repeats component {id}",
                    group.id
                );
            }
        }
        Ok(())
    }

    pub fn save(&self) -> Result<PathBuf> {
        match self.save_checked(None)? {
            ProjectSave::Saved { path, .. } => Ok(path),
            ProjectSave::Conflict { .. } => unreachable!("unchecked save cannot conflict"),
        }
    }

    /// Save only if the map still matches `expected`; `None` explicitly replaces it.
    /// Writes a complete sibling file before replacing the destination, so readers never
    /// observe a truncated JSON document. Serializes map writers in this process.
    pub fn save_checked(&self, expected: Option<&str>) -> Result<ProjectSave> {
        let _guard = MAP_WRITING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.validate()?;
        let root = Path::new(&self.root);
        if let Some(expected) = expected {
            let fingerprint = crate::workspace::fingerprint(root)?;
            if fingerprint != expected {
                return Ok(ProjectSave::Conflict { fingerprint });
            }
        }
        let file = root.join(PROJECT_FILE);
        let mut text = serde_json::to_string_pretty(&Self {
            schema_version: SCHEMA_VERSION,
            root: String::new(),
            ..self.clone()
        })?;
        text.push('\n');
        let tmp = root.join(format!(".patchbay.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            output.write_all(text.as_bytes())?;
            if let Ok(metadata) = std::fs::metadata(&file) {
                output.set_permissions(metadata.permissions())?;
            }
            output.sync_all()?;
            drop(output);
            std::fs::rename(&tmp, &file)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result?;
        Ok(ProjectSave::Saved {
            path: file,
            fingerprint: crate::workspace::session_id("map", "", &text),
        })
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

/// Separates a task id from the terminal id it runs for. Task ids are ASCII
/// letters and digits, so the last occurrence marks it.
pub const TASK_SEPARATOR: &str = "@task-";

/// The terminal key a run is stored under: the terminal id, plus
/// `@task-{task}` for a task's run, so the same terminal can run in several
/// worktrees at once.
#[must_use]
pub fn task_terminal(terminal_id: &str, task: Option<&str>) -> String {
    match task {
        Some(task) => format!("{terminal_id}{TASK_SEPARATOR}{task}"),
        None => terminal_id.to_string(),
    }
}

/// The opaque session id of a terminal of `project`'s component, run for
/// `task` when given (`workspace::session_id`). Metadata is stored beside it;
/// never parse an id.
#[must_use]
pub fn task_session_id(
    project: &str,
    component_id: &str,
    terminal_id: &str,
    task: Option<&str>,
) -> String {
    crate::workspace::session_id(project, component_id, &task_terminal(terminal_id, task))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_legacy_map_upgrades_schema_and_retains_optional_provenance() {
        let root =
            std::env::temp_dir().join(format!("patchbay-legacy-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let project: Project = serde_json::from_value(serde_json::json!({ "schemaVersion": 3, "name": "Legacy", "root": root.display().to_string(), "components": [{ "id": "legacy", "name": "Legacy", "path": "." }, { "id": "detected", "name": "New", "path": "new", "detection": { "detector": "builtin", "packageIdentity": "npm:new" } }] })).unwrap();
        project.save().unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(PROJECT_FILE)).unwrap()).unwrap();
        assert_eq!(saved["schemaVersion"], SCHEMA_VERSION);
        assert!(saved.get("root").is_none());
        assert_eq!(
            serde_json::to_value(&project).unwrap()["root"],
            project.root
        );
        assert_eq!(
            PathBuf::from(Project::load(&root).unwrap().unwrap().root),
            root.canonicalize().unwrap()
        );
        assert!(saved["components"][0].get("detection").is_none());
        assert_eq!(
            saved["components"][1]["detection"]["packageIdentity"],
            "npm:new"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checked_save_preserves_external_edits_and_returns_the_written_fingerprint() {
        let root = std::env::temp_dir().join(format!("patchbay-save-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut project = linked(&[]);
        project.root = root.display().to_string();
        let ProjectSave::Saved { fingerprint, .. } = project.save_checked(Some("absent")).unwrap()
        else {
            panic!("first creation should save");
        };
        assert_eq!(fingerprint, crate::workspace::fingerprint(&root).unwrap());
        project.name = "edited".into();
        std::fs::write(root.join(PROJECT_FILE), "external edit").unwrap();
        assert!(matches!(
            project.save_checked(Some(&fingerprint)).unwrap(),
            ProjectSave::Conflict { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(root.join(PROJECT_FILE)).unwrap(),
            "external edit"
        );
        assert!(matches!(
            project.save_checked(None).unwrap(),
            ProjectSave::Saved { .. }
        ));
        assert_eq!(Project::load(&root).unwrap().unwrap().name, "edited");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_save_readers_always_observe_complete_json() {
        let root = std::env::temp_dir().join(format!("patchbay-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut project = linked(&[]);
        project.root = root.display().to_string();
        project.save().unwrap();
        let writer = project.clone();
        let thread = std::thread::spawn(move || {
            let mut writer = writer;
            for i in 0..30 {
                writer.name = format!("map-{i}-{}", "x".repeat(10000));
                writer.save().unwrap();
            }
        });
        for _ in 0..200 {
            let text = std::fs::read_to_string(root.join(PROJECT_FILE)).unwrap();
            let _: Project =
                serde_json::from_str(&text).expect("readers must never see partial JSON");
        }
        thread.join().unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_atomic_replace_cleans_up_its_temporary_file() {
        let root =
            std::env::temp_dir().join(format!("patchbay-save-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(PROJECT_FILE)).unwrap();
        let mut project = linked(&[]);
        project.root = root.display().to_string();
        assert!(project.save().is_err());
        assert!(root.join(PROJECT_FILE).is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

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
            detection: None,
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
            groups: vec![],
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
