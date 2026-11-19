//! Images the user pastes or drops into Chat's composer. They live in the
//! plans folder's `attachments/` (`<git-common-dir>/patchbay/plans/attachments/`),
//! never committed and shared by every worktree. Chat leads, planners and root
//! agents are already handed the plans folder, so they can read an image by the
//! path the prompt names, even when they started before it was saved.

use anyhow::{Result, bail};
use std::path::{Path, PathBuf};

/// Largest image Chat saves.
pub const ATTACHMENT_LIMIT: usize = 10 * 1024 * 1024;

/// Saved images older than this are removed when the next one is saved; by then
/// the turn that read them is long finished.
pub const ATTACHMENT_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// The file extension for an image Chat accepts, read from its leading bytes
/// rather than trusting a name or a declared type.
#[must_use]
pub fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// The attachments folder of the repo containing `root`, created if needed.
///
/// # Errors
/// Fails when `root` isn't in a git repo or the folder can't be created.
pub fn dir(root: &Path) -> Result<PathBuf> {
    let dir = crate::plans::dir(root)?.join("attachments");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Save a PNG, JPEG, GIF or WebP image under a fresh name and return its path.
///
/// # Errors
/// Fails for an empty, oversized or unsupported image, or when it can't be written.
pub fn save(root: &Path, bytes: &[u8]) -> Result<PathBuf> {
    if bytes.is_empty() {
        bail!("The image is empty");
    }
    if bytes.len() > ATTACHMENT_LIMIT {
        bail!(
            "Images must be {} MB or smaller",
            ATTACHMENT_LIMIT / (1024 * 1024)
        );
    }
    let Some(extension) = image_extension(bytes) else {
        bail!("Only PNG, JPEG, GIF and WebP images can be attached");
    };
    let dir = dir(root)?;
    prune(&dir, ATTACHMENT_RETENTION);
    let file = dir.join(format!("{}.{extension}", uuid::Uuid::new_v4()));
    crate::workspace::atomic_write(&file, bytes)?;
    Ok(file)
}

/// Best effort: remove images in `dir` last changed more than `age` ago.
fn prune(dir: &Path, age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed > age);
        let image = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ["png", "jpg", "gif", "webp"].contains(&e));
        if old && image {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::{env, fs, process};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n rest";

    fn repo() -> Option<PathBuf> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = env::temp_dir().join(format!(
            "patchbay-attachments-{}-{}",
            process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ok = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-q"])
            .status()
            .is_ok_and(|s| s.success());
        ok.then_some(dir)
    }

    #[test]
    fn images_are_recognised_by_their_bytes() {
        assert_eq!(image_extension(PNG), Some("png"));
        assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(image_extension(b"GIF89a..."), Some("gif"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_extension(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(image_extension(b"<svg/>"), None);
        assert_eq!(image_extension(b""), None);
    }

    #[test]
    fn saved_images_get_unique_names_in_the_plans_folder() {
        let Some(root) = repo() else { return };
        let first = save(&root, PNG).unwrap();
        let second = save(&root, PNG).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.extension().unwrap(), "png");
        assert!(first.starts_with(crate::plans::dir(&root).unwrap()));
        assert_eq!(fs::read(&first).unwrap(), PNG);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saving_removes_images_past_their_retention() {
        let Some(root) = repo() else { return };
        let stale = save(&root, PNG).unwrap();
        let month_ago = std::time::SystemTime::now() - ATTACHMENT_RETENTION * 2;
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(month_ago)
            .unwrap();
        let note = dir(&root).unwrap().join("keep.txt");
        fs::write(&note, "not an image").unwrap();
        let fresh = save(&root, PNG).unwrap();
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(note.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_oversized_and_unsupported_files_are_refused() {
        let Some(root) = repo() else { return };
        assert!(save(&root, b"").is_err());
        assert!(save(&root, b"plain text").is_err());
        let mut big = PNG.to_vec();
        big.resize(ATTACHMENT_LIMIT + 1, 0);
        assert!(save(&root, &big).is_err());
        assert!(!dir(&root).unwrap().read_dir().unwrap().any(|_| true));
        let _ = fs::remove_dir_all(root);
    }
}
