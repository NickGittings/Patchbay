//! Read-only directory listings contained within a project folder.

use crate::detect::SKIP_DIRS;
use anyhow::{Result, bail};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Relative to the listing root, even when the requested directory is a symlink.
    pub path: String,
    pub is_dir: bool,
}

/// List a directory, hiding generated folders and Git internals.
///
/// # Errors
/// Fails on inaccessible directories or paths resolving outside `root`.
pub fn list_dir(root: &Path, rel: &Path) -> Result<Vec<DirEntry>> {
    let root = root.canonicalize()?;
    let dir = root.join(rel).canonicalize()?;
    if !dir.starts_with(&root) {
        bail!("Directory is outside the project root");
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        // Also exclude symlinks to folders/files outside the root.
        let Ok(resolved) = entry.path().canonicalize() else {
            continue;
        };
        if !resolved.starts_with(&root) {
            continue;
        }
        let is_dir = resolved.is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: entry
                .path()
                .strip_prefix(&root)?
                .to_string_lossy()
                .replace('\\', "/"),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "patchbay-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sorts_directories_first_and_names_case_insensitively() {
        let fixture = Fixture::new();
        for name in ["Zoo", "alpha"] {
            std::fs::create_dir(fixture.0.join(name)).unwrap();
        }
        for name in ["b.txt", "A.txt", ".env"] {
            std::fs::write(fixture.0.join(name), "").unwrap();
        }
        let entries = list_dir(&fixture.0, Path::new(".")).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["alpha", "Zoo", ".env", "A.txt", "b.txt"]
        );
        assert!(entries[0].is_dir);
        assert_eq!(entries[3].path, "A.txt");
    }

    #[test]
    fn hides_git_and_generated_folders_but_keeps_dotfiles() {
        let fixture = Fixture::new();
        for name in SKIP_DIRS.iter().copied().chain([".git", ".config"]) {
            std::fs::create_dir(fixture.0.join(name)).unwrap();
        }
        std::fs::write(fixture.0.join(".env"), "").unwrap();
        let entries = list_dir(&fixture.0, Path::new(".")).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            [".config", ".env"]
        );
        std::fs::remove_dir(fixture.0.join(".git")).unwrap();
        std::fs::write(fixture.0.join(".git"), "gitdir: elsewhere").unwrap();
        assert_eq!(list_dir(&fixture.0, Path::new(".")).unwrap().len(), 2);
    }

    #[test]
    fn rejects_parent_and_absolute_escapes() {
        let fixture = Fixture::new();
        assert!(list_dir(&fixture.0, Path::new("..")).is_err());
        assert!(list_dir(&fixture.0, &std::env::temp_dir()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        let fixture = Fixture::new();
        std::os::unix::fs::symlink(std::env::temp_dir(), fixture.0.join("escape")).unwrap();
        assert!(list_dir(&fixture.0, Path::new("escape")).is_err());
        assert!(list_dir(&fixture.0, Path::new(".")).unwrap().is_empty());
    }
}
