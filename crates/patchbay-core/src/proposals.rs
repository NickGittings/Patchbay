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
}

impl Proposal {
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
    std::fs::create_dir_all(path.parent().unwrap())?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes = if applied {
        serde_json::to_vec_pretty(&Applied {
            proposal: proposal.clone(),
            plan_modified_ns: plan_stamp(root, task)?,
        })?
    } else {
        serde_json::to_vec_pretty(proposal)?
    };
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(tmp);
        return Err(e.into());
    }
    Ok(())
}

/// The pending proposal, or with `applied` the applied one while the plan it wrote
/// is unchanged.
///
/// # Errors
/// Fails if the task id is invalid or the file can't be read or parsed.
pub fn read(root: &Path, task: Option<&str>, applied: bool) -> Result<Option<Proposal>> {
    match std::fs::read(file(root, task, applied)?) {
        Ok(bytes) if applied => {
            let saved: Applied = serde_json::from_slice(&bytes)?;
            Ok(
                (plan_stamp(root, task).ok() == Some(saved.plan_modified_ns))
                    .then_some(saved.proposal),
            )
        }
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
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

/// Apply exactly the reviewed artifact; a newer submission requires review again.
///
/// # Errors
/// Fails if the proposal is invalid or no longer pending, the task is unknown, or the
/// task, plan or applied record can't be written.
pub fn apply(project: &Project, task: Option<&str>, expected: &Proposal) -> Result<Vec<String>> {
    let _guard = SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    expected.validate(project)?;
    let root = Path::new(&project.root);
    if read(root, task, false)?.as_ref() != Some(expected) {
        bail!("The planner submitted a newer proposal; refresh before applying");
    }
    let ids = expected
        .assignments
        .iter()
        .map(|a| a.component_id.clone())
        .collect::<Vec<_>>();
    if let Some(id) = task {
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
    plans::write(root, task, &expected.plan)?;
    save(root, task, expected, true)?;
    Ok(ids)
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
        assert_eq!(apply(&p, None, &proposed).unwrap(), ["web"]);
        assert!(
            section(&p, None, &["web".into()])
                .unwrap()
                .body
                .contains("Add button")
        );
        assert!(section(&p, None, &[]).is_none());
        // Direct planner/editor file writes invalidate assignments even if the old text is restored.
        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(plans::plan_file(&root, None).unwrap(), &proposed.plan).unwrap();
        assert!(section(&p, None, &["web".into()]).is_none());
        apply(&p, None, &proposed).unwrap();
        plans::write(&root, None, "edited").unwrap();
        assert!(section(&p, None, &["web".into()]).is_none());
        plans::write(&root, None, &proposed.plan).unwrap();
        assert!(section(&p, None, &["web".into()]).is_none());
        let mut newer = proposed.clone();
        newer.plan = "New plan".into();
        submit(&p, None, &newer).unwrap();
        assert!(apply(&p, None, &proposed).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
