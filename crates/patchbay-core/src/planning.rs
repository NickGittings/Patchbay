//! Planning identities are independent of the current checkout and of legacy shared planners.
use serde::{Deserialize, Serialize};

pub const MAIN: &str = "_worktree_main";
pub const DRAFT: &str = "_project_draft";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlanningScope {
    Worktree { task: Option<String> },
    ProjectDraft,
}

impl PlanningScope {
    #[must_use]
    pub fn artifact_task(&self) -> &str {
        match self {
            Self::Worktree { task } => task.as_deref().unwrap_or(MAIN),
            Self::ProjectDraft => DRAFT,
        }
    }

    #[must_use]
    pub fn worktree_task(&self) -> Option<&str> {
        match self {
            Self::Worktree { task } => task.as_deref(),
            Self::ProjectDraft => None,
        }
    }
}

#[must_use]
pub fn artifact_task(task: Option<&str>) -> Option<&str> {
    Some(task.unwrap_or(MAIN))
}

#[must_use]
pub fn checkout_task(task: Option<&str>) -> Option<&str> {
    task.filter(|t| *t != MAIN && *t != DRAFT)
}

/// Preserve legacy artifacts once, assigning them only to an unambiguous persisted owner.
/// Source files remain available to historical provider sessions.
///
/// # Errors
/// Fails on I/O errors or conflicting destination artifacts.
pub fn migrate_legacy(root: &std::path::Path, owner: Option<&str>) -> anyhow::Result<()> {
    let _guard = crate::plans::WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let directory = crate::plans::dir(root)?;
    let marker = directory.join("scoped-migration.json");
    if marker.exists() {
        return Ok(());
    }
    let desired = crate::plans::plan_file(root, owner)?;
    let destination = if owner.is_some()
        && ["md", "proposal.json", "assignments.json"]
            .iter()
            .any(|ext| {
                let target = desired.with_extension(ext);
                let source = crate::plans::plan_file(root, None).map(|p| p.with_extension(ext));
                target.exists()
                    && source.ok().and_then(|source| version(&source).ok()) != version(&target).ok()
            }) {
        DRAFT
    } else {
        owner.unwrap_or(DRAFT)
    };
    let source = crate::plans::plan_file(root, None)?;
    let target = crate::plans::plan_file(root, Some(destination))?;
    let mut copied = Vec::new();
    let result = (|| {
        for extension in ["md", "proposal.json", "assignments.json"] {
            let from = source.with_extension(extension);
            let to = target.with_extension(extension);
            if !from.exists() {
                continue;
            }
            if to.exists() {
                anyhow::ensure!(
                    version(&to)? == version(&from)?,
                    "Legacy plan migration conflicts with an existing destination plan"
                );
                continue;
            }
            let bytes = std::fs::read(&from)?;
            crate::plans::write_atomic(&to, &bytes)?;
            copied.push(to.clone());
            crate::plans::touch(&to, std::fs::metadata(from)?.modified()?)?;
        }
        crate::plans::write_atomic(&marker, &serde_json::to_vec(&destination)?)?;
        anyhow::Ok(())
    })();
    if result.is_err() {
        for file in copied {
            let _ = std::fs::remove_file(file);
        }
    }
    result
}

#[derive(Clone, Serialize, Deserialize)]
struct Transfer {
    task: String,
    versions: Vec<(String, String)>,
    complete: bool,
}

/// The worktree awaiting a durable history handoff, if any.
///
/// # Errors
/// Fails on unreadable or invalid transfer receipts.
pub fn pending_transfer(root: &std::path::Path) -> anyhow::Result<Option<String>> {
    let path = crate::plans::dir(root)?.join("draft-handoff.json");
    match std::fs::read(path) {
        Ok(bytes) => {
            let transfer: Transfer = serde_json::from_slice(&bytes)?;
            Ok((!transfer.complete).then_some(transfer.task))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn version(path: &std::path::Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)?;
    let stamp = std::fs::metadata(path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let hash = bytes
        .iter()
        .copied()
        .chain(stamp.to_le_bytes())
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
    Ok(format!("{hash:016x}"))
}

/// Copy a stopped project's draft into a fresh worktree. The source survives until
/// the desktop persists the associated history and acknowledges the transfer.
/// Retries recognize only the exact files written by this transfer.
///
/// # Errors
/// Fails for unknown tasks, destination conflicts, changed artifacts or I/O errors.
pub fn transfer_draft(root: &std::path::Path, task: &str, finish: bool) -> anyhow::Result<()> {
    crate::tasks::stored(root, task)?;
    let _submissions = crate::proposals::SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _guard = crate::plans::WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let source = crate::plans::plan_file(root, Some(DRAFT))?;
    let target = crate::plans::plan_file(root, Some(task))?;
    let marker = crate::plans::dir(root)?.join("draft-handoff.json");
    let old = match std::fs::read(&marker) {
        Ok(bytes) => Some(serde_json::from_slice::<Transfer>(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if let Some(mut transfer) = old.as_ref().filter(|t| t.task == task).cloned() {
        if transfer.complete {
            for (extension, expected) in &transfer.versions {
                let file = source.with_extension(extension);
                if file.exists() {
                    anyhow::ensure!(
                        version(&file)? == *expected,
                        "A new draft exists; the completed handoff will not overwrite its destination"
                    );
                    std::fs::remove_file(file)?;
                }
            }
            return Ok(());
        }
        for (extension, expected) in &transfer.versions {
            anyhow::ensure!(
                version(&source.with_extension(extension))? == *expected
                    && version(&target.with_extension(extension))? == *expected,
                "The draft or destination changed during handoff; both were preserved"
            );
        }
        if finish {
            // The receipt is durable before removal, making cleanup retryable after a crash.
            transfer.complete = true;
            crate::plans::write_atomic(&marker, &serde_json::to_vec(&transfer)?)?;
            crate::proposals::remove(root, Some(DRAFT))?;
            crate::plans::remove(root, Some(DRAFT))?;
        }
        return Ok(());
    }
    anyhow::ensure!(!finish, "No draft handoff is pending");
    anyhow::ensure!(
        old.is_none_or(|t| t.complete),
        "Finish the pending draft handoff before creating another"
    );
    let mut transfer = Transfer {
        task: task.into(),
        versions: Vec::new(),
        complete: false,
    };
    for extension in ["md", "proposal.json", "assignments.json"] {
        anyhow::ensure!(
            !target.with_extension(extension).exists(),
            "The destination already has a plan or assignments; handoff will not overwrite them"
        );
    }
    let mut copied = Vec::new();
    let result = (|| {
        for extension in ["md", "proposal.json", "assignments.json"] {
            let from = source.with_extension(extension);
            if !from.exists() {
                continue;
            }
            let to = target.with_extension(extension);
            let stamp = std::fs::metadata(&from)?.modified()?;
            let bytes = std::fs::read(&from)?;
            crate::plans::write_atomic(&to, &bytes)?;
            copied.push(to.clone());
            crate::plans::touch(&to, stamp)?;
            transfer.versions.push((extension.into(), version(&from)?));
        }
        crate::plans::write_atomic(&marker, &serde_json::to_vec(&transfer)?)?;
        anyhow::Ok(())
    })();
    if result.is_err() {
        for file in copied {
            let _ = std::fs::remove_file(file);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{plans, proposals, tasks};
    use std::path::PathBuf;
    use std::process::Command;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("patchbay-planning-{}", uuid::Uuid::new_v4()));
            let root = base.join("project");
            std::fs::create_dir_all(&root).unwrap();
            for args in [
                vec!["init", "-q", "-b", "main"],
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "Initial",
                ],
            ] {
                let output = Command::new("git")
                    .arg("-C")
                    .arg(&root)
                    .args(args)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Self { base, root }
        }
        fn task(&self) -> tasks::Task {
            tasks::create(
                &self.root,
                tasks::TaskDraft {
                    title: "Work".into(),
                    branch: "feature".into(),
                    base: None,
                    components: vec![],
                },
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn scope_identities_isolate_main_drafts_and_sibling_worktrees() {
        let scopes = [
            PlanningScope::Worktree { task: None },
            PlanningScope::ProjectDraft,
            PlanningScope::Worktree {
                task: Some("one".into()),
            },
            PlanningScope::Worktree {
                task: Some("two".into()),
            },
        ];
        let ids: std::collections::HashSet<_> = scopes
            .iter()
            .map(|scope| {
                crate::model::task_session_id(
                    "project",
                    crate::model::PLAN_SCOPE,
                    "codex",
                    Some(scope.artifact_task()),
                )
            })
            .collect();
        assert_eq!(ids.len(), 4);
        assert!(!ids.contains(&crate::model::task_session_id(
            "project",
            crate::model::PLAN_SCOPE,
            "codex",
            None
        )));
        assert_eq!(
            serde_json::to_value(&scopes[0]).unwrap(),
            serde_json::json!({"kind":"worktree","task":null})
        );
    }

    #[test]
    fn ambiguous_legacy_plan_is_a_repeatable_draft_and_preserves_its_source() {
        let f = Fixture::new();
        plans::write(&f.root, None, "legacy").unwrap();
        migrate_legacy(&f.root, None).unwrap();
        assert_eq!(
            plans::read(&f.root, Some(DRAFT)).unwrap(),
            plans::read(&f.root, None).unwrap()
        );
        assert!(plans::read(&f.root, Some(MAIN)).unwrap().text.is_empty());
        plans::write(&f.root, None, "late legacy write").unwrap();
        migrate_legacy(&f.root, Some(MAIN)).unwrap();
        assert_eq!(plans::read(&f.root, Some(DRAFT)).unwrap().text, "legacy");
    }

    #[test]
    fn legacy_owner_migration_keeps_existing_task_plans() {
        let f = Fixture::new();
        plans::write(&f.root, None, "legacy").unwrap();
        plans::write(&f.root, Some("task"), "existing task plan").unwrap();
        migrate_legacy(&f.root, Some("task")).unwrap();
        assert_eq!(
            plans::read(&f.root, Some("task")).unwrap().text,
            "existing task plan"
        );
        assert_eq!(plans::read(&f.root, Some(DRAFT)).unwrap().text, "legacy");
    }

    #[test]
    fn legacy_migration_resumes_an_identical_partial_copy() {
        let f = Fixture::new();
        plans::write(&f.root, None, "legacy").unwrap();
        let from = plans::plan_file(&f.root, None).unwrap();
        let to = plans::plan_file(&f.root, Some(DRAFT)).unwrap();
        plans::write_atomic(&to, &std::fs::read(&from).unwrap()).unwrap();
        plans::touch(&to, std::fs::metadata(&from).unwrap().modified().unwrap()).unwrap();
        migrate_legacy(&f.root, None).unwrap();
        assert_eq!(
            plans::read(&f.root, Some(DRAFT)).unwrap(),
            plans::read(&f.root, None).unwrap()
        );
    }

    /// Optional local regression input: a copied legacy plans folder and an `owner` task id.
    #[test]
    fn copied_legacy_fixture_isolates_main_planning_from_existing_task_work() {
        let Ok(input) = std::env::var("PATCHBAY_PLANNING_FIXTURE") else {
            return;
        };
        let input = PathBuf::from(input);
        let owner = std::fs::read_to_string(input.join("owner")).unwrap();
        let owner = owner.trim();
        let f = Fixture::new();
        let directory = plans::dir(&f.root).unwrap();
        for entry in std::fs::read_dir(input.join("plans")).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_type().unwrap().is_file() {
                continue;
            }
            let target = directory.join(entry.file_name());
            std::fs::copy(entry.path(), &target).unwrap();
            plans::touch(&target, entry.metadata().unwrap().modified().unwrap()).unwrap();
        }
        let favorite = plans::read(&f.root, Some(owner)).unwrap();
        let legacy = plans::read(&f.root, None).unwrap();
        let assignments = directory.join(format!("{owner}.assignments.json"));
        let before_assignments = std::fs::read(&assignments).unwrap();
        migrate_legacy(&f.root, None).unwrap();
        assert_eq!(plans::read(&f.root, Some(DRAFT)).unwrap(), legacy);
        plans::write(
            &f.root,
            Some(MAIN),
            "# Screenshot mode\nPlan screenshots only in the main worktree.",
        )
        .unwrap();
        assert_eq!(plans::read(&f.root, Some(owner)).unwrap(), favorite);
        assert_eq!(std::fs::read(assignments).unwrap(), before_assignments);
        assert!(
            plans::read(&f.root, Some(MAIN))
                .unwrap()
                .text
                .contains("Screenshot mode")
        );
        assert_eq!(plans::read(&f.root, None).unwrap(), legacy);
    }

    #[test]
    fn unambiguous_legacy_owner_receives_plan_and_ambiguous_main_stays_empty() {
        let f = Fixture::new();
        plans::write(&f.root, None, "owned").unwrap();
        migrate_legacy(&f.root, Some(MAIN)).unwrap();
        assert_eq!(plans::read(&f.root, Some(MAIN)).unwrap().text, "owned");
        assert!(plans::read(&f.root, Some(DRAFT)).unwrap().text.is_empty());
    }

    #[test]
    fn draft_transfer_preserves_timestamps_and_waits_for_history_acknowledgement() {
        let f = Fixture::new();
        let task = f.task();
        plans::write(&f.root, Some(DRAFT), "draft plan").unwrap();
        let source = plans::read(&f.root, Some(DRAFT)).unwrap();
        transfer_draft(&f.root, &task.id, false).unwrap();
        transfer_draft(&f.root, &task.id, false).unwrap();
        assert_eq!(plans::read(&f.root, Some(&task.id)).unwrap(), source);
        assert_eq!(plans::read(&f.root, Some(DRAFT)).unwrap(), source);
        transfer_draft(&f.root, &task.id, true).unwrap();
        transfer_draft(&f.root, &task.id, true).unwrap();
        assert!(plans::read(&f.root, Some(DRAFT)).unwrap().text.is_empty());
        assert_eq!(plans::read(&f.root, Some(&task.id)).unwrap(), source);
    }

    #[test]
    fn draft_transfer_refuses_destination_conflicts_and_keeps_changed_sources() {
        let f = Fixture::new();
        let task = f.task();
        plans::write(&f.root, Some(DRAFT), "source").unwrap();
        plans::write(&f.root, Some(&task.id), "existing").unwrap();
        assert!(transfer_draft(&f.root, &task.id, false).is_err());
        assert_eq!(
            plans::read(&f.root, Some(&task.id)).unwrap().text,
            "existing"
        );
        plans::remove(&f.root, Some(&task.id)).unwrap();
        transfer_draft(&f.root, &task.id, false).unwrap();
        plans::write(&f.root, Some(DRAFT), "new source").unwrap();
        assert!(transfer_draft(&f.root, &task.id, true).is_err());
        assert_eq!(
            plans::read(&f.root, Some(DRAFT)).unwrap().text,
            "new source"
        );
        assert_eq!(plans::read(&f.root, Some(&task.id)).unwrap().text, "source");
    }

    #[test]
    fn draft_transfer_preserves_pending_and_applied_assignments() {
        for applied in [false, true] {
            let f = Fixture::new();
            let task = f.task();
            // The validation requires a known component.
            let project: crate::Project = serde_json::from_value(serde_json::json!({"root":f.root.display().to_string(),"name":"Fixture","components":[{"id":"web","name":"Web","path":"."}]})).unwrap();
            let proposal = proposals::Proposal {
                version: 1,
                plan: "plan".into(),
                assignments: vec![proposals::Assignment {
                    component_id: "web".into(),
                    assignment: "build".into(),
                }],
                saved_ms: None,
            };
            proposals::submit(&project, Some(DRAFT), &proposal).unwrap();
            if applied {
                proposals::apply(&project, Some(DRAFT), Some(DRAFT), &proposal).unwrap();
            }
            transfer_draft(&f.root, &task.id, false).unwrap();
            assert!(
                proposals::read(&f.root, Some(&task.id), applied)
                    .unwrap()
                    .is_some()
            );
            transfer_draft(&f.root, &task.id, true).unwrap();
            assert!(
                proposals::read(&f.root, Some(DRAFT), applied)
                    .unwrap()
                    .is_none()
            );
        }
    }
}
