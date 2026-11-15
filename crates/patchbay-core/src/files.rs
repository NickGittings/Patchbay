//! Directory listings and bounded text editing contained within a project's folders: the
//! project root plus any repos on the map that live outside it.

use crate::model::{plain_path, relative_path};
use anyhow::{Result, bail};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Relative to the project root (`roots[0]`), even when the requested
    /// directory is a symlink; starts with `../` inside an external repo.
    pub path: String,
    pub is_dir: bool,
}

/// The roots, project root first, without folders inside another root. Roots
/// must already be canonical (the app resolves them once, when they are
/// granted) and are not resolved again: if one is later replaced by a symlink,
/// paths under it resolve elsewhere and fail the containment check instead of
/// following the link. A missing root (a sibling repo not cloned here) simply
/// matches nothing.
fn canonical_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let Some((root, extra)) = roots.split_first() else {
        bail!("No project is open");
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in extra {
        if dir.starts_with(root) || inside(dir, &out) {
            continue;
        }
        out.retain(|r| !r.starts_with(dir));
        out.push(dir.clone());
    }
    out.insert(0, root.clone());
    Ok(out)
}

fn inside(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| path.starts_with(r))
}

/// Resolve `rel` against the project root (`roots[0]`), following symlinks, and
/// require the result to stay inside one of `roots` (which must be canonical).
///
/// # Errors
/// Fails if a path does not exist or `rel` resolves outside every root.
pub fn resolve(roots: &[PathBuf], rel: &Path) -> Result<PathBuf> {
    resolve_in(&canonical_roots(roots)?, rel)
}

/// The absolute path [`resolve`] finds for `rel`, with `/` separators and without Windows'
/// verbatim prefix, for showing or copying.
///
/// # Errors
/// Fails like [`resolve`].
pub fn absolute(roots: &[PathBuf], rel: &Path) -> Result<String> {
    Ok(plain_path(&resolve(roots, rel)?.to_string_lossy()))
}

/// [`resolve`] against roots already passed through `canonical_roots`.
fn resolve_in(roots: &[PathBuf], rel: &Path) -> Result<PathBuf> {
    let path = roots[0].join(rel).canonicalize()?;
    if !inside(&path, roots) {
        bail!("Path is outside the project (pick folders beside it with Browse… or Add repo…)");
    }
    Ok(path)
}

/// List a directory, hiding only Git internals: unlike detection, a file browser
/// should show `build/`, `vendor/` and the like.
///
/// # Errors
/// Fails on inaccessible directories or paths resolving outside every root.
pub fn list_dir(roots: &[PathBuf], rel: &Path) -> Result<Vec<DirEntry>> {
    let roots = canonical_roots(roots)?;
    let dir = resolve_in(&roots, rel)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let file_type = entry.file_type()?;
        // Only symlinks can leave the roots; resolve those and hide any that escape.
        let is_dir = if file_type.is_symlink() {
            let Ok(resolved) = entry.path().canonicalize() else {
                continue;
            };
            if !inside(&resolved, &roots) {
                continue;
            }
            resolved.is_dir()
        } else {
            file_type.is_dir()
        };
        entries.push(DirEntry {
            name,
            path: relative_path(&roots[0], &entry.path()),
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::{env, fs, process};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = env::temp_dir().join(format!(
                "patchbay-files-{}-{}",
                process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Fixture {
        /// The fixture folder as the only root.
        fn roots(&self) -> &[PathBuf] {
            std::slice::from_ref(&self.0)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn text_save_preserves_line_endings_and_rejects_conflicts() {
        let fixture = Fixture::new();
        let path = fixture.0.join("text.txt");
        fs::write(&path, "first\r\nsecond\r\n").unwrap();
        let file = read_text(fixture.roots(), &path).unwrap();
        assert_eq!(file.text, "first\r\nsecond\r\n");
        let saved = save_text(fixture.roots(), &path, "new\r\n", &file.fingerprint).unwrap();
        assert_eq!(saved.text, "new\r\n");
        fs::write(&path, "external").unwrap();
        assert!(save_text(fixture.roots(), &path, "draft", &saved.fingerprint).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    }

    #[test]
    fn text_reads_reject_unsupported_content_and_escapes() {
        let fixture = Fixture::new();
        let path = fixture.0.join("text.txt");
        for bytes in [
            vec![0],
            vec![0xff],
            vec![b'x'; usize::try_from(MAX_TEXT_BYTES).unwrap() + 1],
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_text(fixture.roots(), &path).is_err());
        }
        assert!(read_text(fixture.roots(), Path::new("../outside.txt")).is_err());
        assert!(read_text(fixture.roots(), &fixture.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn text_save_preserves_permissions_and_rejects_symlink_escapes() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let path = fixture.0.join("script");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let file = read_text(fixture.roots(), &path).unwrap();
        save_text(fixture.roots(), &path, "updated", &file.fingerprint).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let external = outside.0.join("secret");
        fs::write(&external, "secret").unwrap();
        symlink(&external, fixture.0.join("escape")).unwrap();
        assert!(read_text(fixture.roots(), Path::new("escape")).is_err());
        assert!(save_text(fixture.roots(), Path::new("escape"), "draft", "anything").is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "secret");
    }

    #[test]
    fn sorts_directories_first_and_names_case_insensitively() {
        let fixture = Fixture::new();
        for name in ["Zoo", "alpha"] {
            fs::create_dir(fixture.0.join(name)).unwrap();
        }
        for name in ["b.txt", "A.txt", ".env"] {
            fs::write(fixture.0.join(name), "").unwrap();
        }
        let entries = list_dir(fixture.roots(), Path::new(".")).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["alpha", "Zoo", ".env", "A.txt", "b.txt"]
        );
        assert!(entries[0].is_dir);
        assert_eq!(entries[3].path, "A.txt");
    }

    #[test]
    fn hides_only_git_and_keeps_dotfiles_and_build_folders() {
        let fixture = Fixture::new();
        for name in [".git", ".config", "build", "vendor"] {
            fs::create_dir(fixture.0.join(name)).unwrap();
        }
        fs::write(fixture.0.join(".env"), "").unwrap();
        let entries = list_dir(fixture.roots(), Path::new(".")).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            [".config", "build", "vendor", ".env"]
        );
        fs::remove_dir(fixture.0.join(".git")).unwrap();
        fs::write(fixture.0.join(".git"), "gitdir: elsewhere").unwrap();
        assert_eq!(list_dir(fixture.roots(), Path::new(".")).unwrap().len(), 4);
    }

    #[test]
    fn rejects_parent_and_absolute_escapes() {
        let fixture = Fixture::new();
        assert!(list_dir(fixture.roots(), Path::new("..")).is_err());
        assert!(list_dir(fixture.roots(), &env::temp_dir()).is_err());
        assert!(resolve(fixture.roots(), Path::new("..")).is_err());
        assert_eq!(resolve(fixture.roots(), Path::new(".")).unwrap(), fixture.0);
    }

    #[test]
    fn absolute_paths_stay_inside_the_roots() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("app")).unwrap();
        let root = plain_path(&fixture.0.to_string_lossy());
        assert_eq!(
            absolute(fixture.roots(), Path::new("app")).unwrap(),
            format!("{root}/app")
        );
        assert!(absolute(fixture.roots(), Path::new("..")).is_err());
        assert!(absolute(fixture.roots(), Path::new("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_root_replaced_by_a_symlink_is_not_followed() {
        let fixture = Fixture::new();
        let project = fixture.0.join("shop");
        let billing = fixture.0.join("billing");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(fixture.0.join("secret/keys")).unwrap();
        std::os::unix::fs::symlink(fixture.0.join("secret"), &billing).unwrap();
        let roots = [project, billing];
        assert!(list_dir(&roots, Path::new("../billing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        symlink(env::temp_dir(), fixture.0.join("escape")).unwrap();
        fs::create_dir(fixture.0.join("inside")).unwrap();
        symlink(fixture.0.join("inside"), fixture.0.join("link")).unwrap();
        assert!(list_dir(fixture.roots(), Path::new("escape")).is_err());
        let entries = list_dir(fixture.roots(), Path::new(".")).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.name.as_str(), e.is_dir))
                .collect::<Vec<_>>(),
            [("inside", true), ("link", true)]
        );
    }

    #[test]
    fn lists_extra_roots_with_paths_relative_to_the_project() {
        let fixture = Fixture::new();
        let project = fixture.0.join("shop");
        let billing = fixture.0.join("billing");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(billing.join("src")).unwrap();
        let roots = [project.clone(), billing];
        let entries = list_dir(&roots, Path::new("../billing")).unwrap();
        assert_eq!(entries[0].path, "../billing/src");
        assert!(list_dir(&roots[..1], Path::new("../billing")).is_err());
        assert!(list_dir(&roots, Path::new("..")).is_err());
    }

    #[test]
    fn missing_external_roots_are_skipped() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("src")).unwrap();
        let roots = [
            fixture.0.clone(),
            fixture.0.join("../patchbay-no-such-repo"),
        ];
        assert_eq!(list_dir(&roots, Path::new(".")).unwrap().len(), 1);
        assert!(resolve(&roots, Path::new("src")).is_ok());
        assert!(list_dir(&[fixture.0.join("missing")], Path::new(".")).is_err());
    }

    #[test]
    fn nested_roots_are_deduplicated() {
        let fixture = Fixture::new();
        let billing = fixture.0.join("billing");
        fs::create_dir_all(billing.join("api")).unwrap();
        fs::create_dir_all(fixture.0.join("shop")).unwrap();
        let roots = canonical_roots(&[
            fixture.0.join("shop"),
            billing.join("api"),
            billing.clone(),
            billing.join("api"),
        ])
        .unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[1], billing);
    }
}

/// Maximum editable text size; never return a truncated document.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub text: String,
    pub fingerprint: String,
}

fn text_fingerprint(bytes: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

/// Read a complete bounded UTF-8 file inside the granted roots.
/// # Errors
/// Rejects directories, binary text, oversized files and paths outside the roots.
pub fn read_text(roots: &[PathBuf], path: &Path) -> Result<TextFile> {
    use std::io::Read;
    let path = resolve(roots, path)?;
    let file = std::fs::File::open(&path)?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "This is a folder; open it in an external editor"
    );
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_TEXT_BYTES,
        "Files larger than 2 MiB must be opened externally"
    );
    anyhow::ensure!(
        !bytes.contains(&0),
        "Binary files must be opened externally"
    );
    let fingerprint = text_fingerprint(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("Only UTF-8 text can be edited here"))?;
    Ok(TextFile {
        path: plain_path(&path.to_string_lossy()),
        text,
        fingerprint,
    })
}

/// Save a draft only while the file still matches its read fingerprint.
/// # Errors
/// Fails on conflicts, invalid paths, oversized drafts or filesystem errors.
pub fn save_text(roots: &[PathBuf], path: &Path, text: &str, expected: &str) -> Result<TextFile> {
    use std::io::Write;
    static SAVES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _save = SAVES
        .lock()
        .map_err(|_| anyhow::anyhow!("File save lock unavailable"))?;
    anyhow::ensure!(
        text.len() as u64 <= MAX_TEXT_BYTES && !text.contains('\0'),
        "Draft is too large or contains binary data"
    );
    let current = read_text(roots, path)?;
    anyhow::ensure!(
        current.fingerprint == expected,
        "File changed on disk. Reload before saving to avoid overwriting changes."
    );
    let path = resolve(roots, path)?;
    let permissions = std::fs::metadata(&path)?.permissions();
    anyhow::ensure!(!permissions.readonly(), "File is read-only");
    let temporary = path.with_file_name(format!(".patchbay-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.set_permissions(permissions)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        anyhow::ensure!(
            read_text(roots, &path)?.fingerprint == expected,
            "File changed on disk. Reload before saving."
        );
        std::fs::rename(&temporary, &path)?;
        read_text(roots, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
