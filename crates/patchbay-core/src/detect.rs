//! Suggest a component map from a repository's structure.
//!
//! Every folder with a recognised manifest (`package.json`, `Cargo.toml`,
//! `pyproject.toml`, `requirements.txt`, `go.mod`) becomes a component.
//! Dependencies between detected packages become links.

use crate::model::{
    Component, ComponentKind, Link, Position, Project, SCHEMA_VERSION, TerminalKind, TerminalSpec,
};
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::path::Path;

const MAX_DEPTH: usize = 4;
const SKIP_DIRS: &[&str] = &[
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
        id: id.into(),
        name: name.into(),
        command,
        kind: TerminalKind::Task,
    }
}

fn default_terminals() -> Vec<TerminalSpec> {
    vec![
        TerminalSpec {
            id: "shell".into(),
            name: "Shell".into(),
            command: String::new(),
            kind: TerminalKind::Shell,
        },
        TerminalSpec {
            id: "claude".into(),
            name: "Claude".into(),
            command: "claude".into(),
            kind: TerminalKind::Agent,
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

fn candidate_for(dir: &Path, root: &Path) -> Option<Candidate> {
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
    None
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Candidate>) {
    if let Some(mut c) = candidate_for(dir, root) {
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
        walk(root, &d, depth + 1, out);
    }
}

fn slug(rel: &str) -> String {
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
    s.trim_matches('-').to_string()
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
/// Currently infallible; reserved for I/O errors on unreadable roots.
pub fn detect(root: &Path) -> Result<Project> {
    let mut found = Vec::new();
    walk(root, root, 0, &mut found);
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
    })
}

/// Add components (and their links) found by `detected` whose folder is not
/// already on the map. Existing components are left untouched.
/// Returns how many components were added.
pub fn merge_new(existing: &mut Project, detected: Project) -> usize {
    let known: HashSet<String> = existing.components.iter().map(|c| c.path.clone()).collect();
    let id_for_path: HashMap<String, String> = existing
        .components
        .iter()
        .map(|c| (c.path.clone(), c.id.clone()))
        .collect();
    let detected_paths: HashMap<String, String> = detected
        .components
        .iter()
        .map(|c| (c.id.clone(), c.path.clone()))
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
        if known.contains(&c.path) {
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

    // Map a detected id to the id now on the map (new or pre-existing by path).
    let resolve = |id: &str| -> Option<String> {
        new_ids.get(id).cloned().or_else(|| {
            detected_paths
                .get(id)
                .and_then(|p| id_for_path.get(p).cloned())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn fixture(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("patchbay-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
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
        let _ = std::fs::remove_dir_all(root);
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
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parses_requirement_names() {
        assert_eq!(
            requirement_name("FastAPI[all]>=0.1 ; python_version>'3'"),
            "fastapi"
        );
    }
}
