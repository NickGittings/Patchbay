//! The shared plan a planner hands to implementation agents: one Markdown file
//! per task (or `main` without one) in Patchbay's per-user folder of the repo's
//! common git directory (`<git-common-dir>/patchbay/plans/`), never committed.

use crate::context::ContextSection;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
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
    let _ = std::fs::remove_file(presented_file(root, task)?);
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

/// Read at most `PLAN_LIMIT` bytes as text, and whether the file was longer.
pub(crate) fn read_capped(handle: std::fs::File) -> std::io::Result<(String, bool)> {
    read_limited(handle, PLAN_LIMIT)
}

/// [`read_capped`] at `limit` bytes.
pub(crate) fn read_limited(handle: std::fs::File, limit: usize) -> std::io::Result<(String, bool)> {
    let mut bytes = Vec::new();
    // One byte past the limit tells a cut file from one exactly at it.
    handle
        .take(u64::try_from(limit + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut bytes)?;
    let cut = bytes.len() > limit;
    bytes.truncate(limit);
    if cut {
        // Cut at a character boundary, so the text stays within the limit.
        if let Err(e) = std::str::from_utf8(&bytes)
            && e.error_len().is_none()
        {
            bytes.truncate(e.valid_up_to());
        }
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), cut))
}

/// Replace `file` atomically through a temporary file beside it.
pub(crate) fn write_atomic(file: &Path, bytes: &[u8]) -> Result<()> {
    let dir = file.parent().unwrap_or(Path::new("."));
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn load(root: &Path, task: Option<&str>) -> Result<Option<Saved>> {
    let file = plan_file(root, task)?;
    let handle = match std::fs::File::open(&file) {
        Ok(handle) => handle,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let modified = handle.metadata().and_then(|m| m.modified()).ok();
    let (text, cut) = read_capped(handle)?;
    Ok(Some(Saved {
        text,
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
    std::fs::create_dir_all(file.parent().unwrap_or(Path::new(".")))?;
    write_atomic(&file, text.as_bytes())?;
    crate::proposals::invalidate(root, task)?;
    Ok(())
}

/// A plan an agent presented for approval in its provider's dialog, and the text it
/// replaced, so a rejection can put that back.
#[derive(Serialize, Deserialize)]
struct Presented {
    previous: String,
    presented: String,
}

fn presented_file(root: &Path, task: Option<&str>) -> Result<PathBuf> {
    Ok(plan_file(root, task)?.with_extension("presented.json"))
}

/// Save a plan an agent's provider captured: `presented` while it awaits approval
/// (remembering what it replaced, see [`withdraw`]), else approved. Returns whether
/// the plan changed; an unchanged one leaves applied assignments alone.
///
/// # Errors
/// As [`write`], or when the presented record can't be written or removed.
pub fn capture(root: &Path, task: Option<&str>, text: &str, presented: bool) -> Result<bool> {
    let _guard = WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let current = load(root, task)?;
    let unchanged = current.as_ref().is_some_and(|s| !s.cut && s.text == text);
    let marker = presented_file(root, task)?;
    if !presented {
        match std::fs::remove_file(&marker) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    } else if !unchanged {
        // A cut plan can't be put back whole; a rejection then keeps the presented one.
        let previous = match current {
            Some(saved) if saved.cut => None,
            Some(saved) => Some(saved.text),
            None => Some(String::new()),
        };
        if let Some(previous) = previous {
            std::fs::create_dir_all(marker.parent().unwrap_or(Path::new(".")))?;
            std::fs::write(
                &marker,
                serde_json::to_vec(&Presented {
                    previous,
                    presented: text.into(),
                })?,
            )?;
        }
    }
    if unchanged {
        return Ok(false);
    }
    write_locked(root, task, text)?;
    Ok(true)
}

/// Put back what a presented plan replaced once the provider's dialog closed
/// without approving it, unless the plan was changed since. Returns whether it did.
///
/// # Errors
/// As [`write`], or when the presented record can't be read or removed.
pub fn withdraw(root: &Path, task: Option<&str>) -> Result<bool> {
    let _guard = WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let marker = presented_file(root, task)?;
    let bytes = match std::fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    std::fs::remove_file(&marker)?;
    let Ok(Presented {
        previous,
        presented,
    }) = serde_json::from_slice(&bytes)
    else {
        return Ok(false);
    };
    let current = read(root, task)?;
    if current.cut || current.text != presented {
        return Ok(false);
    }
    write_locked(root, task, &previous)?;
    Ok(true)
}

/// How long ago `then` was, roughly ("3 hours ago").
pub(crate) fn ago(then: SystemTime) -> String {
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

const SECTION_PREFIX: &str = "The planner agreed this plan for the change";
const SECTION_SUFFIX: &str = "; the selected scope";

/// Replace only the generated plan age with the saved text and modification time.
/// Other briefing content, including the plan body, still participates in Restart.
pub(crate) fn restart_briefing(text: &str, root: &Path, task: Option<&str>) -> Result<String> {
    let prefix = format!("## Shared plan\n\n{SECTION_PREFIX}");
    let Some((before, rest)) = text.split_once(&prefix) else {
        return Ok(text.into());
    };
    let Some((age, after)) = rest.split_once(SECTION_SUFFIX) else {
        return Ok(text.into());
    };
    if !age.is_empty() && !(age.starts_with(" (saved ") && age.ends_with(')')) {
        return Ok(text.into());
    }
    let saved = load(root, task)?;
    let identity = saved.map(|s| (s.text, s.cut, s.modified));
    Ok(format!(
        "{before}{prefix}{}{SECTION_SUFFIX}{after}",
        serde_json::to_string(&identity)?
    ))
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
            "{SECTION_PREFIX}{when}{SECTION_SUFFIX} \
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
    fn presented_plans_are_withdrawn_unless_approved_or_edited() {
        let Some(root) = repo() else { return };
        write(&root, None, "agreed").unwrap();
        assert!(capture(&root, None, "shown", true).unwrap());
        // The same plan arrives again from the next hook event.
        assert!(!capture(&root, None, "shown", true).unwrap());
        assert!(withdraw(&root, None).unwrap());
        assert_eq!(read(&root, None).unwrap().text, "agreed");
        assert!(!withdraw(&root, None).unwrap());
        // Approved plans stay.
        capture(&root, None, "shown", true).unwrap();
        assert!(!capture(&root, None, "shown", false).unwrap());
        assert!(!withdraw(&root, None).unwrap());
        assert_eq!(read(&root, None).unwrap().text, "shown");
        // A plan edited after it was shown is left alone.
        capture(&root, None, "second", true).unwrap();
        write(&root, None, "edited").unwrap();
        assert!(!withdraw(&root, None).unwrap());
        assert_eq!(read(&root, None).unwrap().text, "edited");
        // Withdrawing the first plan shown leaves no plan.
        capture(&root, Some("t1"), "first", true).unwrap();
        withdraw(&root, Some("t1")).unwrap();
        assert_eq!(read(&root, Some("t1")).unwrap().text, "");
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
