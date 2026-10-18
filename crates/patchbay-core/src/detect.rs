//! Suggest a component map from a repository's structure.
//!
//! Every folder with a recognised manifest (`package.json`, `Cargo.toml`,
//! `pyproject.toml`, `requirements.txt`, `go.mod`) or native app project (Xcode
//! or Android Gradle) becomes a component, as does any nested git repo without
//! one. Dependencies between detected packages become links, as do manifests
//! that point at another component's folder (`-r ../api/requirements.txt`,
//! `file:../lib`, path dependencies, Go replacements, Gradle included builds).

use crate::extensions::DetectorContribution;
use crate::model::{
    Component, ComponentKind, Link, Position, Project, SCHEMA_VERSION, TerminalKind, TerminalSpec,
    check_component_dir, normalize, relative_path, resolve_dir,
};
use anyhow::{Result, bail};
use std::cell::OnceCell;
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
    "Pods",
    "Carthage",
];
const COLUMN_WIDTH: f64 = 340.0;
const ROW_HEIGHT: f64 = 230.0;

struct Candidate {
    detector: String,
    rel: String,
    name: String,
    kind: ComponentKind,
    tasks: Vec<TerminalSpec>,
    deps: HashSet<String>,
    /// Canonical paths the folder's manifests refer to.
    refs: Vec<PathBuf>,
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
fn from_package_json(dir: &Path, root: &Path, v: &serde_json::Value) -> Option<Candidate> {
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
    } else if any_dep(&deps, &["electron", "react-native", "expo"]) {
        ComponentKind::App
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
        detector: "builtin".into(),
        rel: String::new(),
        name: v["name"]
            .as_str()
            .map_or_else(|| dir_name(dir), str::to_string),
        kind,
        tasks,
        deps,
        refs: Vec::new(),
    })
}

fn from_cargo_toml(dir: &Path, t: &toml::Table) -> Option<Candidate> {
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
        detector: "builtin".into(),
        rel: String::new(),
        name,
        kind,
        tasks,
        deps,
        refs: Vec::new(),
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
        detector: "builtin".into(),
        rel: String::new(),
        name,
        kind,
        tasks,
        deps,
        refs: Vec::new(),
    }
}

fn from_pyproject(dir: &Path, t: &toml::Table) -> Candidate {
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
    python_candidate(dir, name, deps)
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
        detector: "builtin".into(),
        rel: String::new(),
        name,
        kind,
        tasks,
        deps: HashSet::new(),
        refs: Vec::new(),
    }
}

fn read(dir: &Path, file: &str, root: &Path) -> Option<String> {
    let path = dir.join(file).canonicalize().ok()?;
    if !path.starts_with(root) {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// A local path from a dependency spec (`../lib`, `file:../lib`, `file:///abs`),
/// without extras, a URL fragment, PEP 508 environment markers (`; python_version…`)
/// or trailing pip options (` --hash=…`). `bare` also accepts a plain relative name,
/// as `-r base.txt` does; otherwise it must start like a path.
fn local_path(spec: &str, bare: bool) -> Option<String> {
    let spec = spec.split(';').next().unwrap_or(spec).trim_start();
    // Options follow the path after whitespace: `./lib --hash=sha256:…`.
    let spec = spec
        .match_indices(char::is_whitespace)
        .find(|&(i, _)| spec[i..].trim_start().starts_with('-'))
        .map_or(spec, |(i, _)| &spec[..i]);
    let spec = spec.trim();
    let (spec, bare) = if let Some(rest) = spec.strip_prefix("file://") {
        (rest, true)
    } else if let Some(rest) = spec.strip_prefix("file:") {
        (rest, true)
    } else {
        (spec, bare)
    };
    if spec.is_empty() || spec.contains("://") || spec.starts_with("git+") {
        return None;
    }
    let spec = spec.split('#').next().unwrap_or(spec);
    let spec = spec.split('[').next().unwrap_or(spec).trim();
    let path_like = spec.starts_with('.') || spec.starts_with('/');
    (!spec.is_empty() && (bare || path_like)).then(|| spec.to_string())
}

/// Folders and files a requirements file points at: `-r`/`-c` files,
/// editable or plain local paths, and `name @ file:…` requirements.
fn requirement_refs(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    for line in text.lines() {
        let line = line.split(" #").next().unwrap_or(line).trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let option = [
            ("--requirement", true),
            ("--constraint", true),
            ("--editable", false),
            ("-r", true),
            ("-c", true),
            ("-e", false),
        ]
        .into_iter()
        .find_map(|(flag, bare)| {
            let rest = line.strip_prefix(flag)?;
            // `-rbase.txt` is valid; `--requirementbase.txt` isn't.
            let separated = flag.len() == 2 || rest.starts_with([' ', '\t', '=']);
            separated.then_some((rest.strip_prefix('=').unwrap_or(rest), bare))
        });
        let found = match option {
            Some((rest, bare)) => local_path(rest, bare),
            None if line.starts_with('-') => None,
            None => match line.split_once(" @ ").or_else(|| line.split_once('@')) {
                Some((_, url)) if url.trim().starts_with("file:") => local_path(url, false),
                _ => local_path(line, false),
            },
        };
        refs.extend(found);
    }
    refs
}

/// `file:`, `link:` and `portal:` dependencies of a `package.json`.
fn package_refs(v: &serde_json::Value) -> Vec<String> {
    [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .iter()
    .filter_map(|k| v[*k].as_object())
    .flat_map(|o| o.values())
    .filter_map(serde_json::Value::as_str)
    .filter_map(|spec| {
        ["file:", "link:", "portal:"]
            .iter()
            .find_map(|p| spec.strip_prefix(p))
            .and_then(|rest| local_path(rest, true))
    })
    .collect()
}

/// `path` values of the dependency tables in a TOML value.
fn toml_paths<'a>(tables: impl Iterator<Item = &'a toml::Value>) -> Vec<String> {
    tables
        .filter_map(toml::Value::as_table)
        .flat_map(|t| t.values())
        .filter_map(|dep| dep.get("path")?.as_str())
        .filter_map(|path| local_path(path, true))
        .collect()
}

/// `path` dependencies of a `Cargo.toml`, including per-target ones. A
/// workspace's `[workspace.dependencies]` only declare versions for members to
/// inherit, so they aren't dependencies of the folder itself.
fn cargo_refs(t: &toml::Table) -> Vec<String> {
    const TABLES: [&str; 3] = ["dependencies", "dev-dependencies", "build-dependencies"];
    let mut tables: Vec<&toml::Value> = TABLES.iter().filter_map(|k| t.get(*k)).collect();
    if let Some(targets) = t.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            tables.extend(TABLES.iter().filter_map(|k| target.get(*k)));
        }
    }
    toml_paths(tables.into_iter())
}

/// Local path dependencies of a `pyproject.toml`: PEP 621 `name @ file:…`,
/// Poetry `{ path = … }` (also in groups) and uv path sources.
fn pyproject_refs(t: &toml::Table) -> Vec<String> {
    let project = t.get("project");
    let mut specs: Vec<&str> = project
        .and_then(|p| p.get("dependencies"))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .collect();
    if let Some(optional) = project
        .and_then(|p| p.get("optional-dependencies"))
        .and_then(toml::Value::as_table)
    {
        specs.extend(
            optional
                .values()
                .filter_map(toml::Value::as_array)
                .flatten()
                .filter_map(toml::Value::as_str),
        );
    }
    let mut refs: Vec<String> = specs
        .into_iter()
        .filter_map(|spec| spec.split_once('@'))
        .filter(|(_, url)| url.trim().starts_with("file:"))
        .filter_map(|(_, url)| local_path(url, false))
        .collect();
    let tool = t.get("tool");
    let poetry = tool.and_then(|x| x.get("poetry"));
    let mut tables: Vec<&toml::Value> = ["dependencies", "dev-dependencies"]
        .iter()
        .filter_map(|k| poetry.and_then(|p| p.get(*k)))
        .collect();
    if let Some(groups) = poetry
        .and_then(|p| p.get("group"))
        .and_then(toml::Value::as_table)
    {
        tables.extend(groups.values().filter_map(|g| g.get("dependencies")));
    }
    tables.extend(tool.and_then(|x| x.get("uv")?.get("sources")));
    refs.extend(toml_paths(tables.into_iter()));
    refs
}

/// Local targets of `replace` directives in a `go.mod`.
fn go_replace_refs(text: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut block = false;
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or(line).trim();
        let directive = if block {
            if line.starts_with(')') {
                block = false;
                continue;
            }
            line
        } else if let Some(rest) = line.strip_prefix("replace") {
            let rest = rest.trim();
            if rest.starts_with('(') {
                block = true;
                continue;
            }
            rest
        } else {
            continue;
        };
        if let Some((_, target)) = directive.split_once("=>") {
            let target = target.split_whitespace().next().unwrap_or("");
            refs.extend(local_path(target, false));
        }
    }
    refs
}

/// Quoted strings that follow `keyword` (`includeBuild("../x")`, `includeBuild '../x'`).
fn quoted_after(text: &str, keyword: &str) -> Vec<String> {
    text.match_indices(keyword)
        .filter_map(|(at, _)| {
            let rest = text[at + keyword.len()..].trim_start();
            let rest = rest.strip_prefix('(').unwrap_or(rest).trim_start();
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let body = &rest[1..];
            Some(body[..body.find(quote)?].to_string())
        })
        .collect()
}

/// Groovy or Kotlin source without its `//` and `/* */` comments, keeping
/// strings (which may contain either) and line breaks.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                out.push(c);
                while let Some(d) = chars.next() {
                    out.push(d);
                    if d == '\\' {
                        out.extend(chars.next());
                    } else if d == c || d == '\n' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => while chars.next_if(|d| *d != '\n').is_some() {},
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for d in chars.by_ref() {
                    if d == '\n' {
                        out.push('\n');
                    }
                    if last == '*' && d == '/' {
                        break;
                    }
                    last = d;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

/// Included builds and explicit project folders in a Gradle settings file.
fn gradle_refs(text: &str) -> Vec<String> {
    let text = strip_comments(text);
    let text = text.as_str();
    let mut refs = quoted_after(text, "includeBuild");
    for line in text.lines().filter(|l| l.contains("projectDir")) {
        refs.extend(quoted_after(line, "file"));
    }
    refs.into_iter()
        .filter_map(|r| local_path(&r, true))
        .collect()
}

/// Manifest files a folder's detection and its folder references read.
const MANIFESTS: [&str; 7] = [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "settings.gradle",
    "settings.gradle.kts",
];

/// One folder's manifests, each read and parsed at most once, whether by
/// detection or by its folder references.
struct Manifests<'a> {
    dir: &'a Path,
    root: &'a Path,
    /// The names of the folder's entries, listed once by `walk`.
    names: &'a [String],
    texts: [OnceCell<Option<String>>; MANIFESTS.len()],
    package: OnceCell<Option<serde_json::Value>>,
    cargo: OnceCell<Option<toml::Table>>,
    pyproject: OnceCell<Option<toml::Table>>,
}

impl<'a> Manifests<'a> {
    fn new(dir: &'a Path, root: &'a Path, names: &'a [String]) -> Self {
        Self {
            dir,
            root,
            names,
            texts: Default::default(),
            package: OnceCell::new(),
            cargo: OnceCell::new(),
            pyproject: OnceCell::new(),
        }
    }

    /// The text of `file`, one of `MANIFESTS` (`None` for any other).
    fn text(&self, file: &str) -> Option<&str> {
        let at = MANIFESTS.iter().position(|m| *m == file)?;
        self.texts[at]
            .get_or_init(|| read(self.dir, file, self.root))
            .as_deref()
    }

    fn package(&self) -> Option<&serde_json::Value> {
        self.package
            .get_or_init(|| serde_json::from_str(self.text("package.json")?).ok())
            .as_ref()
    }

    fn cargo(&self) -> Option<&toml::Table> {
        self.cargo
            .get_or_init(|| self.text("Cargo.toml")?.parse().ok())
            .as_ref()
    }

    fn pyproject(&self) -> Option<&toml::Table> {
        self.pyproject
            .get_or_init(|| self.text("pyproject.toml")?.parse().ok())
            .as_ref()
    }

    /// Canonical paths the folder's manifests refer to. Relative references
    /// resolve against the folder; ones that don't exist are dropped.
    fn refs(&self) -> Vec<PathBuf> {
        let mut refs = Vec::new();
        let mut requirements: Vec<&String> = self
            .names
            .iter()
            .filter(|n| n.starts_with("requirements") && n.ends_with(".txt"))
            .collect();
        requirements.sort();
        for file in requirements {
            if file == "requirements.txt" {
                refs.extend(self.text(file).map(requirement_refs).unwrap_or_default());
            } else if let Some(text) = read(self.dir, file, self.root) {
                refs.extend(requirement_refs(&text));
            }
        }
        refs.extend(self.package().map(package_refs).unwrap_or_default());
        refs.extend(self.cargo().map(cargo_refs).unwrap_or_default());
        refs.extend(self.pyproject().map(pyproject_refs).unwrap_or_default());
        refs.extend(self.text("go.mod").map(go_replace_refs).unwrap_or_default());
        for file in ["settings.gradle", "settings.gradle.kts"] {
            refs.extend(self.text(file).map(gradle_refs).unwrap_or_default());
        }
        refs.iter()
            .filter_map(|r| self.dir.join(r).canonicalize().ok())
            .collect()
    }
}

/// The candidate whose folder most specifically contains `path`.
fn owner_of(path: &Path, dirs: &[PathBuf]) -> Option<usize> {
    dirs.iter()
        .enumerate()
        .filter(|(_, d)| path.starts_with(d))
        .max_by_key(|(_, d)| d.components().count())
        .map(|(i, _)| i)
}

fn has_gradle_settings(dir: &Path) -> bool {
    ["settings.gradle", "settings.gradle.kts"]
        .iter()
        .any(|file| {
            dir.join(file)
                .canonicalize()
                .is_ok_and(|path| path.starts_with(dir) && path.is_file())
        })
}

fn is_android_module(dir: &Path) -> bool {
    ["build.gradle", "build.gradle.kts"].iter().any(|file| {
        dir.join(file)
            .canonicalize()
            .is_ok_and(|path| path.starts_with(dir) && path.is_file())
    }) && ["src/main/AndroidManifest.xml", "src/AndroidManifest.xml"]
        .iter()
        .any(|file| {
            dir.join(file)
                .canonicalize()
                .is_ok_and(|path| path.starts_with(dir) && path.is_file())
        })
}

fn is_android_project(dir: &Path) -> bool {
    is_android_module(dir)
        || (has_gradle_settings(dir)
            && std::fs::read_dir(dir).is_ok_and(|entries| {
                entries.flatten().any(|entry| {
                    entry.file_type().is_ok_and(|kind| kind.is_dir())
                        && is_android_module(&entry.path())
                })
            }))
}

fn from_native_project(dir: &Path, root: &Path) -> Option<Candidate> {
    let xcode = std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let path = entry.path();
            match path.extension().and_then(|ext| ext.to_str()) {
                Some("xcodeproj") => path
                    .join("project.pbxproj")
                    .canonicalize()
                    .is_ok_and(|p| p.starts_with(root) && p.is_file()),
                Some("xcworkspace") => path
                    .join("contents.xcworkspacedata")
                    .canonicalize()
                    .is_ok_and(|p| p.starts_with(root) && p.is_file()),
                _ => false,
            }
        })
    });
    if !xcode {
        if !is_android_project(dir) {
            return None;
        }
        // Keep Android modules on their owning project's node, with terminals
        // rooted beside settings.gradle and the Gradle wrapper. An independent
        // nested build with its own settings still gets its own component.
        if !has_gradle_settings(dir) && dir != root {
            for parent in dir.ancestors().skip(1) {
                if has_gradle_settings(parent) && is_android_project(parent) {
                    return None;
                }
                if parent == root {
                    break;
                }
            }
        }
    }
    Some(Candidate {
        detector: "builtin".into(),
        rel: String::new(),
        name: dir_name(dir),
        kind: ComponentKind::App,
        tasks: Vec::new(),
        deps: HashSet::new(),
        refs: Vec::new(),
    })
}

/// Identify the detector and stable package identity before user display-name edits.
fn provenance(dir: &Path, root: &Path, detector: &str) -> crate::model::DetectionProvenance {
    if detector != "builtin" {
        return crate::model::DetectionProvenance {
            detector: detector.into(),
            package_identity: None,
        };
    }
    let declared = if let Some(text) = read(dir, "package.json", root) {
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["name"].as_str().map(|name| format!("npm:{name}")))
    } else if let Some(text) = read(dir, "Cargo.toml", root) {
        toml::from_str::<toml::Value>(&text).ok().and_then(|v| {
            v.get("package")?
                .get("name")?
                .as_str()
                .map(|name| format!("cargo:{name}"))
        })
    } else if let Some(text) = read(dir, "pyproject.toml", root) {
        toml::from_str::<toml::Value>(&text).ok().and_then(|v| {
            v.get("project")
                .or_else(|| v.get("tool")?.get("poetry"))?
                .get("name")?
                .as_str()
                .map(|name| format!("python:{name}"))
        })
    } else if let Some(text) = read(dir, "go.mod", root) {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix("module ")
                .map(|name| format!("go:{}", name.trim()))
        })
    } else {
        None
    };
    crate::model::DetectionProvenance {
        detector: "builtin".into(),
        package_identity: declared,
    }
}

fn candidate_for(
    manifests: &Manifests,
    dir: &Path,
    root: &Path,
    detectors: &[DetectorContribution],
) -> Option<Candidate> {
    if manifests.text("package.json").is_some() {
        return from_package_json(dir, root, manifests.package()?);
    }
    if manifests.text("Cargo.toml").is_some() {
        return from_cargo_toml(dir, manifests.cargo()?);
    }
    if manifests.text("pyproject.toml").is_some() {
        return Some(from_pyproject(dir, manifests.pyproject()?));
    }
    if let Some(text) = manifests.text("requirements.txt") {
        return Some(from_requirements(dir, text));
    }
    if let Some(text) = manifests.text("go.mod") {
        return Some(from_go_mod(dir, text));
    }
    if let Some(candidate) = from_native_project(dir, root) {
        return Some(candidate);
    }
    for detector in detectors {
        if detector.files.iter().any(|file| {
            dir.join(file)
                .canonicalize()
                .is_ok_and(|path| path.starts_with(root) && path.is_file())
        }) {
            return Some(Candidate {
                detector: detector.id.clone(),
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
                refs: Vec::new(),
            });
        }
    }
    None
}

/// A git repo with no manifest we recognise still deserves a node.
fn repo_candidate(dir: &Path) -> Candidate {
    Candidate {
        detector: "builtin".into(),
        rel: String::new(),
        name: dir_name(dir),
        kind: ComponentKind::Other,
        tasks: Vec::new(),
        deps: HashSet::new(),
        refs: Vec::new(),
    }
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<Candidate>,
    detectors: &[DetectorContribution],
) {
    // Listed once, for both requirement files and subfolders.
    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)
        .map(|e| e.flatten().collect())
        .unwrap_or_default();
    let names: Vec<String> = entries
        .iter()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    let manifests = Manifests::new(dir, root, &names);
    let candidate = candidate_for(&manifests, dir, root, detectors)
        .or_else(|| (dir != root && dir.join(".git").exists()).then(|| repo_candidate(dir)));
    if let Some(mut c) = candidate {
        c.refs = manifests.refs();
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
    let mut dirs: Vec<_> = entries
        .iter()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(std::fs::DirEntry::path)
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            !name.starts_with('.')
                && !SKIP_DIRS.contains(&name.as_ref())
                && !name.ends_with(".xcodeproj")
                && !name.ends_with(".xcworkspace")
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
            detector: "builtin".into(),
            rel: ".".into(),
            name: dir_name(root),
            kind: ComponentKind::Other,
            tasks: Vec::new(),
            deps: HashSet::new(),
            refs: Vec::new(),
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
                detection: Some(crate::model::DetectionProvenance {
                    detector: "builtin".into(),
                    package_identity: None,
                }),
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
                detection: Some(crate::model::DetectionProvenance {
                    detector: "builtin".into(),
                    package_identity: None,
                }),
                id: format!("{pid}->{id}"),
                source: pid.clone(),
                target: id.clone(),
                label: Some("Tauri IPC".into()),
            });
        }
    }

    // A manifest that points into another component's folder depends on it,
    // whatever that package is called. A component never depends on one that
    // contains it (a root package, or its own `-r requirements.txt`).
    let dirs: Vec<PathBuf> = found
        .iter()
        .map(|c| {
            if c.rel == "." {
                root.to_path_buf()
            } else {
                root.join(&c.rel)
            }
        })
        .collect();
    let mut linked: HashSet<(String, String)> = links
        .iter()
        .map(|l| (l.source.clone(), l.target.clone()))
        .collect();
    for (i, c) in found.iter().enumerate() {
        let mut targets: Vec<usize> = c
            .refs
            .iter()
            .filter_map(|r| owner_of(r, &dirs))
            .filter(|&t| !dirs[i].starts_with(&dirs[t]))
            .collect();
        targets.sort_unstable();
        targets.dedup();
        for t in targets {
            if linked.insert((ids[i].clone(), ids[t].clone())) {
                links.push(Link {
                    detection: Some(crate::model::DetectionProvenance {
                        detector: "builtin".into(),
                        package_identity: None,
                    }),
                    id: format!("{}->{}", ids[i], ids[t]),
                    source: ids[i].clone(),
                    target: ids[t].clone(),
                    label: None,
                });
            }
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
            let detection = provenance(&root.join(&c.rel), root, &c.detector);
            let name = if name_counts[&c.name] > 1 {
                let folder = c.rel.rsplit('/').next().unwrap_or(&c.rel);
                format!("{} ({folder})", c.name)
            } else {
                c.name
            };
            let mut terminals = default_terminals();
            terminals.splice(1..1, c.tasks);
            Component {
                detection: Some(detection),
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
                detection: l.detection,
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
    fn rescan_adds_native_apps_without_duplicate_modules_or_changing_existing_components() {
        let root = env::temp_dir().join(format!("patchbay-native-rescan-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        write(&root, "KriloBackend/requirements.txt", "fastapi\n");
        write(&root, "KriloCronJobs/requirements.txt", "requests\n");
        let mut project = detect(&root).unwrap();
        project.components[0].name = "My backend".into();
        project.components[0].notes = "Keep these notes".into();
        project.components[0].position.x = 123.0;
        project.components[0].terminals[0].command = "custom shell".into();
        let existing = serde_json::to_value(&project.components).unwrap();

        write(&root, "Krilo/Krilo.xcodeproj/project.pbxproj", "{}");
        write(
            &root,
            "Krilo/Krilo.xcworkspace/contents.xcworkspacedata",
            "<Workspace/>",
        );
        write(
            &root,
            "Krilo/Pods/Dependency/Dependency.xcodeproj/project.pbxproj",
            "{}",
        );
        write(
            &root,
            "Krilo/build/Generated/Generated.xcodeproj/project.pbxproj",
            "{}",
        );
        write(
            &root,
            "KriloAndroid/settings.gradle.kts",
            "include(\":app\", \":shared\")",
        );
        write(&root, "KriloAndroid/build.gradle.kts", "plugins {}");
        write(&root, "KriloAndroid/gradlew", "");
        for module in ["app", "shared"] {
            write(
                &root,
                &format!("KriloAndroid/{module}/build.gradle.kts"),
                "plugins {}",
            );
            write(
                &root,
                &format!("KriloAndroid/{module}/src/main/AndroidManifest.xml"),
                "<manifest/>",
            );
        }

        assert_eq!(rescan(&mut project, &[]).unwrap(), 2);
        assert_eq!(
            serde_json::to_value(&project.components[..2]).unwrap(),
            existing
        );
        for (id, path) in [("krilo", "Krilo"), ("kriloandroid", "KriloAndroid")] {
            let app = project.component(id).unwrap();
            assert_eq!(app.name, path);
            assert_eq!(app.path, path);
            assert_eq!(app.kind, ComponentKind::App);
            let kinds: Vec<_> = app.terminals.iter().map(|terminal| terminal.kind).collect();
            assert_eq!(kinds, [TerminalKind::Shell, TerminalKind::Agent]);
        }
        assert_eq!(rescan(&mut project, &[]).unwrap(), 0);
        assert_eq!(detect(&root).unwrap().components.len(), 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_android_roots_custom_modules_and_standalone_builds() {
        let root = env::temp_dir().join(format!("patchbay-android-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        // A settings-only root and a module name other than "app".
        write(&root, "android/settings.gradle", "include ':mobile'");
        write(&root, "android/mobile/build.gradle", "plugins {}");
        write(
            &root,
            "android/mobile/src/main/AndroidManifest.xml",
            "<manifest/>",
        );
        write(&root, "standalone/build.gradle.kts", "plugins {}");
        write(
            &root,
            "standalone/src/main/AndroidManifest.xml",
            "<manifest/>",
        );
        write(&root, "jvm/settings.gradle.kts", "include(\":app\")");
        write(&root, "jvm/app/build.gradle.kts", "plugins { java }");
        write(&root, "android/independent/settings.gradle.kts", "");
        write(&root, "android/independent/build.gradle.kts", "plugins {}");
        write(
            &root,
            "android/independent/src/main/AndroidManifest.xml",
            "<manifest/>",
        );
        let project = detect(&root).unwrap();
        let paths: Vec<_> = project.components.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["android", "android/independent", "standalone"]);
        assert!(
            project
                .components
                .iter()
                .all(|c| c.kind == ComponentKind::App)
        );
        // Opening a module itself must still detect that root, even if its
        // owning Gradle project lies outside the selected folder.
        let module = detect(&root.join("android/mobile")).unwrap();
        assert_eq!(module.components[0].path, ".");
        assert_eq!(module.components[0].kind, ComponentKind::App);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_xcode_workspaces_and_ignores_incomplete_project_bundles() {
        let root = env::temp_dir().join(format!("patchbay-xcode-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        write(
            &root,
            "ios/App.xcworkspace/contents.xcworkspacedata",
            "<Workspace/>",
        );
        write(
            &root,
            "ios/App.xcworkspace/package.json",
            r#"{"name":"bundle-internal"}"#,
        );
        write(
            &root,
            "incomplete/App.xcodeproj/README.md",
            "Not a project yet",
        );
        let project = detect(&root).unwrap();
        assert_eq!(project.components.len(), 1);
        assert_eq!(project.components[0].path, "ios");
        assert_eq!(project.components[0].kind, ComponentKind::App);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn react_native_and_expo_with_react_are_classified_as_apps() {
        for dependency in ["react-native", "expo"] {
            let package = serde_json::json!({
                "name": "mobile",
                "dependencies": { "react": "*", dependency: "*" },
            });
            let candidate =
                from_package_json(Path::new("mobile"), Path::new("mobile"), &package).unwrap();
            assert_eq!(candidate.kind, ComponentKind::App);
        }
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
    fn requirement_paths_drop_markers_and_pip_options() {
        assert_eq!(
            requirement_refs(
                "./lib ; python_version < \"3.12\"\n./tight;sys_platform == \"linux\"\n\
                 ../pinned --hash=sha256:abc --hash=sha256:def\n\
                 -e ../editable --config-settings editable_mode=compat\n\
                 sdk @ file:../sdk ; python_version >= \"3.8\"\n\
                 -r ../base.txt\t--no-binary :all:\n"
            ),
            [
                "./lib",
                "./tight",
                "../pinned",
                "../editable",
                "../sdk",
                "../base.txt"
            ]
        );
        assert_eq!(
            local_path("  ./spaced  ", false).as_deref(),
            Some("./spaced")
        );
        assert_eq!(local_path("; marker", true), None);
    }

    #[test]
    fn parses_folder_references_of_each_manifest() {
        assert_eq!(
            requirement_refs(
                "django\n-r ../api/requirements.txt  # shared\n-rbase.txt\n--constraint=../c.txt\n\
                 -e ../lib[dev]\n-e git+https://x/y.git#egg=y\n--index-url https://x\n\
                 ./local\nsdk @ file:../sdk\nother @ https://x/y.whl\n# -r ignored.txt\n"
            ),
            [
                "../api/requirements.txt",
                "base.txt",
                "../c.txt",
                "../lib",
                "./local",
                "../sdk"
            ]
        );
        assert_eq!(
            package_refs(
                &serde_json::from_str(
                    r#"{"dependencies":{"a":"file:../a","b":"^1"},"devDependencies":{"c":"link:../c"},
                   "optionalDependencies":{"d":"portal:./d"},"peerDependencies":{"e":"workspace:*"}}"#
                )
                .unwrap()
            ),
            ["../a", "../c", "./d"]
        );
        assert_eq!(
            cargo_refs(
                &"[dependencies]\ncore = { path = \"../core\" }\nserde = \"1\"\n\
                 [target.'cfg(unix)'.dev-dependencies]\nnix = { path = \"../nix\" }\n"
                    .parse()
                    .unwrap()
            ),
            ["../core", "../nix"]
        );
        // Workspace dependencies are versions for members to inherit, not the
        // root folder's own dependencies.
        assert_eq!(
            cargo_refs(
                &"[workspace]\nmembers = [\"crates/*\"]\n\
                 [workspace.dependencies]\ncore = { path = \"crates/core\" }\n\
                 [dependencies]\ncli = { path = \"crates/cli\" }\n"
                    .parse()
                    .unwrap()
            ),
            ["crates/cli"]
        );
        assert_eq!(
            pyproject_refs(
                &"[project]\nname = \"x\"\ndependencies = [\"lib @ file:///abs/lib\", \"requests\"]\n\
                 [tool.poetry.group.dev.dependencies]\nshared = { path = \"../shared\", develop = true }\n\
                 [tool.uv.sources]\nmodels = { path = \"../models\" }\nother = { git = \"https://x\" }\n"
                    .parse()
                    .unwrap()
            ),
            ["/abs/lib", "../shared", "../models"]
        );
        assert_eq!(
            go_replace_refs(
                "module x\nreplace example.com/a => ../a\nreplace (\n  example.com/b v1 => ./b // local\n  \
                 example.com/c => example.com/d v2\n)\n"
            ),
            ["../a", "./b"]
        );
        assert_eq!(
            gradle_refs(
                "includeBuild(\"../shared\")\nincludeBuild '../plugins'\ninclude(\":lib\")\n\
                 project(\":lib\").projectDir = file(\"../lib\")\n"
            ),
            ["../shared", "../plugins", "../lib"]
        );
        assert_eq!(
            gradle_refs(
                "// includeBuild(\"../commented\")\n/* includeBuild '../block'\n\
                 project(\":x\").projectDir = file(\"../x\") */\n\
                 includeBuild(\"../real\") // includeBuild(\"../trailing\")\n\
                 includeBuild(\"../a//b\")\n\
                 project(\":y\").projectDir /* file(\"../no\") */ = file(\"../y\")\n"
            ),
            ["../real", "../a//b", "../y"]
        );
    }

    #[test]
    fn folder_references_link_components_once() {
        let root = env::temp_dir().join(format!("patchbay-folder-refs-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        write(&root, "requirements.txt", "requests\n");
        write(&root, "Backend/requirements.txt", "django\n");
        write(
            &root,
            "CronJobs/requirements.txt",
            "-r ../Backend/requirements.txt\n-r ../requirements.txt\n",
        );
        write(
            &root,
            "CronJobs/requirements-dev.txt",
            "-r requirements.txt\n",
        );
        write(
            &root,
            "web/package.json",
            r#"{"name":"web","dependencies":{"shared-ui":"file:../lib","lib":"*"}}"#,
        );
        write(&root, "lib/package.json", r#"{"name":"lib"}"#);
        write(
            &root,
            "tools/go.mod",
            "module tools\nreplace x => ../../outside\n",
        );
        let p = detect(&root).unwrap();
        let mut pairs: Vec<_> = p
            .links
            .iter()
            .map(|l| (l.source.as_str(), l.target.as_str()))
            .collect();
        pairs.sort_unstable();
        // The root package is never a dependency of its children, a self `-r` adds
        // nothing, and the name match and folder reference make one web link.
        assert_eq!(pairs, [("cronjobs", "backend"), ("web", "lib")]);
        assert!(
            p.links
                .iter()
                .all(|l| l.detection.as_ref().unwrap().detector == "builtin")
        );
        fs::remove_dir_all(root).unwrap();
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
