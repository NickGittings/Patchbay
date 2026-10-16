//! Machine-local identities and recovery state; never written into patchbay.json.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const VERSION: u32 = 1;
/// Patchbay's machine-local state folder (`$PATCHBAY_STATE_DIR` or `~/.patchbay`).
///
/// # Errors
/// Fails if `PATCHBAY_STATE_DIR` is relative or there is no home directory.
pub fn home() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("PATCHBAY_STATE_DIR") {
        let dir = PathBuf::from(dir);
        anyhow::ensure!(dir.is_absolute(), "PATCHBAY_STATE_DIR must be absolute");
        return Ok(dir);
    }
    Ok(dirs::home_dir()
        .context("No home directory")?
        .join(".patchbay"))
}

/// Private directories also protect endpoint credentials and captured terminal output.
///
/// # Errors
/// Fails if the folder can't be created, is a symlink or file, or can't be restricted.
pub fn private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        bail!("Invalid private directory: {}", dir.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        let identity = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
            ])
            .output()?;
        anyhow::ensure!(
            identity.status.success(),
            "Cannot determine Windows user SID"
        );
        let sid = String::from_utf8(identity.stdout)?;
        let status = std::process::Command::new("icacls.exe")
            .arg(dir)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("*{}:(OI)(CI)F", sid.trim()),
            ])
            .stdout(std::process::Stdio::null())
            .status()?;
        anyhow::ensure!(status.success(), "Cannot protect private directory");
    }
    Ok(())
}

/// Open (creating) a lock file, owner-only.
///
/// # Errors
/// Fails if the file can't be opened.
pub fn lock(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

/// Write then rename, owner-only, synced to disk.
///
/// # Errors
/// Fails if the parent can't be made private or the write or rename fails.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing parent directory")?;
    private_dir(parent)?;
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// Length-separated UTF-8 input, two independent 64-bit hashes. Treat the result as opaque.
/// Mirrored in types.ts; metadata is always stored separately, never decoded from the id.
#[must_use]
pub fn session_id(project: &str, component: &str, terminal: &str) -> String {
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x8422_2325_cbf2_9ce4;
    for value in [project, component, terminal] {
        let bytes = value.as_bytes();
        for byte in (bytes.len() as u64).to_le_bytes().iter().chain(bytes) {
            a = (a ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3);
            b = (b ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3);
        }
    }
    format!("s-{a:016x}{b:016x}")
}

/// A digest of the saved `patchbay.json`, or `"absent"`, to notice edits made elsewhere.
///
/// # Errors
/// Fails if the file exists but can't be read or isn't UTF-8.
pub fn fingerprint(root: &Path) -> Result<String> {
    match std::fs::read(root.join("patchbay.json")) {
        Ok(bytes) => Ok(session_id("map", "", &String::from_utf8(bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("absent".into()),
        Err(e) => Err(e.into()),
    }
}

/// The stable local identity of the project at `root`, assigned on first use.
///
/// # Errors
/// Fails if the identity store can't be locked, read or written, or `root` doesn't exist.
pub fn project_id(dir: &Path, root: &Path) -> Result<String> {
    private_dir(dir)?;
    let guard = lock(&dir.join("identities.lock"))?;
    guard.lock()?;
    let path = dir.join("identities.json");
    let mut ids: BTreeMap<PathBuf, String> = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        BTreeMap::new()
    };
    let root = root.canonicalize()?;
    let id = ids
        .entry(root)
        .or_insert_with(|| uuid::Uuid::new_v4().to_string())
        .clone();
    atomic_write(&path, &serde_json::to_vec(&ids)?)?;
    Ok(id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<WorkspaceProject>,
    #[serde(default)]
    pub active_project: Option<String>,
    #[serde(default)]
    pub windows: serde_json::Value,
    #[serde(default)]
    pub settings: serde_json::Value,
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: VERSION,
            projects: vec![],
            active_project: None,
            windows: serde_json::Value::Null,
            settings: serde_json::Value::Null,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub root: String,
    pub name: String,
    #[serde(default)]
    pub saved_fingerprint: String,
    #[serde(default)]
    pub draft: Option<crate::Project>,
    #[serde(default)]
    pub layout: serde_json::Value,
}
impl Workspace {
    /// # Errors
    /// Fails if the file can't be read, is invalid, or has another version.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let doc: Self = serde_json::from_slice(&std::fs::read(path)?)
            .context("Invalid workspace; original file retained")?;
        doc.validate()?;
        Ok(doc)
    }
    /// # Errors
    /// Fails on an unsupported version, duplicate or empty ids, relative roots or invalid drafts.
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.version == VERSION,
            "Unsupported workspace version {}",
            self.version
        );
        let mut ids = std::collections::HashSet::new();
        for p in &self.projects {
            anyhow::ensure!(
                !p.id.is_empty() && ids.insert(&p.id),
                "Invalid or duplicate project identity"
            );
            anyhow::ensure!(
                Path::new(&p.root).is_absolute(),
                "Project root must be absolute"
            );
            if let Some(draft) = &p.draft {
                draft.validate()?;
            }
        }
        Ok(())
    }
    /// # Errors
    /// Fails if the document is invalid or can't be written.
    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        atomic_write(path, &serde_json::to_vec(self)?)
    }
}

/// Explicit user relinking preserves the project's local identity at its new root.
///
/// # Errors
/// Fails if the identity store can't be locked, read or written, or `root` doesn't exist.
pub fn relink(dir: &Path, id: &str, root: &Path) -> Result<()> {
    private_dir(dir)?;
    let guard = lock(&dir.join("identities.lock"))?;
    guard.lock()?;
    let path = dir.join("identities.json");
    let mut ids: BTreeMap<PathBuf, String> = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path)?)?
    } else {
        BTreeMap::new()
    };
    ids.retain(|_, existing| existing != id);
    ids.insert(root.canonicalize()?, id.into());
    atomic_write(&path, &serde_json::to_vec(&ids)?)
}

/// A project opened from disk: its saved map (or a detected one) and local identity.
pub struct Loaded {
    pub id: String,
    pub root: PathBuf,
    pub project: crate::Project,
    /// True when no `patchbay.json` existed and the map was detected.
    pub detected: bool,
    pub fingerprint: String,
}

/// Open the project at `root`: its saved map or a detected one, its local
/// identity and the saved map's fingerprint.
///
/// # Errors
/// Fails if `root` doesn't exist, the saved map is invalid, detection fails, or
/// the identity store can't be used.
pub fn load_project(
    root: &Path,
    detectors: &[crate::extensions::DetectorContribution],
) -> Result<Loaded> {
    let root = root.canonicalize()?;
    let (project, detected) = match crate::Project::load(&root)? {
        Some(project) => (project, false),
        None => (crate::detect::detect_with(&root, detectors)?, true),
    };
    let id = project_id(&home()?.join("workspaces"), &root)?;
    let fingerprint = fingerprint(&root)?;
    Ok(Loaded {
        id,
        root,
        project,
        detected,
        fingerprint,
    })
}

/// Restore a workspace entry: the project must still be at its recorded root
/// under the same identity, or the user has to locate it explicitly.
///
/// # Errors
/// As for `load_project`, or if the folder now belongs to another identity.
pub fn restore_project(
    entry: &WorkspaceProject,
    detectors: &[crate::extensions::DetectorContribution],
) -> Result<Loaded> {
    let loaded = load_project(Path::new(&entry.root), detectors)?;
    anyhow::ensure!(
        loaded.id == entry.id,
        "Project identity changed; locate its folder explicitly"
    );
    Ok(loaded)
}

/// Point workspace entry `id` at the folder the user located, keeping its identity.
///
/// # Errors
/// Fails if `id` isn't in `workspace`, the folder is another open project, or
/// the identity store can't be updated.
pub fn relink_project(workspace: &Workspace, id: &str, chosen: &Loaded) -> Result<()> {
    anyhow::ensure!(
        workspace.projects.iter().any(|p| p.id == id),
        "Unknown unavailable project"
    );
    anyhow::ensure!(
        chosen.id == id || !workspace.projects.iter().any(|p| p.id == chosen.id),
        "That folder is already another open project. Select its tab instead."
    );
    relink(&home()?.join("workspaces"), id, &chosen.root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_isolate_worktrees_and_slashes() {
        assert_ne!(session_id("a", "x/y", "z"), session_id("a", "x", "y/z"));
        assert_ne!(session_id("a", "x", "shell"), session_id("b", "x", "shell"));
        assert_eq!(
            session_id("a", "x", "shell"),
            "s-0e178a53a901740b2d3a424757a0e01c"
        );
    }
    /// Pinned in `apps/desktop/src/types.test.ts` too: the frontend hashes the same ids.
    #[test]
    fn session_ids_match_the_frontend() {
        assert_eq!(
            session_id("p-1", "web", "dev"),
            "s-d17ed5ac1fb0a47bcad00e0ba048bc44"
        );
        assert_eq!(
            crate::model::task_session_id("p-1", "web", "dev", Some("abc123")),
            "s-1fd83100e66d2b3b3496518fcb3a11f0"
        );
        assert_eq!(session_id("", "", ""), "s-81d23fd7003c2305f25b4ea0b7d9da64");
        assert_eq!(
            session_id("p-1", "ünï", "dev"),
            "s-63e96d0c28b3d68802aa56d2aaa35d63"
        );
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn identities_follow_folders_and_relinking() {
        let dir = scratch();
        let state = dir.join("state");
        let (one, two, moved) = (dir.join("one"), dir.join("two"), dir.join("moved"));
        for folder in [&one, &two, &moved] {
            std::fs::create_dir(folder).unwrap();
        }
        let first = project_id(&state, &one).unwrap();
        assert_ne!(first, project_id(&state, &two).unwrap());
        // The same folder through a non-canonical path keeps its identity.
        assert_eq!(first, project_id(&state, &one.join("../one")).unwrap());
        relink(&state, &first, &moved).unwrap();
        assert_eq!(first, project_id(&state, &moved).unwrap());
        assert_ne!(first, project_id(&state, &one).unwrap());
        assert!(project_id(&state, &dir.join("missing")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn workspace_settings_round_trip_and_legacy_default() {
        let dir = scratch();
        let path = dir.join("workspace.json");
        atomic_write(&path, br#"{"version":1,"projects":[],"windows":{}}"#).unwrap();
        let mut doc = Workspace::load(&path).unwrap();
        assert!(doc.settings.is_null());
        doc.settings = serde_json::json!({"notifications": {"enabled": false}, "future": 42});
        doc.save(&path).unwrap();
        assert_eq!(Workspace::load(&path).unwrap().settings, doc.settings);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn workspaces_round_trip_and_reject_invalid_entries() {
        let dir = scratch();
        let path = dir.join("workspace.json");
        let entry = |id: &str, root: &str| WorkspaceProject {
            id: id.into(),
            root: root.into(),
            name: "Shop".into(),
            saved_fingerprint: "absent".into(),
            draft: None,
            layout: serde_json::json!({ "zoom": 2 }),
        };
        let root = dir.to_string_lossy().into_owned();
        let doc = Workspace {
            projects: vec![entry("a", &root), entry("b", &root)],
            active_project: Some("b".into()),
            ..Workspace::default()
        };
        doc.save(&path).unwrap();
        let loaded = Workspace::load(&path).unwrap();
        assert_eq!(loaded.active_project.as_deref(), Some("b"));
        assert_eq!(loaded.projects[0].layout["zoom"], 2);

        for projects in [
            vec![entry("a", &root), entry("a", &root)],
            vec![entry("", &root)],
            vec![entry("a", "relative/root")],
        ] {
            let bad = Workspace {
                projects,
                ..Workspace::default()
            };
            assert!(bad.save(&path).is_err());
        }
        // A rejected save leaves the previous document in place.
        assert_eq!(Workspace::load(&path).unwrap().projects.len(), 2);
        // A missing file is an empty workspace; an unreadable one is an error, kept on disk.
        assert!(
            Workspace::load(&dir.join("none.json"))
                .unwrap()
                .projects
                .is_empty()
        );
        atomic_write(&path, b"{not json").unwrap();
        assert!(Workspace::load(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{not json");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_recovery_and_conflicts() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        private_dir(&dir).unwrap();
        let id = project_id(&dir.join("state"), &dir).unwrap();
        assert_eq!(id, project_id(&dir.join("state"), &dir).unwrap());
        let before = fingerprint(&dir).unwrap();
        atomic_write(&dir.join("patchbay.json"), b"{}").unwrap();
        assert_ne!(before, fingerprint(&dir).unwrap());
        let path = dir.join("workspace.json");
        Workspace::default().save(&path).unwrap();
        assert!(Workspace::load(&path).unwrap().projects.is_empty());
        atomic_write(&path, br#"{"version":999}"#).unwrap();
        assert!(Workspace::load(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
