//! Agent submissions awaiting the user's review (dependency and stack detection): one
//! JSON file per project root in a folder of Patchbay's state, so they work outside Git
//! and are never committed. Each has a unique id, so clearing one never removes a newer
//! one.
use anyhow::Result;
use serde::{Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// A submission, known by its unique id.
pub trait Submission: Serialize + DeserializeOwned {
    fn id(&self) -> &str;
}

/// One kind of submission, stored under `~/.patchbay/<kind>/`.
pub struct Store {
    kind: &'static str,
    lock: Mutex<()>,
}

impl Store {
    pub const fn new(kind: &'static str) -> Self {
        Self {
            kind,
            lock: Mutex::new(()),
        }
    }

    /// Held while saving or clearing, so a clear never removes a submission saved meanwhile.
    pub fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// # Errors
    /// Fails without a home folder.
    pub fn dir(&self) -> Result<PathBuf> {
        Ok(crate::workspace::home()?.join(self.kind))
    }

    fn file(&self, dir: &Path, root: &str) -> PathBuf {
        dir.join(format!(
            "{}.json",
            crate::workspace::session_id(self.kind, "", root)
        ))
    }

    /// Replace the submission for `root`; the caller holds `lock`.
    ///
    /// # Errors
    /// Fails if it can't be written.
    pub fn write_in<T: Submission>(&self, dir: &Path, root: &str, pending: &T) -> Result<()> {
        crate::workspace::atomic_write(&self.file(dir, root), &serde_json::to_vec_pretty(pending)?)
    }

    /// The submission waiting for `root`.
    ///
    /// # Errors
    /// Fails if the file can't be read or parsed.
    pub fn read_in<T: Submission>(&self, dir: &Path, root: &str) -> Result<Option<T>> {
        match std::fs::read(self.file(dir, root)) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Forget submission `id` for `root`; returns whether it was the one waiting.
    ///
    /// # Errors
    /// Fails if the file can't be read or removed.
    pub fn clear_in<T: Submission>(&self, dir: &Path, root: &str, id: &str) -> Result<bool> {
        let _guard = self.lock();
        // A newer submission arrived while the user reviewed this one; keep it.
        if self.read_in::<T>(dir, root)?.is_none_or(|p| p.id() != id) {
            return Ok(false);
        }
        std::fs::remove_file(self.file(dir, root))?;
        Ok(true)
    }
}
