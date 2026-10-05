//! Suggest a component map from a repository's structure.
//!
//! Every folder with a recognised manifest (`package.json`, `Cargo.toml`,
//! `pyproject.toml`, `requirements.txt`, `go.mod`) becomes a component, as does
//! any nested git repo without one. Dependencies between detected packages
//! become links.

use crate::extensions::DetectorContribution;
use crate::model::{
    Component, ComponentKind, Link, Position, Project, SCHEMA_VERSION, TerminalKind, TerminalSpec,
    check_component_dir, normalize, relative_path, resolve_dir,
};
use anyhow::{Result, bail};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 4;
pub(crate) const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    "__pycache__",
    "coverage",
    "gen",
];
const COLUMN_WIDTH: f64 = 340.0;
const ROW_HEIGHT: f64 = 230.0;

struct Candidate {
    rel: String,
    name: String,
    kind: ComponentKind,
    tasks: Vec<TerminalSpec>,
    deps: HashSet<String>,
}

fn task(id: &str, name: &str, command: String) -> TerminalSpec {
    TerminalSpec {
        adapter: None,
        id: id.into(),
        name: name.into(),
        command,
        kind: TerminalKind::Task,
        ready_when: String::new(),
        action: None,
    }
}

fn default_terminals() -> Vec<TerminalSpec> {
    vec![
        TerminalSpec {
            adapter: None,
            id: "shell".into(),
            name: "Shell".into(),
            command: String::new(),
            kind: TerminalKind::Shell,
            ready_when: String::new(),
            action: None,
        },
        TerminalSpec {
            adapter: None,
            id: "claude".into(),
            name: "Claude".into(),
            command: "claude".into(),
            kind: TerminalKind::Agent,
            ready_when: String::new(),
            action: None,
        },
    ]
}

fn any_dep(deps: &HashSet<String>, names: &[&str]) -> bool {
    names.iter().any(|n| deps.contains(*n))
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map_or_else(|| "project".into(), |n| n.to_string_lossy().into_owned())
}

/// Nearest lockfile between `dir` and `root` decides the package manager.
fn package_manager(dir: &Path, root: &Path) -> &'static str {
    let mut current = Some(dir);
    while let Some(d) = current {
        if d.join("pnpm-lock.yaml").exists() {
            return "pnpm";
        }
        if d.join("yarn.lock").exists() {
            return "yarn";
        }
        if d.join("bun.lockb").exists() || d.join("bun.lock").exists() {
            return "bun";
        }
        if d.join("package-lock.json").exists() || d == root {
            break;
        }
        current = d.parent();
    }
    "npm"
}

/// Returns `None` for workspace roots that only group other packages.
fn from_package_json(dir: &Path, root: &Path, text: &str) -> Option<Candidate> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let scripts: HashSet<String> = v["scripts"]
        .as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    if v.get("workspaces").is_some() && !scripts.contains("dev") && !scripts.contains("start") {
        return None;
    }
    let deps: HashSet<String> = ["dependencies", "devDependencies", "peerDependencies"]
        .iter()
        .filter_map(|k| v[*k].as_object())
        .flat_map(|o| o.keys().cloned())
        .collect();

    let kind = if any_dep(
        &deps,
        &[
            "express",
            "fastify",
            "koa",
            "@nestjs/core",
            "hono",
            "@hapi/hapi",
        ],
    ) {
        ComponentKind::Backend
    } else if any_dep(
        &deps,
        &[
            "react",
            "vue",
            "svelte",
            "@angular/core",
            "next",
            "nuxt",
            "solid-js",
            "preact",
            "astro",
        ],
    ) {
        ComponentKind::Frontend
    } else if any_dep(&deps, &["electron", "react-native", "expo"]) {
        ComponentKind::App
    } else if any_dep(&deps, &["prisma", "drizzle-kit", "knex"]) {
        ComponentKind::Database
    } else if scripts.contains("dev") || scripts.contains("start") {
        ComponentKind::Service
    } else {
        ComponentKind::Library
    };

    let pm = package_manager(dir, root);
    let mut tasks = Vec::new();
    if scripts.contains("dev") {
        tasks.push(task("dev", "Dev server", format!("{pm} run dev")));
    } else if scripts.contains("start") {
        tasks.push(task("dev", "Start", format!("{pm} run start")));
    }
    if scripts.contains("test") {
        tasks.push(task("test", "Tests", format!("{pm} run test")));
    }

    Some(Candidate {
        rel: String::new(),
        name: v["name"]
            .as_str()
            .map_or_else(|| dir_name(dir), str::to_string),
        kind,
        tasks,
        deps,
    })
}

fn from_cargo_toml(dir: &Path, text: &str) -> Option<Candidate> {
    let t: toml::Table = text.parse().ok()?;
    // A virtual workspace manifest has no [package].
    let name = t.get("package")?.get("name")?.as_str()?.to_string();
    let deps: HashSet<String> = ["dependencies", "dev-dependencies", "build-dependencies"]
        .iter()
        .filter_map(|k| t.get(*k).and_then(toml::Value::as_table))
        .flat_map(|d| d.keys().cloned())
        .collect();
    let is_bin = dir.join("src/main.rs").exists() || t.contains_key("bin");

    let kind = if deps.contains("tauri") {
        ComponentKind::App
    } else if any_dep(
        &deps,
        &["axum", "actix-web", "rocket", "warp", "poem", "tide"],
    ) {
        ComponentKind::Backend
    } else if is_bin {
        ComponentKind::App
    } else {
        ComponentKind::Library
    };

    let mut tasks = Vec::new();
    if is_bin {
        tasks.push(task("run", "Run", "cargo run".into()));
    }
    tasks.push(task("test", "Tests", "cargo test".into()));

    Some(Candidate {
        rel: String::new(),
        name,
        kind,
        tasks,
        deps,
    })
}

/// Package name from a PEP 508 requirement such as `fastapi>=0.110`.
fn requirement_name(req: &str) -> String {
    req.split(|c: char| "<>=!~[ ;@".contains(c))
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

fn python_candidate(dir: &Path, name: String, deps: HashSet<String>) -> Candidate {
    let kind = if any_dep(
        &deps,
        &[
            "fastapi",
            "flask",
            "django",
            "starlette",
            "aiohttp",
            "litestar",
        ],
    ) {
        ComponentKind::Backend
    } else if any_dep(&deps, &["streamlit", "gradio"]) {
        ComponentKind::Frontend
    } else {
        ComponentKind::Library
    };
    let mut tasks = Vec::new();
    if deps.contains("pytest") || dir.join("tests").is_dir() {
        tasks.push(task("test", "Tests", "python -m pytest".into()));
    }
    Candidate {
        rel: String::new(),
        name,
        kind,
        tasks,
        deps,
    }
}

fn from_pyproject(dir: &Path, text: &str) -> Option<Candidate> {
    let t: toml::Table = text.parse().ok()?;
    let project = t.get("project");
    let poetry = t.get("tool").and_then(|x| x.get("poetry"));
    let name = project
        .or(poetry)
        .and_then(|p| p.get("name"))
        .and_then(toml::Value::as_str)
        .map_or_else(|| dir_name(dir), str::to_string);
    let mut deps: HashSet<String> = project
        .and_then(|p| p.get("dependencies"))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .map(requirement_name)
        .collect();
    if let Some(d) = poetry
        .and_then(|p| p.get("dependencies"))
        .and_then(toml::Value::as_table)
    {
        deps.extend(d.keys().map(|k| k.to_lowercase()));
    }
    Some(python_candidate(dir, name, deps))
}

fn from_requirements(dir: &Path, text: &str) -> Candidate {
    let deps = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('-'))
        .map(requirement_name)
        .collect();
    python_candidate(dir, dir_name(dir), deps)
}

fn from_go_mod(dir: &Path, text: &str) -> Candidate {
    let module = text
        .lines()
        .find_map(|l| l.strip_prefix("module "))
        .map_or_else(|| dir_name(dir), |m| m.trim().to_string());
    let name = module.rsplit('/').next().unwrap_or(&module).to_string();
    let backend = [
        "gin-gonic/gin",
        "labstack/echo",
        "gofiber/fiber",
        "go-chi/chi",
    ]
    .iter()
    .any(|m| text.contains(m));
    let is_main = dir.join("main.go").exists();
    let kind = if backend {
        ComponentKind::Backend
    } else if is_main {
        ComponentKind::Service
    } else {
        ComponentKind::Library
    };
    let mut tasks = Vec::new();
    if is_main {
        tasks.push(task("run", "Run", "go run .".into()));
    }
    tasks.push(task("test", "Tests", "go test ./...".into()));
    Candidate {
        rel: String::new(),
        name,
        kind,
        tasks,
        deps: HashSet::new(),
    }
}

fn read(dir: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(file)).ok()
}

fn candidate_for(dir: &Path, root: &Path, detectors: &[DetectorContribution]) -> Option<Candidate> {
    if let Some(text) = read(dir, "package.json") {
        return from_package_json(dir, root, &text);
    }
    if let Some(text) = read(dir, "Cargo.toml") {
        return from_cargo_toml(dir, &text);
    }
    if let Some(text) = read(dir, "pyproject.toml") {
        return from_pyproject(dir, &text);
    }
    if let Some(text) = read(dir, "requirements.txt") {
        return Some(from_requirements(dir, &text));
    }
    if let Some(text) = read(dir, "go.mod") {
        return Some(from_go_mod(dir, &text));
    }
    for detector in detectors {
        if detector.files.iter().any(|file| dir.join(file).is_file()) {
            return Some(Candidate {
                rel: String::new(),
                name: dir_name(dir),
                kind: detector.kind,
                // Graph actions are opt-in by the user, never by a detector.
                tasks: detector
                    .terminals
                    .iter()
                    .cloned()
                    .map(|t| TerminalSpec { action: None, ..t })
                    .collect(),
                deps: HashSet::new(),
            });
        }
    }
    None
}

/// A git repo with no manifest we recognise still deserves a node.
fn repo_candidate(dir: &Path) -> Candidate {
    Candidate {
        rel: String::new(),
        name: dir_name(dir),
        kind: ComponentKind::Other,
        tasks: Vec::new(),
        deps: HashSet::new(),
    }
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<Candidate>,
    detectors: &[DetectorContribution],
) {
    let candidate = candidate_for(dir, root, detectors)
        .or_else(|| (dir != root && dir.join(".git").exists()).then(|| repo_candidate(dir)));
    if let Some(mut c) = candidate {
        let rel = dir.strip_prefix(root).unwrap_or(dir);
        c.rel = if rel.as_os_str().is_empty() {
            ".".into()
        } else {
            rel.to_string_lossy().replace('\\', "/")
        };
        out.push(c);
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_ref())
        })
        .collect();
    dirs.sort();
    for d in dirs {
        walk(root, &d, depth + 1, out, detectors);
    }
}

pub(crate) fn slug(rel: &str) -> String {
    if rel == "." {
        return "root".into();
    }
    let s: String = rel
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-');
    // Ids feed session ids and window labels, so they must never be empty.
    if s.is_empty() {
        "component".into()
    } else {
        s.to_string()
    }
}

/// Columns by dependency depth: dependents on the left, foundations on the right.
fn layout(components: &mut [Component], links: &[Link]) {
    fn level(
        id: &str,
        links: &[Link],
        memo: &mut HashMap<String, usize>,
        visiting: &mut HashSet<String>,
    ) -> usize {
        if let Some(l) = memo.get(id) {
            return *l;
        }
        if !visiting.insert(id.to_string()) {
            return 0; // cycle
        }
        let l = links
            .iter()
            .filter(|l| l.source == id)
            .map(|l| 1 + level(&l.target, links, memo, visiting))
            .max()
            .unwrap_or(0);
        visiting.remove(id);
        memo.insert(id.to_string(), l);
        l
    }

    let mut memo = HashMap::new();
    let levels: Vec<usize> = components
        .iter()
        .map(|c| level(&c.id, links, &mut memo, &mut HashSet::new()))
        .collect();
    let max = levels.iter().copied().max().unwrap_or(0);
    let mut rows: HashMap<usize, usize> = HashMap::new();
    for (c, lvl) in components.iter_mut().zip(levels) {
        let row = rows.entry(lvl).or_default();
        #[allow(clippy::cast_precision_loss)] // small layout counts
        {
            c.position = Position {
                x: (max - lvl) as f64 * COLUMN_WIDTH,
                y: *row as f64 * ROW_HEIGHT,
            };
        }
        *row += 1;
    }
}

/// Suggest a project for `root`. Falls back to a single root component.
///
/// # Errors
/// Fails if the project root cannot be resolved.
pub fn detect(root: &Path) -> Result<Project> {
    detect_with(root, &[])
}

/// Detection with declarative extension detectors.
/// # Errors
/// Fails for inaccessible or invalid folders.
pub fn detect_with(root: &Path, detectors: &[DetectorContribution]) -> Result<Project> {
    let root = root.canonicalize()?;
    let root = root.as_path();
    let mut found = Vec::new();
    walk(root, root, 0, &mut found, detectors);
    if found.is_empty() {
        found.push(Candidate {
            rel: ".".into(),
            name: dir_name(root),
            kind: ComponentKind::Other,
            tasks: Vec::new(),
            deps: HashSet::new(),
        });
    }

    let mut used = HashSet::new();
    let ids: Vec<String> = found
        .iter()
        .map(|c| {
            let base = slug(&c.rel);
            let mut id = base.clone();
            let mut n = 2;
            while !used.insert(id.clone()) {
                id = format!("{base}-{n}");
                n += 1;
            }
            id
        })
        .collect();

    let by_name: HashMap<&str, &str> = found
        .iter()
        .zip(&ids)
        .map(|(c, id)| (c.name.as_str(), id.as_str()))
        .collect();
    let mut links = Vec::new();
    for (c, id) in found.iter().zip(&ids) {
        let mut targets: Vec<&str> = c
            .deps
            .iter()
            .filter_map(|d| by_name.get(d.as_str()).copied())
            .filter(|t| t != id)
            .collect();
        targets.sort_unstable();
        for t in targets {
            links.push(Link {
                id: format!("{id}->{t}"),
                source: id.clone(),
                target: t.to_string(),
                label: None,
            });
        }
    }

    // A Tauri crate in `<app>/src-tauri` is the native side of the web app in `<app>`.
    for (c, id) in found.iter().zip(&ids) {
        let parent = if c.rel == "src-tauri" {
            Some(".")
        } else {
            c.rel.strip_suffix("/src-tauri")
        };
        let Some(parent) = parent.filter(|_| c.deps.contains("tauri")) else {
            continue;
        };
        if let Some((_, pid)) = found.iter().zip(&ids).find(|(p, _)| p.rel == parent) {
            links.push(Link {
                id: format!("{pid}->{id}"),
                source: pid.clone(),
                target: id.clone(),
                label: Some("Tauri IPC".into()),
            });
        }
    }

    // Packages in different ecosystems can share a name; tell them apart by folder.
    let mut name_counts: HashMap<String, usize> = HashMap::new();
    for c in &found {
        *name_counts.entry(c.name.clone()).or_default() += 1;
    }

    let mut components: Vec<Component> = found
        .into_iter()
        .zip(ids)
        .map(|(c, id)| {
            let name = if name_counts[&c.name] > 1 {
                let folder = c.rel.rsplit('/').next().unwrap_or(&c.rel);
                format!("{} ({folder})", c.name)
            } else {
                c.name
            };
            let mut terminals = default_terminals();
            terminals.splice(1..1, c.tasks);
            Component {
                id,
                name,
                kind: c.kind,
                path: c.rel,
                notes: String::new(),
                terminals,
                position: Position::default(),
            }
        })
        .collect();
    layout(&mut components, &links);

    Ok(Project {
        schema_version: SCHEMA_VERSION,
        name: dir_name(root),
        root: root.display().to_string(),
        components,
        links,
        groups: vec![],
    })
}

/// Add components (and their links) found by `detected` whose folder is not
/// already on the map. Folders are compared once resolved, so `../billing`
/// and the path of the folder it links to are the same component. Existing
/// components are left untouched. `detected` paths must be relative to
/// `existing.root`. Returns how many components were added; they and their
/// links are appended to the end of `existing.components` and `existing.links`.
pub fn merge_new(existing: &mut Project, detected: Project) -> usize {
    let dir = |path: &str| resolve_dir(&Path::new(&existing.root).join(path));
    let id_for_dir: HashMap<PathBuf, String> = existing
        .components
        .iter()
        .map(|c| (dir(&c.path), c.id.clone()))
        .collect();
    let detected_dirs: HashMap<String, PathBuf> = detected
        .components
        .iter()
        .map(|c| (c.id.clone(), dir(&c.path)))
        .collect();
    let mut taken: HashSet<String> = existing.components.iter().map(|c| c.id.clone()).collect();

    #[allow(clippy::cast_precision_loss)]
    let base_y = existing
        .components
        .iter()
        .map(|c| c.position.y)
        .fold(0.0, f64::max)
        + ROW_HEIGHT;

    let mut new_ids: HashMap<String, String> = HashMap::new();
    let mut added = 0;
    for mut c in detected.components {
        if detected_dirs
            .get(&c.id)
            .is_some_and(|d| id_for_dir.contains_key(d))
        {
            continue;
        }
        let mut id = c.id.clone();
        let mut n = 2;
        while !taken.insert(id.clone()) {
            id = format!("{}-{n}", c.id);
            n += 1;
        }
        new_ids.insert(c.id.clone(), id.clone());
        c.id = id;
        #[allow(clippy::cast_precision_loss)]
        {
            c.position = Position {
                x: added as f64 * COLUMN_WIDTH,
                y: base_y,
            };
        }
        existing.components.push(c);
        added += 1;
    }

    // Map a detected id to the id now on the map (new or pre-existing by folder).
    let resolve = |id: &str| -> Option<String> {
        new_ids.get(id).cloned().or_else(|| {
            detected_dirs
                .get(id)
                .and_then(|d| id_for_dir.get(d).cloned())
        })
    };
    for l in detected.links {
        if !(new_ids.contains_key(&l.source) || new_ids.contains_key(&l.target)) {
            continue;
        }
        if let (Some(s), Some(t)) = (resolve(&l.source), resolve(&l.target)) {
            existing.links.push(Link {
                id: format!("{s}->{t}"),
                source: s,
                target: t,
                label: l.label,
            });
        }
    }
    added
}

/// Detect components in a folder the user picked: usually a sibling repo
/// outside the project root, or a subfolder detection missed. Paths are
/// rewritten relative to the project root (`../billing` for a sibling) and ids
/// are prefixed with the folder name so they don't collide with the project's
/// own. A folder with no manifest still yields one component.
///
/// # Errors
/// Fails if `dir` or the project root cannot be resolved, or `dir` is the
/// project root itself (use [`rescan`]) or contains it.
pub fn detect_folder(project: &Project, dir: &Path) -> Result<Project> {
    detect_folder_with(project, dir, &[])
}

/// Detection with declarative extension detectors.
/// # Errors
/// Fails for inaccessible or invalid folders.
pub fn detect_folder_with(
    project: &Project,
    dir: &Path,
    detectors: &[DetectorContribution],
) -> Result<Project> {
    let dir = dir.canonicalize()?;
    let root = Path::new(&project.root).canonicalize()?;
    if dir == root {
        bail!("That is the project folder itself; use Rescan instead");
    }
    check_component_dir(&root, &dir)?;
    let mut found = detect_with(&dir, detectors)?;
    let prefix = slug(&dir_name(&dir));
    let rename = |id: &str| {
        if id == "root" {
            prefix.clone()
        } else {
            format!("{prefix}-{id}")
        }
    };
    for c in &mut found.components {
        c.id = rename(&c.id);
        c.path = relative_path(&root, &dir.join(&c.path));
    }
    for l in &mut found.links {
        l.source = rename(&l.source);
        l.target = rename(&l.target);
        l.id = format!("{}->{}", l.source, l.target);
    }
    Ok(found)
}

/// Add components for new folders under the project root and under each of
/// `folders` (usually [`Project::external_dirs`]: the external folders already
/// on the map, not their enclosing repos, so a rescan never reaches beyond what
/// the user added). Existing components are left untouched. Returns how many
/// components were added.
///
/// # Errors
/// Fails if the project root cannot be read.
pub fn rescan(project: &mut Project, folders: &[PathBuf]) -> Result<usize> {
    rescan_with(project, folders, &[])
}

/// Detection with declarative extension detectors.
/// # Errors
/// Fails for inaccessible or invalid folders.
pub fn rescan_with(
    project: &mut Project,
    folders: &[PathBuf],
    detectors: &[DetectorContribution],
) -> Result<usize> {
    let mut added = merge_new(project, detect_with(Path::new(&project.root), detectors)?);
    let folders: BTreeSet<_> = folders.iter().map(|d| normalize(d)).collect();
    // Scanning a folder covers everything below it.
    let tops: Vec<_> = folders
        .iter()
        .filter(|d| !folders.iter().any(|o| o != *d && d.starts_with(o)))
        .collect();
    for dir in tops {
        // A folder that vanished (or now contains the root) is simply skipped.
        if let Ok(found) = detect_folder_with(project, dir, detectors) {
            added += merge_new(project, found);
        }
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs, process};

    #[test]
    fn extension_detectors_claim_unknown_folders_and_preserve_user_edits() {
        let root = env::temp_dir().join(format!("patchbay-extension-detectors-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        write(&root, "compose/compose.yaml", "services: {}");
        write(&root, "compose/.git/HEAD", "ref: refs/heads/main");
        write(&root, "builtin/compose.yaml", "services: {}");
        write(
            &root,
            "builtin/package.json",
            r#"{"name":"builtin","dependencies":{"react":"*"}}"#,
        );
        let detector = DetectorContribution {
            id: "compose".into(),
            files: vec!["compose.yaml".into()],
            kind: ComponentKind::Service,
            terminals: vec![TerminalSpec {
                action: Some(crate::model::TerminalAction::Development),
                ..task("up", "Up", "docker compose up".into())
            }],
        };
        let detectors = [detector];
        let mut project = detect_with(&root, &detectors).unwrap();
        assert_eq!(
            project.component("builtin").unwrap().kind,
            ComponentKind::Frontend
        );
        let compose = project
            .components
            .iter_mut()
            .find(|c| c.id == "compose")
            .unwrap();
        assert_eq!(compose.kind, ComponentKind::Service);
        assert!(compose.terminals.iter().any(|t| t.id == "up"));
        assert!(compose.terminals.iter().all(|t| t.action.is_none()));
        compose.notes = "user notes".into();
        compose.terminals[1].command = "user command".into();
        assert_eq!(rescan_with(&mut project, &[], &detectors).unwrap(), 0);
        assert_eq!(project.component("compose").unwrap().notes, "user notes");
        assert_eq!(
            project.component("compose").unwrap().terminals[1].command,
            "user command"
        );
        let nested = root.join("new");
        write(&nested, "compose.yaml", "services: {}");
        let found = detect_folder_with(&project, &nested, &detectors).unwrap();
        assert_eq!(found.components[0].kind, ComponentKind::Service);
        fs::remove_dir_all(root).unwrap();
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn fixture(tag: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("patchbay-{tag}-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        write(
            &root,
            "package.json",
            r#"{"name":"mono","workspaces":["apps/*"]}"#,
        );
        write(&root, "pnpm-lock.yaml", "");
        write(
            &root,
            "apps/web/package.json",
            r#"{"name":"web","scripts":{"dev":"vite","test":"vitest"},"dependencies":{"react":"19","@acme/api-client":"*"}}"#,
        );
        write(
            &root,
            "packages/api-client/package.json",
            r#"{"name":"@acme/api-client"}"#,
        );
        write(
            &root,
            "services/api/pyproject.toml",
            "[project]\nname = \"api\"\ndependencies = [\"fastapi>=0.110\", \"pytest\"]\n",
        );
        write(
            &root,
            "apps/web/node_modules/x/package.json",
            r#"{"name":"x"}"#,
        );
        root
    }

    #[test]
    fn detects_components_kinds_terminals_and_links() {
        let root = fixture("detect");
        let p = detect(&root).unwrap();
        let names: Vec<_> = p.components.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["web", "@acme/api-client", "api"]);

        let web = &p.components[0];
        assert_eq!(web.kind, ComponentKind::Frontend);
        assert_eq!(web.path, "apps/web");
        let cmds: Vec<_> = web.terminals.iter().map(|t| t.command.as_str()).collect();
        assert_eq!(cmds, vec!["", "pnpm run dev", "pnpm run test", "claude"]);

        assert_eq!(p.components[2].kind, ComponentKind::Backend);
        assert_eq!(p.links.len(), 1);
        assert_eq!(p.links[0].source, "apps-web");
        assert_eq!(p.links[0].target, "packages-api-client");
        assert!(web.position.x < p.components[1].position.x);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_adds_only_new_folders() {
        let root = fixture("merge");
        let mut existing = detect(&root).unwrap();
        existing.components.retain(|c| c.path != "services/api");
        existing.components[0].name = "Renamed".into();
        let added = merge_new(&mut existing, detect(&root).unwrap());
        assert_eq!(added, 1);
        assert_eq!(existing.components[0].name, "Renamed");
        assert_eq!(existing.components.len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_requirement_names() {
        assert_eq!(
            requirement_name("FastAPI[all]>=0.1 ; python_version>'3'"),
            "fastapi"
        );
    }

    #[test]
    fn repos_without_a_manifest_become_components() {
        let root = env::temp_dir().join(format!("patchbay-repos-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("infra/.git")).unwrap();
        write(&root, "web/package.json", r#"{"name":"web"}"#);
        let p = detect(&root).unwrap();
        let paths: Vec<_> = p.components.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["infra", "web"]);
        assert_eq!(p.components[0].kind, ComponentKind::Other);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_repos_get_relative_paths_and_prefixed_ids() {
        let base = env::temp_dir().join(format!("patchbay-ext-{}", process::id()));
        let _ = fs::remove_dir_all(&base);
        write(
            &base,
            "shop/package.json",
            r#"{"name":"shop","scripts":{"dev":"vite"}}"#,
        );
        write(&base, "billing/go.mod", "module example.com/billing\n");
        write(
            &base,
            "billing/cmd/worker/go.mod",
            "module example.com/worker\n",
        );
        let mut project = detect(&base.join("shop").canonicalize().unwrap()).unwrap();

        let found = detect_folder(&project, &base.join("billing")).unwrap();
        let ids: Vec<_> = found.components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["billing", "billing-cmd-worker"]);
        assert_eq!(found.components[0].path, "../billing");
        assert_eq!(found.components[1].path, "../billing/cmd/worker");
        assert!(detect_folder(&project, &base.join("shop")).is_err());

        assert_eq!(merge_new(&mut project, found), 2);
        // Rescanning picks up a new folder in the external repo, not duplicates.
        write(&base, "billing/cmd/api/go.mod", "module example.com/api\n");
        let externals = project.external_dirs();
        assert_eq!(rescan(&mut project, &externals).unwrap(), 1);
        assert_eq!(rescan(&mut project, &externals).unwrap(), 0);
        assert!(
            project
                .components
                .iter()
                .any(|c| c.path == "../billing/cmd/api")
        );
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn rescan_does_not_duplicate_an_external_repo_behind_a_symlink() {
        let base = env::temp_dir().join(format!("patchbay-link-{}", process::id()));
        let _ = fs::remove_dir_all(&base);
        write(&base, "shop/package.json", r#"{"name":"shop"}"#);
        write(&base, "data/billing/go.mod", "module example.com/billing\n");
        std::os::unix::fs::symlink(base.join("data/billing"), base.join("billing")).unwrap();
        let mut project = detect(&base.join("shop").canonicalize().unwrap()).unwrap();
        let found = detect_folder(&project, &base.join("billing")).unwrap();
        assert_eq!(merge_new(&mut project, found), 1);
        // A hand-written path through the link names the same folder.
        project.components.last_mut().unwrap().path = "../billing".into();
        let externals = project.external_dirs();
        assert_eq!(rescan(&mut project, &externals).unwrap(), 0);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn picked_subfolder_without_manifest_becomes_one_component() {
        let base = env::temp_dir().join(format!("patchbay-sub-{}", process::id()));
        let _ = fs::remove_dir_all(&base);
        write(&base, "package.json", r#"{"name":"app"}"#);
        write(&base, "docs/index.md", "");
        let project = detect(&base.canonicalize().unwrap()).unwrap();
        let found = detect_folder(&project, &base.join("docs")).unwrap();
        assert_eq!(found.components.len(), 1);
        assert_eq!(found.components[0].id, "docs");
        assert_eq!(found.components[0].path, "docs");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rescan_stays_inside_added_folders_of_a_monorepo() {
        let base = env::temp_dir().join(format!("patchbay-mono-{}", process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join(".git")).unwrap();
        write(&base, "apps/shop/package.json", r#"{"name":"shop"}"#);
        write(&base, "apps/billing/go.mod", "module example.com/billing\n");
        write(&base, "apps/other/go.mod", "module example.com/other\n");
        let mut project = detect(&base.join("apps/shop").canonicalize().unwrap()).unwrap();
        let found = detect_folder(&project, &base.join("apps/billing")).unwrap();
        assert_eq!(merge_new(&mut project, found), 1);
        let externals = project.external_dirs();
        assert_eq!(rescan(&mut project, &externals).unwrap(), 0);
        assert!(!project.components.iter().any(|c| c.path.contains("other")));
        // A folder containing the project would swallow it.
        assert!(detect_folder(&project, &base.join("apps")).is_err());
        assert_eq!(rescan(&mut project, &[base.join("apps")]).unwrap(), 0);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn ids_are_never_empty() {
        assert_eq!(slug("___"), "component");
        assert_eq!(slug("日本"), "component");
        assert_eq!(slug("apps/web"), "apps-web");
    }

    #[test]
    fn detected_slugs_cannot_use_plan_scope() {
        for path in ["@plan", "services/@plan", ".", "@PLAN", "plan"] {
            let id = slug(path);
            assert!(!id.contains('@'));
            assert_ne!(id, crate::model::PLAN_SCOPE);
        }
    }
}
