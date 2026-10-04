//! Local extension manifests and declarative contributions. Loading never executes code.
use crate::{
    Component, ComponentKind, Project, TerminalKind, TerminalSpec, context::ContextSection,
    devices::DeviceManifest, files,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub name: String,
    pub publisher: String,
    pub version: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub engines: Engines,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub activation_events: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Engines {
    pub patchbay: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub devices: Vec<DeviceManifest>,
    #[serde(default)]
    pub detectors: Vec<DetectorContribution>,
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub menus: HashMap<String, Vec<MenuContribution>>,
    #[serde(default)]
    pub context: Vec<ContextContribution>,
    #[serde(default)]
    pub views: Vec<ViewContribution>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorContribution {
    pub id: String,
    pub files: Vec<String>,
    pub kind: ComponentKind,
    #[serde(default)]
    pub terminals: Vec<TerminalSpec>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub run: Option<RunSpec>,
    #[serde(default)]
    pub when: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpec {
    pub command: String,
    #[serde(default = "task_kind")]
    pub kind: TerminalKind,
}
fn task_kind() -> TerminalKind {
    TerminalKind::Task
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuContribution {
    pub command: String,
    #[serde(default)]
    pub when: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextContribution {
    pub title: String,
    pub file: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    pub title: String,
    pub location: ViewLocation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewLocation {
    Inspector,
    Dock,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    pub id: String,
    pub dir: PathBuf,
    pub manifest: ExtensionManifest,
    pub enabled: bool,
    pub errors: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub extensions: Vec<Extension>,
    pub errors: Vec<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    disabled: HashSet<String>,
}

#[must_use]
pub fn user_extensions_dir() -> Option<PathBuf> {
    std::env::var_os("PATCHBAY_EXTENSIONS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".patchbay/extensions")))
}
fn settings_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join(".patchbay/extensions.json"))
}
fn valid_part(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
fn relative(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('\\')
        && Path::new(s)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Validate one folder without trusting its entry point or reading outside it.
/// # Errors
/// Fails for an invalid or incompatible manifest.
pub fn validate(dir: &Path) -> Result<ExtensionManifest> {
    let manifest: ExtensionManifest =
        serde_json::from_str(&std::fs::read_to_string(dir.join("package.json"))?)?;
    if !valid_part(&manifest.name) || !valid_part(&manifest.publisher) {
        bail!("name and publisher must contain lowercase letters, digits or hyphens");
    }
    semver::Version::parse(&manifest.version).context("invalid version")?;
    let requirement = semver::VersionReq::parse(&manifest.engines.patchbay)
        .context("invalid engines.patchbay")?;
    if !requirement.matches(&semver::Version::parse(env!("CARGO_PKG_VERSION"))?) {
        bail!(
            "engines.patchbay {} does not support Patchbay {}",
            manifest.engines.patchbay,
            env!("CARGO_PKG_VERSION")
        );
    }
    if let Some(main) = &manifest.main {
        if !relative(main) {
            bail!("main must be relative to the extension");
        }
        resolve_asset(dir, main)?;
    }
    for permission in &manifest.permissions {
        if !["terminals", "project:read", "files:read"].contains(&permission.as_str()) {
            bail!("unknown permission {permission}");
        }
    }
    let c = &manifest.contributes;
    for list in [
        c.devices.iter().map(|d| &d.id).collect::<Vec<_>>(),
        c.detectors.iter().map(|d| &d.id).collect(),
        c.commands.iter().map(|d| &d.id).collect(),
        c.views.iter().map(|d| &d.id).collect(),
    ] {
        let mut seen = HashSet::new();
        for id in list {
            if !valid_id(id) || !seen.insert(id) {
                bail!("invalid or duplicate contribution id {id}");
            }
        }
    }
    for detector in &c.detectors {
        if detector.files.is_empty() || detector.files.iter().any(|f| !relative(f)) {
            bail!("detector {} needs relative file names", detector.id);
        }
        let mut seen = HashSet::new();
        for terminal in &detector.terminals {
            if !valid_id(&terminal.id)
                || ["shell", "claude"].contains(&terminal.id.as_str())
                || !seen.insert(&terminal.id)
            {
                bail!("invalid or duplicate detector terminal {}", terminal.id);
            }
        }
    }
    if c.context.iter().any(|section| !relative(&section.file)) {
        bail!("context files must be relative to the component");
    }
    for (slot, menus) in &c.menus {
        if !["component/actions", "toolbar"].contains(&slot.as_str()) {
            bail!("unknown menu slot {slot}");
        }
        for menu in menus {
            if !c.commands.iter().any(|command| command.id == menu.command) {
                bail!("menu references unknown command {}", menu.command);
            }
        }
    }
    if manifest.main.is_none()
        && (c.commands.iter().any(|c| c.run.is_none()) || !c.views.is_empty())
    {
        // Declarative views are placeholders until code is supplied; code commands cannot run.
        if c.commands.iter().any(|c| c.run.is_none()) {
            bail!("code commands require main");
        }
    }
    for event in &manifest.activation_events {
        if !["onStartup", "onProjectOpen"].contains(&event.as_str())
            && !event.starts_with("onCommand:")
            && !event.starts_with("onView:")
            && !event
                .strip_prefix("workspaceContains:")
                .is_some_and(relative)
        {
            bail!("unknown activation event {event}");
        }
    }
    Ok(manifest)
}

/// Resolve an extension asset, rejecting traversal and symlink escapes.
/// # Errors
/// Fails for a missing file or a path outside the extension.
pub fn resolve_asset(dir: &Path, path: &str) -> Result<PathBuf> {
    if !relative(path) {
        bail!("invalid extension asset path");
    }
    let root = dir.canonicalize()?;
    let file = root.join(path).canonicalize()?;
    if !file.starts_with(&root) || !file.is_file() {
        bail!("asset outside extension or not a file");
    }
    Ok(file)
}

/// Read each child independently; broken extensions remain visible with errors.
#[must_use]
pub fn load_from(dir: &Path, disabled: &HashSet<String>) -> Registry {
    let mut registry = Registry::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                registry.errors.push(e.to_string());
            }
            return registry;
        }
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && !p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .starts_with(".install-")
        })
        .collect();
    paths.sort();
    let mut ids = HashSet::new();
    let mut contributed = HashSet::new();
    for dir in paths {
        let parsed = serde_json::from_str::<ExtensionManifest>(
            &std::fs::read_to_string(dir.join("package.json")).unwrap_or_default(),
        )
        .ok();
        let mut extension = Extension {
            id: parsed.as_ref().map_or_else(
                || {
                    dir.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                },
                |m| format!("{}.{}", m.publisher, m.name),
            ),
            dir: dir.clone(),
            manifest: parsed.unwrap_or_default(),
            enabled: false,
            errors: vec![],
        };
        match validate(&dir) {
            Ok(manifest) => {
                extension.manifest = manifest;
                if !ids.insert(extension.id.clone()) {
                    extension
                        .errors
                        .push(format!("duplicate extension id {}", extension.id));
                }
                let c = &extension.manifest.contributes;
                let keys: Vec<_> = c
                    .devices
                    .iter()
                    .map(|d| ("device", d.id.clone()))
                    .chain(c.detectors.iter().map(|d| ("detector", d.id.clone())))
                    .chain(c.commands.iter().map(|d| ("command", d.id.clone())))
                    .chain(c.views.iter().map(|d| ("view", d.id.clone())))
                    .collect();
                for key in &keys {
                    if contributed.contains(key) {
                        extension
                            .errors
                            .push(format!("duplicate {} id {}", key.0, key.1));
                    }
                }
                if extension.errors.is_empty() {
                    contributed.extend(keys);
                    extension.enabled = !disabled.contains(&extension.id);
                }
            }
            Err(error) => extension.errors.push(format!("{error:#}")),
        }
        registry.extensions.push(extension);
    }
    registry
}
fn persist_enabled(path: &Path, id: &str, enabled: bool) -> Result<()> {
    let mut settings: Settings = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => return Err(e.into()),
    };
    if enabled {
        settings.disabled.remove(id);
    } else {
        settings.disabled.insert(id.into());
    }
    std::fs::create_dir_all(path.parent().context("missing settings parent")?)?;
    std::fs::write(path, serde_json::to_vec_pretty(&settings)?)?;
    Ok(())
}

impl Registry {
    #[must_use]
    pub fn load() -> Self {
        let mut errors = vec![];
        let settings = settings_path()
            .and_then(|p| match std::fs::read_to_string(p) {
                Ok(s) => Ok(serde_json::from_str::<Settings>(&s)?),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
                Err(e) => Err(e.into()),
            })
            .unwrap_or_else(|e| {
                errors.push(format!("extension settings: {e}"));
                Settings::default()
            });
        let mut registry = user_extensions_dir()
            .map_or_else(Self::default, |dir| load_from(&dir, &settings.disabled));
        registry.errors.extend(errors);
        registry
    }
    pub fn active(&self) -> impl Iterator<Item = &Extension> {
        self.extensions
            .iter()
            .filter(|e| e.enabled && e.errors.is_empty())
    }
    #[must_use]
    pub fn devices(&self) -> Vec<DeviceManifest> {
        self.active()
            .flat_map(|e| {
                e.manifest.contributes.devices.iter().cloned().map(|mut d| {
                    d.source = format!("extension:{}", e.id);
                    d
                })
            })
            .collect()
    }
    #[must_use]
    pub fn detectors(&self) -> Vec<DetectorContribution> {
        self.active()
            .flat_map(|e| e.manifest.contributes.detectors.clone())
            .collect()
    }
    #[must_use]
    pub fn commands(&self) -> Vec<CommandContribution> {
        self.active()
            .flat_map(|e| e.manifest.contributes.commands.clone())
            .collect()
    }
    #[must_use]
    pub fn context_for(&self, _component: &Component) -> Vec<ContextContribution> {
        self.active()
            .flat_map(|e| e.manifest.contributes.context.clone())
            .collect()
    }
    /// Persist enabled state, then reload. Invalid extensions cannot be enabled.
    /// # Errors
    /// Fails for unknown/invalid extensions or settings I/O.
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<()> {
        let extension = self
            .extensions
            .iter()
            .find(|e| e.id == id)
            .context("unknown extension")?;
        if enabled && !extension.errors.is_empty() {
            bail!("extension is invalid");
        }
        let path = settings_path()?;
        persist_enabled(&path, id, enabled)?;
        *self = Self::load();
        Ok(())
    }
    /// File context is read through the same canonical roots as the file tree.
    #[must_use]
    pub fn file_sections(
        &self,
        project: &Project,
        ids: &[String],
        roots: &[PathBuf],
    ) -> Vec<ContextSection> {
        project
            .components
            .iter()
            .filter(|c| ids.is_empty() || ids.contains(&c.id))
            .flat_map(|c| {
                self.context_for(c)
                    .into_iter()
                    .filter_map(|section| {
                        let rel = Path::new(&c.path).join(&section.file);
                        let body = read_file(roots, &rel).ok()?;
                        Some(ContextSection {
                            title: format!("{} — {}", section.title, c.name),
                            body,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}
/// Read at most 32 KiB from an allowed file.
/// # Errors
/// Fails for inaccessible files or paths outside the allowed roots.
pub fn read_file(roots: &[PathBuf], rel: &Path) -> Result<String> {
    let file = files::resolve(roots, rel)?;
    let mut bytes = vec![];
    std::fs::File::open(file)?
        .take(32 * 1024)
        .read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
/// Copy a validated local folder into the user registry without overwriting installs.
/// # Errors
/// Fails on invalid manifests, symlinks, conflicting installs or I/O.
pub fn install(source: &Path, destination: &Path) -> Result<String> {
    let manifest = validate(source)?;
    let id = format!("{}.{}", manifest.publisher, manifest.name);
    std::fs::create_dir_all(destination)?;
    let source = source.canonicalize()?;
    let destination = destination.canonicalize()?;
    if destination.starts_with(&source) {
        bail!("extension folder contains the install directory");
    }
    let target = destination.join(&id);
    if target.exists() {
        bail!("extension {id} is already installed");
    }
    fn copy(source: &Path, target: &Path, depth: usize, size: &mut u64) -> Result<()> {
        if depth > 64 {
            bail!("extension folder is too deep");
        }
        if depth > 0 {
            std::fs::create_dir(target)?;
        }
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                bail!("extension installs cannot contain symlinks");
            }
            let to = target.join(entry.file_name());
            if kind.is_dir() {
                copy(&entry.path(), &to, depth + 1, size)?;
            } else if kind.is_file() {
                *size += entry.metadata()?.len();
                if *size > 128 * 1024 * 1024 {
                    bail!("extension exceeds 128 MiB");
                }
                std::fs::copy(entry.path(), to)?;
            } else {
                bail!("extension contains a special file");
            }
        }
        Ok(())
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let staging = destination.join(format!(
        ".install-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir(&staging)?;
    let result = (|| {
        copy(&source, &staging, 0, &mut 0)?;
        validate(&staging)?;
        std::fs::rename(&staging, &target)?;
        Ok(id)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "patchbay-ext-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn manifest(&self, folder: &str, extra: serde_json::Value) -> PathBuf {
            let dir = self.0.join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            let mut manifest = serde_json::json!({"name":"docker", "publisher":"acme", "version":"0.1.0", "engines":{"patchbay":"^0.1.0"}});
            for (key, value) in extra.as_object().unwrap() {
                manifest[key] = value.clone();
            }
            std::fs::write(
                dir.join("package.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            dir
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn parses_contributions_and_isolates_bad_extensions() {
        let f = Fixture::new();
        f.manifest("good", serde_json::json!({"contributes": {"devices":[{"id":"compose-logs","name":"Logs","command":"docker compose logs","kind":"task"}], "detectors":[{"id":"compose","files":["compose.yaml"],"kind":"service"}], "commands":[{"id":"acme.docker.up","title":"Up","run":{"command":"docker compose up"}}], "menus":{"component/actions":[{"command":"acme.docker.up","when":"component.kind == 'service'"}]}, "context":[{"title":"Services","file":"compose.yaml"}],"views":[{"id":"acme.docker.panel","title":"Containers","location":"inspector"}]}}));
        std::fs::create_dir(f.0.join("broken")).unwrap();
        std::fs::write(f.0.join("broken/package.json"), "{").unwrap();
        let registry = load_from(&f.0, &HashSet::new());
        assert_eq!(registry.active().count(), 1);
        assert_eq!(registry.extensions.len(), 2);
        assert!(!registry.extensions[0].errors.is_empty());
        assert_eq!(registry.devices()[0].source, "extension:acme.docker");
        assert_eq!(
            registry.commands()[0].run.as_ref().unwrap().kind,
            TerminalKind::Task
        );
        assert_eq!(registry.detectors().len(), 1);
    }
    #[test]
    fn rejects_engine_mismatch_bad_ids_paths_and_menu_references() {
        let f = Fixture::new();
        for (folder, extra) in [
            (
                "engine",
                serde_json::json!({"engines":{"patchbay":"^99.0.0"}}),
            ),
            ("id", serde_json::json!({"publisher":"../evil"})),
            (
                "file",
                serde_json::json!({"contributes":{"context":[{"title":"Secrets","file":"../secret"}]}}),
            ),
            (
                "menu",
                serde_json::json!({"contributes":{"menus":{"toolbar":[{"command":"unknown"}]}}}),
            ),
            (
                "detector",
                serde_json::json!({"contributes":{"detectors":[{"id":"x","kind":"other","files":["/secret"]}]}}),
            ),
            (
                "code",
                serde_json::json!({"contributes":{"commands":[{"id":"acme.docker.x","title":"X"}]}}),
            ),
        ] {
            let dir = f.manifest(folder, extra);
            assert!(validate(&dir).is_err(), "{folder}");
        }
        assert_eq!(load_from(&f.0, &HashSet::new()).active().count(), 0);
    }
    #[test]
    fn duplicate_extension_and_contribution_ids_are_rejected() {
        let f = Fixture::new();
        let contribution = serde_json::json!({"contributes":{"commands":[{"id":"shared","title":"Shared","run":{"command":"true"}}]}});
        f.manifest("a", contribution.clone());
        f.manifest("b", contribution.clone());
        let mut third = contribution;
        third["name"] = serde_json::json!("other");
        f.manifest("c", third);
        let registry = load_from(&f.0, &HashSet::new());
        assert_eq!(registry.active().count(), 1);
        assert!(
            registry.extensions[1]
                .errors
                .iter()
                .any(|e| e.contains("duplicate extension"))
        );
        assert!(
            registry.extensions[2]
                .errors
                .iter()
                .any(|e| e.contains("duplicate command"))
        );
    }
    #[test]
    fn enabled_state_persists_without_losing_other_disabled_ids() {
        let f = Fixture::new();
        let path = f.0.join("settings/extensions.json");
        persist_enabled(&path, "acme.docker", false).unwrap();
        persist_enabled(&path, "acme.other", false).unwrap();
        persist_enabled(&path, "acme.docker", true).unwrap();
        let settings: Settings = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(settings.disabled, HashSet::from(["acme.other".into()]));
        std::fs::write(&path, "invalid").unwrap();
        assert!(persist_enabled(&path, "acme.docker", false).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid");
    }

    #[test]
    fn disabled_extensions_do_not_contribute() {
        let f = Fixture::new();
        f.manifest("a", serde_json::json!({"contributes":{"devices":[{"id":"shell","name":"Replacement"}],"detectors":[{"id":"compose","files":["compose.yaml"],"kind":"service"}],"commands":[{"id":"x","title":"X","run":{"command":"true"}}],"context":[{"title":"X","file":"compose.yaml"}]}}));
        let registry = load_from(&f.0, &HashSet::from(["acme.docker".into()]));
        assert!(registry.extensions[0].errors.is_empty());
        assert!(registry.devices().is_empty());
        assert!(registry.commands().is_empty());
        assert!(registry.detectors().is_empty());
    }
    #[test]
    fn context_files_are_capped_and_cannot_escape_roots() {
        let f = Fixture::new();
        f.manifest("ext", serde_json::json!({"contributes":{"context":[{"title":"Services","file":"compose.yaml"}]}}));
        let registry = load_from(&f.0, &HashSet::new());
        let root = f.0.join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("compose.yaml"), "x".repeat(65536)).unwrap();
        let project = crate::detect::detect(&root).unwrap();
        let sections = registry.file_sections(&project, &[], std::slice::from_ref(&root));
        assert_eq!(sections[0].body.len(), 32768);
        std::fs::write(f.0.join("secret"), "secret").unwrap();
        assert!(read_file(std::slice::from_ref(&root), Path::new("../secret")).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_file(root.join("compose.yaml")).unwrap();
            std::os::unix::fs::symlink(f.0.join("secret"), root.join("compose.yaml")).unwrap();
            assert!(registry.file_sections(&project, &[], &[root]).is_empty());
        }
    }
    #[test]
    fn asset_resolution_and_install_refuse_escapes() {
        let f = Fixture::new();
        let source = f.manifest("source", serde_json::json!({}));
        std::fs::write(source.join("main.js"), "export function activate() {}").unwrap();
        assert!(resolve_asset(&source, "main.js").is_ok());
        assert!(resolve_asset(&source, "../source/main.js").is_err());
        assert!(resolve_asset(&source, "/etc/passwd").is_err());
        let destination = f.0.join("installed");
        assert_eq!(install(&source, &destination).unwrap(), "acme.docker");
        assert!(install(&source, &destination).is_err());
        assert!(install(&source, &source.join("nested")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                destination.join("acme.docker/package.json"),
                source.join("escape.js"),
            )
            .unwrap();
            assert!(resolve_asset(&source, "escape.js").is_err());
            assert!(install(&source, &f.0.join("other")).is_err());
        }
    }
}
