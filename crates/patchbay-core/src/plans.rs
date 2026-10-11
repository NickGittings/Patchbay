//! The shared plan a planner hands to implementation agents: one Markdown file
//! per task (or `main` without one) in Patchbay's per-user folder of the repo's
//! common git directory (`<git-common-dir>/patchbay/plans/`), never committed.

use crate::context::ContextSection;
use anyhow::{Result, bail};
use serde::Serialize;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// Environment variable naming the plan file a planner should write.
pub const PLAN_FILE_ENV: &str = "PATCHBAY_PLAN_FILE";

/// Longest plan passed on to agents; the rest is cut.
pub const PLAN_LIMIT: usize = 64 * 1024;

fn file_name(task: Option<&str>) -> Result<String> {
    let name = task.unwrap_or("main");
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("invalid task id");
    }
    Ok(format!("{name}.md"))
}

/// The plan file for `task` (`main` without one) of the repo containing `root`.
///
/// # Errors
/// Fails when `root` isn't in a git repo or the task id isn't a plain id.
pub fn plan_file(root: &Path, task: Option<&str>) -> Result<PathBuf> {
    let name = file_name(task)?;
    Ok(crate::tasks::store_dir(root)?.join("plans").join(name))
}

/// The plans folder of the repo containing `root`, created if needed and
/// canonical, so it can be handed to an agent (`--add-dir`) and checked as a
/// root before the first plan is written.
///
/// # Errors
/// Fails when `root` isn't in a git repo or the folder can't be created.
pub fn dir(root: &Path) -> Result<PathBuf> {
    let dir = crate::tasks::store_dir(root)?.join("plans");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.canonicalize()?)
}

/// The plans folder when it exists, canonical and without creating it: the
/// folder planners and component agents were handed, for checking a resume.
#[must_use]
pub fn existing_dir(root: &Path) -> Option<PathBuf> {
    crate::tasks::store_dir(root)
        .ok()?
        .join("plans")
        .canonicalize()
        .ok()
}

/// `task`'s plan file in the created, canonical [`dir`].
///
/// # Errors
/// Fails as [`dir`] and [`plan_file`].
pub fn prepared_file(root: &Path, task: Option<&str>) -> Result<PathBuf> {
    let name = file_name(task)?;
    Ok(dir(root)?.join(name))
}

/// Delete `task`'s plan, when it has one.
///
/// # Errors
/// Fails as [`plan_file`], or when the file exists but can't be removed.
pub fn remove(root: &Path, task: Option<&str>) -> Result<()> {
    match std::fs::remove_file(plan_file(root, task)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// A saved plan as read: its text (at most [`PLAN_LIMIT`] bytes), whether the
/// file was longer, and when it was last written.
struct Saved {
    text: String,
    cut: bool,
    modified: Option<SystemTime>,
}

fn load(root: &Path, task: Option<&str>) -> Result<Option<Saved>> {
    let file = plan_file(root, task)?;
    let handle = match std::fs::File::open(&file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let modified = handle.metadata().and_then(|m| m.modified()).ok();
    let mut bytes = Vec::new();
    // One byte past the limit tells a cut plan from one exactly at it.
    handle
        .take(u64::try_from(PLAN_LIMIT + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    let cut = bytes.len() > PLAN_LIMIT;
    bytes.truncate(PLAN_LIMIT);
    if cut {
        // Cut at a character boundary, so the text stays within the limit.
        if let Err(e) = std::str::from_utf8(&bytes)
            && e.error_len().is_none()
        {
            bytes.truncate(e.valid_up_to());
        }
    }
    Ok(Some(Saved {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        cut,
        modified,
    }))
}

/// A saved plan for the editor: empty when there is none yet, and `cut` when
/// the file is longer than [`PLAN_LIMIT`] (so saving `text` would lose the rest).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub text: String,
    pub cut: bool,
}

/// The saved plan, cut at [`PLAN_LIMIT`].
///
/// # Errors
/// Fails as [`plan_file`], or when the file exists but can't be read.
pub fn read(root: &Path, task: Option<&str>) -> Result<Plan> {
    Ok(load(root, task)?.map_or_else(
        || Plan {
            text: String::new(),
            cut: false,
        },
        |saved| Plan {
            text: saved.text,
            cut: saved.cut,
        },
    ))
}

/// Serializes editor saves and proposal plan/assignment transactions within this process.
pub(crate) static WRITING: Mutex<()> = Mutex::new(());

/// Save the plan as [`write`] does, but only while the file still holds
/// `expected` (as [`read`] returned it, and not cut); `None` saves regardless.
/// Returns whether it saved, so an editor can tell the planner rewrote it.
///
/// # Errors
/// As [`write`].
pub fn write_if(
    root: &Path,
    task: Option<&str>,
    text: &str,
    expected: Option<&str>,
) -> Result<bool> {
    let _guard = WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(expected) = expected {
        let current = read(root, task)?;
        if current.cut || current.text != expected {
            return Ok(false);
        }
    }
    write_locked(root, task, text)?;
    Ok(true)
}

/// Save the plan atomically, so an agent never reads half of it.
///
/// # Errors
/// Fails as [`plan_file`], for a plan over [`PLAN_LIMIT`], or on I/O errors.
pub fn write(root: &Path, task: Option<&str>, text: &str) -> Result<()> {
    let _guard = WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    write_locked(root, task, text)
}

pub(crate) fn write_locked(root: &Path, task: Option<&str>, text: &str) -> Result<()> {
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
    crate::proposals::invalidate(root, task)?;
    Ok(())
}

/// How long ago `then` was, roughly ("3 hours ago").
fn ago(then: SystemTime) -> String {
    let secs = SystemTime::now()
        .duration_since(then)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    let (n, unit) = match secs {
        0..60 => return "just now".into(),
        60..3600 => (secs / 60, "minute"),
        3600..86_400 => (secs / 3600, "hour"),
        _ => (secs / 86_400, "day"),
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

/// The briefing section carrying a saved plan; `None` for a missing or blank one.
/// It says when the plan was saved, so an agent can tell an old one from the
/// change it was started for, and whether the plan was cut.
#[must_use]
pub fn section(root: &Path, task: Option<&str>) -> Option<ContextSection> {
    let saved = load(root, task).ok()??;
    let text = saved.text.trim();
    if text.is_empty() {
        return None;
    }
    let when = saved
        .modified
        .map(|t| format!(" (saved {})", ago(t)))
        .unwrap_or_default();
    let cut = if saved.cut {
        format!(
            "\n\n[The plan continues past {} KiB; read the rest in {}.]",
            PLAN_LIMIT / 1024,
            plan_file(root, task)
                .map_or_else(|_| "the plan file".into(), |f| f.display().to_string())
        )
    } else {
        String::new()
    };
    Some(ContextSection {
        title: "Shared plan".into(),
        body: format!(
            "The planner agreed this plan for the change{when}; the selected scope \
             is yours to implement. If it doesn't match the change you were started for, \
             ask before acting on it.\n\n{text}{cut}"
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
        assert_eq!(read(&root, None).unwrap().text, "");
        assert!(section(&root, None).is_none());
        write(&root, None, "1. do it").unwrap();
        write(&root, Some("t1"), "task plan").unwrap();
        assert_eq!(read(&root, None).unwrap().text, "1. do it");
        assert_eq!(read(&root, Some("t1")).unwrap().text, "task plan");
        let file = plan_file(&root, None).unwrap();
        assert!(file.starts_with(root.join(".git")));
        assert!(section(&root, None).unwrap().body.contains("1. do it"));
        assert!(
            section(&root, None)
                .unwrap()
                .body
                .contains("(saved just now)")
        );
        write(&root, None, "  \n").unwrap();
        assert!(section(&root, None).is_none());
        remove(&root, Some("t1")).unwrap();
        assert!(!plan_file(&root, Some("t1")).unwrap().exists());
        remove(&root, Some("t1")).unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn long_plans_are_cut_with_a_notice() {
        let Some(root) = repo() else { return };
        let file = prepared_file(&root, None).unwrap();
        assert_eq!(file.parent().unwrap(), dir(&root).unwrap());
        write(&root, None, &"x".repeat(PLAN_LIMIT)).unwrap();
        assert!(
            !section(&root, None)
                .unwrap()
                .body
                .contains("continues past")
        );
        assert!(!read(&root, None).unwrap().cut);
        fs::write(&file, "y".repeat(PLAN_LIMIT + 10)).unwrap();
        let plan = read(&root, None).unwrap();
        assert!(plan.cut && plan.text.len() == PLAN_LIMIT);
        assert!(
            section(&root, None)
                .unwrap()
                .body
                .contains("continues past 64 KiB")
        );
        // A cut inside a character drops the partial character instead of replacing it.
        fs::write(&file, format!("{}é", "y".repeat(PLAN_LIMIT - 1))).unwrap();
        let plan = read(&root, None).unwrap();
        assert!(plan.cut && plan.text == "y".repeat(PLAN_LIMIT - 1));
        // A cut plan is never replaced conditionally: saving it would lose the rest.
        assert!(!write_if(&root, None, "z", Some(&plan.text)).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conditional_writes_notice_a_rewritten_plan() {
        let Some(root) = repo() else { return };
        assert_eq!(existing_dir(&root), None);
        assert!(write_if(&root, None, "mine", Some("")).unwrap());
        assert_eq!(existing_dir(&root), Some(dir(&root).unwrap()));
        write(&root, None, "planner's").unwrap();
        assert!(!write_if(&root, None, "stale", Some("mine")).unwrap());
        assert_eq!(read(&root, None).unwrap().text, "planner's");
        assert!(write_if(&root, None, "forced", None).unwrap());
        assert_eq!(read(&root, None).unwrap().text, "forced");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ages_read_naturally() {
        let now = SystemTime::now();
        assert_eq!(ago(now), "just now");
        assert_eq!(ago(now - Duration::from_secs(60)), "1 minute ago");
        assert_eq!(ago(now - Duration::from_secs(3 * 3600)), "3 hours ago");
        assert_eq!(ago(now - Duration::from_secs(2 * 86_400 + 5)), "2 days ago");
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
