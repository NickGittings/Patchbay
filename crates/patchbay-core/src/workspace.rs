//! Machine-local identities and recovery state; never written into patchbay.json.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const VERSION: u32 = 1;
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

pub fn fingerprint(root: &Path) -> Result<String> {
    match std::fs::read(root.join("patchbay.json")) {
        Ok(bytes) => Ok(session_id("map", "", &String::from_utf8(bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("absent".into()),
        Err(e) => Err(e.into()),
    }
}

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
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: VERSION,
            projects: vec![],
            active_project: None,
            windows: serde_json::Value::Null,
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
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let doc: Self = serde_json::from_slice(&std::fs::read(path)?)
            .context("Invalid workspace; original file retained")?;
        doc.validate()?;
        Ok(doc)
    }
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
    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        atomic_write(path, &serde_json::to_vec(self)?)
    }
}

/// Explicit user relinking preserves the project's local identity at its new root.
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
