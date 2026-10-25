//! Per-user story board, shared by every worktree beside the task store.
use crate::{context::ContextSection, git, tasks, workspace};
use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fmt::Write as _,
    path::Path,
    sync::Mutex,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static LOCK: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoryKind {
    Epic,
    Feature,
    Story,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoryStatus {
    #[default]
    Backlog,
    Planned,
    Building,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Story {
    pub id: String,
    pub kind: StoryKind,
    pub parent: Option<String>,
    pub title: String,
    pub description: String,
    pub acceptance: Vec<String>,
    pub components: Vec<String>,
    pub task: Option<String>,
    #[serde(default)]
    pub task_head: Option<String>,
    #[serde(default)]
    pub auto_run_id: Option<String>,
    pub status: StoryStatus,
    pub created_ms: u64,
    pub order: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryDraft {
    pub kind: StoryKind,
    pub title: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub components: Vec<String>,
}

/// Nullable links use an empty string to clear them, like other editable string fields.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryPatch {
    pub title: Option<String>,
    pub parent: Option<String>,
    pub description: Option<String>,
    pub acceptance: Option<Vec<String>>,
    pub components: Option<Vec<String>>,
    pub task: Option<String>,
    pub auto_run_id: Option<String>,
    pub status: Option<StoryStatus>,
    pub order: Option<u32>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    stories: Vec<Story>,
}

fn read(root: &Path) -> Result<Vec<Story>> {
    let file = tasks::store_dir(root)?.join("stories.json");
    match std::fs::read_to_string(&file) {
        Ok(text) => Ok(serde_json::from_str::<Store>(&text)
            .with_context(|| format!("parsing {}", file.display()))?
            .stories),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}

fn modify<T>(root: &Path, change: impl FnOnce(&mut Vec<Story>) -> Result<T>) -> Result<T> {
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut stories = read(root)?;
    let previous = stories.clone();
    let out = change(&mut stories)?;
    if stories == previous {
        return Ok(out);
    }
    workspace::atomic_write(
        &tasks::store_dir(root)?.join("stories.json"),
        &serde_json::to_vec_pretty(&Store {
            version: 1,
            stories,
        })?,
    )?;
    Ok(out)
}

/// Read the board from the backend-owned store.
/// # Errors
/// Fails when the repository or store is unreadable.
pub fn load(root: &Path) -> Result<Vec<Story>> {
    let _guard = LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    read(root)
}

fn validate(item: &Story, stories: &[Story]) -> Result<()> {
    ensure!(!item.title.trim().is_empty(), "Give the item a title");
    ensure!(
        !item.id.is_empty() && item.id.bytes().all(|b| b.is_ascii_alphanumeric()),
        "Invalid story id"
    );
    let parent = item
        .parent
        .as_ref()
        .map(|id| {
            stories
                .iter()
                .find(|s| &s.id == id)
                .ok_or_else(|| anyhow!("Unknown parent {id}"))
        })
        .transpose()?;
    ensure!(
        matches!(
            (item.kind, parent.map(|p| p.kind)),
            (StoryKind::Epic, None)
                | (StoryKind::Feature, Some(StoryKind::Epic))
                | (StoryKind::Story, None | Some(StoryKind::Feature))
        ),
        "Epics have no parent; features need an epic; stories may belong to a feature"
    );
    Ok(())
}

/// Create a board item.
/// # Errors
/// Fails for an invalid title, parent, or store write.
pub fn create(root: &Path, draft: StoryDraft) -> Result<Story> {
    modify(root, |stories| {
        let created_ms = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
        let item = Story {
            id: format!(
                "s{created_ms:x}{:x}{:x}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ),
            kind: draft.kind,
            parent: draft.parent,
            title: draft.title.trim().into(),
            description: draft.description,
            acceptance: draft.acceptance,
            components: draft.components,
            task: None,
            task_head: None,
            auto_run_id: None,
            status: StoryStatus::Backlog,
            created_ms,
            order: stories
                .iter()
                .map(|s| s.order)
                .max()
                .unwrap_or(0)
                .saturating_add(1),
        };
        validate(&item, stories)?;
        stories.push(item.clone());
        Ok(item)
    })
}

/// Edit an item without changing its identity or kind.
/// # Errors
/// Fails for unknown items, invalid parents, or store I/O.
pub fn update(root: &Path, id: &str, patch: StoryPatch) -> Result<Story> {
    modify(root, |stories| {
        let index = stories
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| anyhow!("Unknown story {id}"))?;
        let mut item = stories[index].clone();
        if let Some(v) = patch.title {
            item.title = v.trim().into();
        }
        if let Some(v) = patch.parent {
            item.parent = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = patch.description {
            item.description = v;
        }
        if let Some(v) = patch.acceptance {
            item.acceptance = v;
        }
        if let Some(v) = patch.components {
            item.components = v;
        }
        if let Some(v) = patch.task {
            // Capture the new work's baseline even when reusing the same worktree.
            item.task_head = if v.is_empty() {
                None
            } else {
                let task = tasks::stored(root, &v)?;
                Some(git::run(
                    git::git(Path::new(&task.worktree)).args(["rev-parse", "HEAD"]),
                )?)
            };
            item.task = (!v.is_empty()).then_some(v);
            item.auto_run_id = None;
        }
        if let Some(v) = patch.auto_run_id {
            item.auto_run_id = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = patch.status {
            item.status = v;
        }
        if let Some(v) = patch.order {
            item.order = v;
        }
        validate(&item, stories)?;
        stories[index] = item.clone();
        Ok(item)
    })
}

/// Remember a confirmed merge only for stories whose work advanced after linkage.
/// Old integrated work on a reused worktree cannot complete a newly linked story.
/// # Errors
/// Fails if the task/story store or source HEAD cannot be read or saved.
pub fn complete_merge(root: &Path, source: &Path) -> Result<()> {
    let source = source.canonicalize()?;
    let Some(task) = tasks::stored_at(root, &source)? else {
        return Ok(());
    };
    let head = git::run(git::git(&source).args(["rev-parse", "HEAD"]))?;
    modify(root, |stories| {
        for story in stories
            .iter_mut()
            .filter(|s| s.task.as_deref() == Some(&task.id))
        {
            if story
                .task_head
                .as_ref()
                .is_some_and(|baseline| baseline != &head)
            {
                story.status = StoryStatus::Done;
            }
        }
        Ok(())
    })
}

/// Save completion only while the story still belongs to this exact Auto run.
/// # Errors
/// Fails if the board cannot be read or saved.
pub fn complete_auto(root: &Path, task: &str, run_id: &str) -> Result<Vec<Story>> {
    modify(root, |stories| {
        let mut completed = vec![];
        for story in stories
            .iter_mut()
            .filter(|s| s.task.as_deref() == Some(task) && s.auto_run_id.as_deref() == Some(run_id))
        {
            story.status = StoryStatus::Done;
            completed.push(story.clone());
        }
        Ok(completed)
    })
}

/// An optional saved planner link may outlive its story (including cascade deletion).
/// # Errors
/// Fails for an unreadable board or invalid ancestry of an existing story.
pub fn planner_section(root: &Path, id: Option<&str>) -> Result<Option<ContextSection>> {
    let Some(id) = id else { return Ok(None) };
    let stories = load(root)?;
    if !stories.iter().any(|s| s.id == id) {
        return Ok(None);
    }
    section(&stories, id).map(Some)
}

/// Delete an item, optionally including its descendants. Feature deletion without
/// cascade leaves its stories unassigned. An epic's features must first be moved
/// to another epic if they are to be kept.
/// # Errors
/// Fails for an unknown item, an epic with retained features, or store I/O.
pub fn remove(root: &Path, id: &str, cascade: bool) -> Result<()> {
    modify(root, |stories| {
        ensure!(stories.iter().any(|s| s.id == id), "Unknown story {id}");
        let mut removed = vec![id.to_string()];
        if cascade {
            loop {
                let children: Vec<_> = stories
                    .iter()
                    .filter(|s| {
                        s.parent.as_ref().is_some_and(|p| removed.contains(p))
                            && !removed.contains(&s.id)
                    })
                    .map(|s| s.id.clone())
                    .collect();
                if children.is_empty() {
                    break;
                }
                removed.extend(children);
            }
        } else {
            ensure!(
                !stories
                    .iter()
                    .any(|s| s.parent.as_deref() == Some(id) && s.kind == StoryKind::Feature),
                "Move this epic's features to another epic, or delete its children too"
            );
            for s in stories
                .iter_mut()
                .filter(|s| s.parent.as_deref() == Some(id))
            {
                s.parent = None;
            }
        }
        stories.retain(|s| !removed.contains(&s.id));
        Ok(())
    })
}

/// Build a trusted story briefing, including ancestry and the selected item's descendants.
/// # Errors
/// Fails if the requested item is unknown.
pub fn section(stories: &[Story], id: &str) -> Result<ContextSection> {
    let item = stories
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| anyhow!("Unknown story {id}"))?;
    let mut ancestry = vec![];
    let mut ancestors = vec![item.id.as_str()];
    let mut parent = item.parent.as_ref();
    while let Some(p) = parent.and_then(|id| stories.iter().find(|s| &s.id == id)) {
        ensure!(
            !ancestors.contains(&p.id.as_str()) && ancestry.len() < 3,
            "Invalid story ancestry"
        );
        ancestors.push(&p.id);
        ancestry.push(p.title.clone());
        parent = p.parent.as_ref();
    }
    ancestry.reverse();
    let mut body = String::new();
    if !ancestry.is_empty() {
        let _ = writeln!(body, "{}\n", ancestry.join(" → "));
    }
    fn append(body: &mut String, item: &Story, stories: &[Story], depth: usize) {
        let _ = writeln!(
            body,
            "{} {}\n\n{}\n",
            "#".repeat(depth + 3),
            item.title,
            item.description
        );
        for criterion in &item.acceptance {
            let _ = writeln!(body, "- [ ] {criterion}");
        }
        if !item.components.is_empty() {
            let _ = writeln!(body, "\nComponents: {}\n", item.components.join(", "));
        }
        if depth < 2 {
            let mut children: Vec<_> = stories
                .iter()
                .filter(|s| s.parent.as_deref() == Some(&item.id))
                .collect();
            children.sort_by_key(|s| s.order);
            for child in children {
                append(body, child, stories, depth + 1);
            }
        }
    }
    append(&mut body, item, stories, 0);
    Ok(ContextSection {
        title: "Story".into(),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft(kind: StoryKind, parent: Option<&str>, title: &str) -> StoryDraft {
        StoryDraft {
            kind,
            parent: parent.map(Into::into),
            title: title.into(),
            description: "Description".into(),
            acceptance: vec!["Works".into()],
            components: vec!["api".into()],
        }
    }
    #[test]
    fn round_trip_parent_rules_cascade_and_briefing() {
        let root = std::env::temp_dir().join(format!("patchbay-stories-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(
            std::process::Command::new("git")
                .arg("init")
                .arg(&root)
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(create(&root, draft(StoryKind::Feature, None, "Invalid")).is_err());
        let epic = create(&root, draft(StoryKind::Epic, None, "Epic")).unwrap();
        let feature = create(&root, draft(StoryKind::Feature, Some(&epic.id), "Feature")).unwrap();
        assert!(create(&root, draft(StoryKind::Story, Some(&epic.id), "Invalid")).is_err());
        let story = create(&root, draft(StoryKind::Story, Some(&feature.id), "Story")).unwrap();
        assert_eq!(load(&root).unwrap()[2], story);
        let text = section(&load(&root).unwrap(), &story.id).unwrap();
        assert_eq!(text.title, "Story");
        for part in [
            "Epic → Feature",
            "Description",
            "- [ ] Works",
            "Components: api",
        ] {
            assert!(text.body.contains(part), "{part}");
        }
        assert!(
            section(&load(&root).unwrap(), &epic.id)
                .unwrap()
                .body
                .contains("##### Story")
        );
        assert!(section(&load(&root).unwrap(), "unknown").is_err());
        assert!(
            update(
                &root,
                &feature.id,
                StoryPatch {
                    parent: Some(story.id.clone()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        remove(&root, &feature.id, false).unwrap();
        assert_eq!(load(&root).unwrap()[1].parent, None);
        let feature = create(&root, draft(StoryKind::Feature, Some(&epic.id), "Feature")).unwrap();
        update(
            &root,
            &story.id,
            StoryPatch {
                parent: Some(feature.id),
                status: Some(StoryStatus::Planned),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(remove(&root, &epic.id, false).is_err());
        remove(&root, &epic.id, true).unwrap();
        assert!(load(&root).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn round_trip_is_shared_by_worktrees_and_bad_edits_leave_store_unchanged() {
        let root = std::env::temp_dir().join(format!("patchbay-stories-{}", uuid::Uuid::new_v4()));
        let worktree = root.with_extension("worktree");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args([
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        };
        assert!(git(&["init", "-q", "-b", "main"]));
        assert!(git(&["commit", "--allow-empty", "-qm", "init"]));
        assert!(git(&[
            "worktree",
            "add",
            "-qb",
            "story",
            worktree.to_str().unwrap()
        ]));
        let task = tasks::attach(&root, worktree.to_str().unwrap(), None, vec![]).unwrap();
        let item = create(&root, draft(StoryKind::Story, None, "Story")).unwrap();
        assert_eq!(load(&worktree).unwrap(), vec![item.clone()]);
        assert!(
            update(
                &worktree,
                &item.id,
                StoryPatch {
                    title: Some(" ".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert_eq!(load(&root).unwrap(), vec![item.clone()]);
        let updated = update(
            &worktree,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Done),
                task: Some(task.id.clone()),
                order: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(updated.created_ms, item.created_ms);
        assert!(updated.task_head.is_some());
        assert_eq!(load(&root).unwrap(), vec![updated]);
        update(
            &root,
            &item.id,
            StoryPatch {
                task: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(load(&root).unwrap()[0].task, None);
        assert!(remove(&root, "unknown", true).is_err());
        std::fs::write(
            tasks::store_dir(&root).unwrap().join("stories.json"),
            "broken",
        )
        .unwrap();
        assert!(load(&root).is_err());
        assert!(create(&root, draft(StoryKind::Epic, None, "New")).is_err());
        assert!(git(&["worktree", "remove", worktree.to_str().unwrap()]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_belongs_to_new_work_and_survives_worktree_cleanup() {
        let root = std::env::temp_dir().join(format!("patchbay-stories-{}", uuid::Uuid::new_v4()));
        let worktree = root.with_extension("worktree");
        std::fs::create_dir_all(&root).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(dir)
                    .args([
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.com",
                        "-c",
                        "commit.gpgsign=false"
                    ])
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["commit", "--allow-empty", "-qm", "init"]);
        git(
            &root,
            &[
                "worktree",
                "add",
                "-qb",
                "story",
                worktree.to_str().unwrap(),
            ],
        );
        let task = tasks::attach(&root, worktree.to_str().unwrap(), None, vec![]).unwrap();
        let item = create(&root, draft(StoryKind::Story, None, "Story")).unwrap();
        update(
            &root,
            &item.id,
            StoryPatch {
                task: Some(task.id.clone()),
                auto_run_id: Some("new".into()),
                status: Some(StoryStatus::Planned),
                ..Default::default()
            },
        )
        .unwrap();
        // Earlier work is already integrated, but this story hasn't changed HEAD.
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        assert!(complete_auto(&root, &task.id, "old").unwrap().is_empty());
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        git(&worktree, &["commit", "--allow-empty", "-qm", "new work"]);
        git(&root, &["merge", "--ff-only", "story"]);
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Done);
        // Relinking this checkout captures a new baseline and clears the old Auto identity.
        update(
            &root,
            &item.id,
            StoryPatch {
                task: Some(task.id.clone()),
                status: Some(StoryStatus::Planned),
                ..Default::default()
            },
        )
        .unwrap();
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        assert_eq!(load(&root).unwrap()[0].auto_run_id, None);
        update(
            &root,
            &item.id,
            StoryPatch {
                auto_run_id: Some("next".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(complete_auto(&root, &task.id, "new").unwrap().is_empty());
        assert_eq!(
            complete_auto(&root, &task.id, "next").unwrap()[0].status,
            StoryStatus::Done
        );
        git(&root, &["worktree", "remove", worktree.to_str().unwrap()]);
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Done);
        remove(&root, &item.id, true).unwrap();
        assert!(planner_section(&root, Some(&item.id)).unwrap().is_none());
        assert!(planner_section(&root, None).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
