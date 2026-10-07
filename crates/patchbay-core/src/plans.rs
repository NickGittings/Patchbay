//! The shared plan a planner hands to implementation agents: one Markdown file
//! per task (or `main` without one) in Patchbay's per-user folder of the repo's
//! common git directory (`<git-common-dir>/patchbay/plans/`), never committed.

use crate::context::ContextSection;
use anyhow::{Result, bail};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Environment variable naming the plan file a planner should write.
pub const PLAN_FILE_ENV: &str = "PATCHBAY_PLAN_FILE";

/// Longest plan passed on to agents; the rest is cut.
pub const PLAN_LIMIT: usize = 64 * 1024;

/// The plan file for `task` (`main` without one) of the repo containing `root`.
///
/// # Errors
/// Fails when `root` isn't in a git repo or the task id isn't a plain id.
pub fn plan_file(root: &Path, task: Option<&str>) -> Result<PathBuf> {
    let name = task.unwrap_or("main");
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("invalid task id");
    }
    Ok(crate::tasks::store_dir(root)?
        .join("plans")
        .join(format!("{name}.md")))
}

/// The saved plan, or `None` when there is none yet. Cut at [`PLAN_LIMIT`].
///
/// # Errors
/// Fails as [`plan_file`], or when the file exists but can't be read.
pub fn read(root: &Path, task: Option<&str>) -> Result<Option<String>> {
    let file = plan_file(root, task)?;
    let handle = match std::fs::File::open(&file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    handle
        .take(u64::try_from(PLAN_LIMIT).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Save the plan atomically, so an agent never reads half of it.
///
/// # Errors
/// Fails as [`plan_file`], for a plan over [`PLAN_LIMIT`], or on I/O errors.
pub fn write(root: &Path, task: Option<&str>, text: &str) -> Result<()> {
    if text.len() > PLAN_LIMIT {
        bail!("The plan is longer than {} KiB", PLAN_LIMIT / 1024);
    }
    let file = plan_file(root, task)?;
    let dir = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".plan.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, text)?;
    if let Err(e) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// The briefing section carrying a saved plan; `None` for a missing or blank one.
#[must_use]
pub fn section(root: &Path, task: Option<&str>) -> Option<ContextSection> {
    let text = read(root, task).ok()??;
    let text = text.trim();
    (!text.is_empty()).then(|| ContextSection {
        title: "Shared plan".into(),
        body: format!(
            "The planner agreed this plan for the change; your component's part of it is \
             yours to implement.\n\n{text}"
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::{env, fs, process};

    fn repo() -> Option<PathBuf> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = env::temp_dir().join(format!(
            "patchbay-plans-{}-{}",
            process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ok = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-q"])
            .output()
            .is_ok_and(|o| o.status.success());
        ok.then(|| dir.canonicalize().unwrap())
    }

    #[test]
    fn plans_round_trip_per_task() {
        let Some(root) = repo() else { return };
        assert_eq!(read(&root, None).unwrap(), None);
        assert!(section(&root, None).is_none());
        write(&root, None, "1. do it").unwrap();
        write(&root, Some("t1"), "task plan").unwrap();
        assert_eq!(read(&root, None).unwrap().as_deref(), Some("1. do it"));
        assert_eq!(
            read(&root, Some("t1")).unwrap().as_deref(),
            Some("task plan")
        );
        let file = plan_file(&root, None).unwrap();
        assert!(file.starts_with(root.join(".git")));
        assert!(section(&root, None).unwrap().body.contains("1. do it"));
        write(&root, None, "  \n").unwrap();
        assert!(section(&root, None).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn task_ids_cannot_escape_the_plans_folder() {
        let Some(root) = repo() else { return };
        for bad in ["../x", "a/b", "", "."] {
            assert!(plan_file(&root, Some(bad)).is_err(), "{bad}");
        }
        assert!(write(&root, None, &"x".repeat(PLAN_LIMIT + 1)).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
