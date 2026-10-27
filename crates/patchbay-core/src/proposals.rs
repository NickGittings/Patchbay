//! Planner submissions are artifacts, never permission to change scope or launch work.
use crate::{Project, context::ContextSection, plans, tasks};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
static SUBMISSIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub component_id: String,
    pub assignment: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub version: u32,
    pub plan: String,
    pub assignments: Vec<Assignment>,
    /// When the pending proposal was submitted (Unix ms), set by [`read`]; never saved, and
    /// ignored when [`apply`] compares the proposal it was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_ms: Option<u64>,
}

impl Proposal {
    fn unstamped(&self) -> Self {
        Self {
            saved_ms: None,
            ..self.clone()
        }
    }
    /// Validate against the accessible, mapped project, including stable IDs.
    ///
    /// # Errors
    /// Fails for another version, an empty or oversized plan or assignment, or an
    /// unknown or repeated component.
    pub fn validate(&self, project: &Project) -> Result<()> {
        ensure!(self.version == 1, "Unsupported proposal version");
        ensure!(
            !self.plan.trim().is_empty(),
            "The proposal needs a Markdown plan"
        );
        ensure!(self.plan.len() <= plans::PLAN_LIMIT, "The plan is too long");
        ensure!(
            !self.assignments.is_empty(),
            "The proposal needs assignments"
        );
        let mut seen = HashSet::new();
        for entry in &self.assignments {
            ensure!(
                project.component(&entry.component_id).is_some(),
                "Unknown component {}",
                entry.component_id
            );
            ensure!(
                seen.insert(&entry.component_id),
                "Duplicate component {}",
                entry.component_id
            );
            ensure!(
                !entry.assignment.trim().is_empty(),
                "Empty assignment for {}",
                entry.component_id
            );
            ensure!(
                entry.assignment.len() <= plans::PLAN_LIMIT,
                "Assignment is too long"
            );
        }
        Ok(())
    }
}

fn file(root: &Path, task: Option<&str>, applied: bool) -> Result<PathBuf> {
    Ok(plans::plan_file(root, task)?.with_extension(if applied {
        "assignments.json"
    } else {
        "proposal.json"
    }))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Applied {
    proposal: Proposal,
    plan_modified_ns: u64,
}
fn plan_stamp(root: &Path, task: Option<&str>) -> Result<u64> {
    Ok(u64::try_from(
        std::fs::metadata(plans::plan_file(root, task)?)?
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
    )?)
}

fn save(root: &Path, task: Option<&str>, proposal: &Proposal, applied: bool) -> Result<()> {
    let path = file(root, task, applied)?;
    let bytes = if applied {
        serde_json::to_vec_pretty(&Applied {
            proposal: proposal.unstamped(),
            plan_modified_ns: plan_stamp(root, task)?,
        })?
    } else {
        serde_json::to_vec_pretty(&proposal.unstamped())?
    };
    crate::workspace::atomic_write(&path, &bytes)
}

/// The pending proposal, or with `applied` the applied one while the plan it wrote
/// is unchanged.
///
/// # Errors
/// Fails if the task id is invalid or the file can't be read or parsed.
pub fn read(root: &Path, task: Option<&str>, applied: bool) -> Result<Option<Proposal>> {
    let _guard = applied.then(|| {
        plans::WRITING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    });
    let mut file = match std::fs::File::open(file(root, task, applied)?) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)?;
    if applied {
        let saved: Applied = serde_json::from_slice(&bytes)?;
        let plan = plans::read(root, task)?;
        return Ok((!plan.cut
            && plan.text == saved.proposal.plan
            && plan_stamp(root, task).ok() == Some(saved.plan_modified_ns))
        .then(|| saved.proposal.unstamped()));
    }
    // The stamp comes from the file just read, so it can't belong to a newer submission.
    let saved_ms = file
        .metadata()?
        .modified()?
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    Ok(Some(Proposal {
        saved_ms,
        ..serde_json::from_slice::<Proposal>(&bytes)?
    }))
}

/// Save a planner's proposal for review, replacing any pending one.
///
/// # Errors
/// Fails if the proposal is invalid for `project`, the task is unknown, or it can't be saved.
pub fn submit(project: &Project, task: Option<&str>, proposal: &Proposal) -> Result<()> {
    let _guard = SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    proposal.validate(project)?;
    if let Some(id) = task {
        tasks::find(Path::new(&project.root), id)?;
    }
    save(Path::new(&project.root), task, proposal, false)
}

/// Apply exactly the reviewed artifact pending for `from` to the `to` task (`None`:
/// the project folder); a newer submission requires review again. The planner
/// belongs to the project, so its proposals may land in the worktree chosen at
/// handoff. A plan saved for `from` after the proposal (by the planner, its native
/// plan dialog or the editor) replaces the proposal's plan; the assignments still apply.
///
/// # Errors
/// Fails if the proposal is invalid or no longer pending, a task is unknown, or the
/// task, plan or applied record can't be written.
pub fn apply(
    project: &Project,
    from: Option<&str>,
    to: Option<&str>,
    expected: &Proposal,
) -> Result<Vec<String>> {
    let _guard = SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    expected.validate(project)?;
    let root = Path::new(&project.root);
    let pending = read(root, from, false)?.ok_or_else(|| {
        anyhow::anyhow!("This proposal is no longer pending; refresh before applying")
    })?;
    if pending.unstamped() != expected.unstamped() {
        bail!("The planner submitted a newer proposal; refresh before applying");
    }
    let ids = expected
        .assignments
        .iter()
        .map(|a| a.component_id.clone())
        .collect::<Vec<_>>();
    if let Some(id) = to {
        tasks::find(root, id)?;
        tasks::update(
            root,
            id,
            tasks::TaskPatch {
                components: Some(ids.clone()),
                ..Default::default()
            },
        )?;
    }
    let _plan_guard = plans::WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut applied = expected.clone();
    if let Some(newer) = newer_plan(root, from)? {
        applied.plan = newer;
    }
    plans::write_locked(root, to, &applied.plan, None)?;
    // The planner's own plan follows what it agreed, so its editor shows what was handed off.
    if from != to {
        plans::write_locked(root, from, &applied.plan, None)?;
    }
    save(root, to, &applied, true)?;
    std::fs::remove_file(file(root, from, false)?)?;
    Ok(ids)
}

/// When `task`'s pending proposal was submitted, if it has one.
pub(crate) fn submitted(root: &Path, task: Option<&str>) -> Result<Option<std::time::SystemTime>> {
    match std::fs::metadata(file(root, task, false)?) {
        Ok(meta) => Ok(Some(meta.modified()?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// `task`'s saved plan when it was written after its pending proposal was submitted.
fn newer_plan(root: &Path, task: Option<&str>) -> Result<Option<String>> {
    let Some(submitted) = submitted(root, task)? else {
        return Ok(None);
    };
    let saved = match std::fs::metadata(plans::plan_file(root, task)?) {
        Ok(meta) => meta.modified()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if saved <= submitted {
        return Ok(None);
    }
    let plan = plans::read(root, task)?;
    Ok((!plan.cut && !plan.text.trim().is_empty()).then_some(plan.text))
}

/// Forget the applied assignments, once the plan they came with changed.
///
/// # Errors
/// Fails if the task id is invalid or the file exists but can't be removed.
pub fn invalidate(root: &Path, task: Option<&str>) -> Result<()> {
    match std::fs::remove_file(file(root, task, true)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Forget the task's pending and applied proposals.
///
/// # Errors
/// As [`invalidate`].
pub fn remove(root: &Path, task: Option<&str>) -> Result<()> {
    invalidate(root, task)?;
    match std::fs::remove_file(file(root, task, false)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Only assignments matching the saved plan and current selected scope are transferred.
pub fn section(
    project: &Project,
    task: Option<&str>,
    selected: &[String],
) -> Option<ContextSection> {
    let root = Path::new(&project.root);
    let applied = read(root, task, true).ok()??;
    if plans::read(root, task).ok()?.text != applied.plan {
        return None;
    }
    let body = applied
        .assignments
        .iter()
        .filter(|a| {
            selected.contains(&a.component_id) && project.component(&a.component_id).is_some()
        })
        .map(|a| format!("- {}: {}", a.component_id, a.assignment))
        .collect::<Vec<_>>()
        .join("\n");
    (!body.is_empty()).then_some(ContextSection {
        title: "Applied assignments".into(),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(root: &Path) -> Project {
        serde_json::from_value(serde_json::json!({"name":"demo","root":root,"components":[{"id":"web","name":"Web","path":"."}]})).unwrap()
    }
    fn proposal() -> Proposal {
        Proposal {
            version: 1,
            plan: "# Agreed\nBuild it".into(),
            assignments: vec![Assignment {
                component_id: "web".into(),
                assignment: "Add button".into(),
            }],
            saved_ms: None,
        }
    }
    #[test]
    fn rejects_unknown_duplicate_and_empty_assignments() {
        let p = project(Path::new("."));
        let good = proposal();
        good.validate(&p).unwrap();
        let mut bad = good.clone();
        bad.version = 2;
        assert!(bad.validate(&p).is_err());
        bad = good.clone();
        bad.assignments[0].component_id = "unknown".into();
        assert!(bad.validate(&p).is_err());
        bad = good.clone();
        bad.assignments.push(bad.assignments[0].clone());
        assert!(bad.validate(&p).is_err());
        bad = good;
        bad.assignments[0].assignment = "  ".into();
        assert!(bad.validate(&p).is_err());
    }
    #[test]
    fn submission_does_not_apply_and_plan_edits_invalidate_assignments() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        let p = project(&root);
        let proposed = proposal();
        submit(&p, None, &proposed).unwrap();
        assert!(plans::read(&root, None).unwrap().text.is_empty());
        assert!(section(&p, None, &["web".into()]).is_none());
        // The reviewer sends back the stamped proposal it read, `savedMs` included.
        let pending = read(&root, None, false).unwrap().unwrap();
        assert!(pending.saved_ms.is_some());
        let wire: Proposal =
            serde_json::from_value(serde_json::to_value(&pending).unwrap()).unwrap();
        assert_eq!(apply(&p, None, None, &wire).unwrap(), ["web"]);
        assert!(read(&root, None, false).unwrap().is_none());
        assert!(apply(&p, None, None, &proposed).is_err());
        assert!(
            section(&p, None, &["web".into()])
                .unwrap()
                .body
                .contains("Add button")
        );
        assert!(section(&p, None, &[]).is_none());
        // Coarse/preserved timestamps must not make changed text look applied.
        let path = plans::plan_file(&root, None).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, "Changed text").unwrap();
        plans::set_modified(&path, modified);
        assert!(read(&root, None, true).unwrap().is_none());
        submit(&p, None, &proposed).unwrap();
        apply(&p, None, None, &proposed).unwrap();
        // Direct planner/editor file writes invalidate assignments even if the old text is restored.
        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(plans::plan_file(&root, None).unwrap(), &proposed.plan).unwrap();
        assert!(section(&p, None, &["web".into()]).is_none());
        submit(&p, None, &proposed).unwrap();
        apply(&p, None, None, &proposed).unwrap();
        plans::write(&root, None, "edited").unwrap();
        assert!(apply(&p, None, None, &proposed).is_err());
        assert_eq!(plans::read(&root, None).unwrap().text, "edited");
        assert!(section(&p, None, &["web".into()]).is_none());
        plans::write(&root, None, &proposed.plan).unwrap();
        assert!(section(&p, None, &["web".into()]).is_none());
        let mut newer = proposed.clone();
        newer.plan = "New plan".into();
        submit(&p, None, &newer).unwrap();
        assert!(apply(&p, None, None, &proposed).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_project_folder_proposal_applies_to_the_chosen_task() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let root = base.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .status()
                .unwrap()
                .success()
        };
        assert!(git(&["init", "-q"]) && git(&["commit", "-q", "--allow-empty", "-m", "init"]));
        let root = root.canonicalize().unwrap();
        let task = tasks::create(
            &root,
            tasks::TaskDraft {
                title: "Later".into(),
                branch: "later".into(),
                base: None,
                components: vec![],
            },
        )
        .unwrap();
        let p = project(&root);
        let proposed = proposal();
        submit(&p, None, &proposed).unwrap();
        assert!(apply(&p, None, Some(&task.id), &proposed).unwrap() == ["web"]);
        assert!(read(&root, None, false).unwrap().is_none());
        assert_eq!(plans::read(&root, None).unwrap().text, proposed.plan);
        assert_eq!(
            plans::read(&root, Some(&task.id)).unwrap().text,
            proposed.plan
        );
        assert_eq!(read(&root, Some(&task.id), true).unwrap(), Some(proposed));
        assert_eq!(tasks::find(&root, &task.id).unwrap().components, ["web"]);
        // A newer native or edited plan keeps the proposal's scope and assignments,
        // whether Implement targets a worktree or the project folder.
        for target in [Some(task.id.as_str()), None] {
            let proposed = proposal();
            submit(&p, None, &proposed).unwrap();
            plans::write(&root, None, "# Revised plan\nKeep the newer requirements").unwrap();
            let path = plans::plan_file(&root, None).unwrap();
            let submitted = std::fs::metadata(file(&root, None, false).unwrap())
                .unwrap()
                .modified()
                .unwrap();
            plans::set_modified(&path, submitted + std::time::Duration::from_secs(1));
            assert_eq!(apply(&p, None, target, &proposed).unwrap(), ["web"]);
            let applied = read(&root, target, true).unwrap().unwrap();
            assert_eq!(applied.plan, "# Revised plan\nKeep the newer requirements");
            assert_eq!(applied.assignments, proposed.assignments);
            assert_eq!(plans::read(&root, None).unwrap().text, applied.plan);
            assert_eq!(plans::read(&root, target).unwrap().text, applied.plan);
            assert!(read(&root, None, false).unwrap().is_none());
            assert!(
                section(&p, target, &["web".into()])
                    .unwrap()
                    .body
                    .contains("Add button")
            );
        }
        // Handing the same plan to a worktree still forgets the project folder's
        // applied assignments, though its plan file is left as it was.
        let first = proposal();
        plans::write(&root, None, &first.plan).unwrap();
        // Older than the proposals, so neither apply prefers the saved plan.
        plans::set_modified(
            &plans::plan_file(&root, None).unwrap(),
            std::time::UNIX_EPOCH,
        );
        submit(&p, None, &first).unwrap();
        apply(&p, None, None, &first).unwrap();
        assert_eq!(read(&root, None, true).unwrap(), Some(first.clone()));
        let mut second = first.clone();
        second.assignments[0].assignment = "Add link".into();
        submit(&p, None, &second).unwrap();
        apply(&p, None, Some(&task.id), &second).unwrap();
        assert_eq!(read(&root, None, true).unwrap(), None);
        assert_eq!(read(&root, Some(&task.id), true).unwrap(), Some(second));
        // Saving the plan again, even unchanged, after a proposal still beats it.
        let saved = "# Saved\nKeep this";
        plans::write(&root, None, saved).unwrap();
        plans::set_modified(
            &plans::plan_file(&root, None).unwrap(),
            std::time::UNIX_EPOCH,
        );
        let proposed = proposal();
        submit(&p, None, &proposed).unwrap();
        assert!(plans::write_if(&root, None, saved, Some(saved)).unwrap());
        apply(&p, None, None, &proposed).unwrap();
        assert_eq!(plans::read(&root, None).unwrap().text, saved);
        assert_eq!(read(&root, None, true).unwrap().unwrap().plan, saved);
        std::fs::remove_dir_all(base).unwrap();
    }
}
