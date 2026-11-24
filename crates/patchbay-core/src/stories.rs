//! Per-user story board, shared by every worktree beside the task store.
use crate::{context::ContextSection, git, tasks, workspace};
use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    path::Path,
    sync::Mutex,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static LOCK: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    Reviewing,
    Merging,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ParentStatus {
    Active,
    Closed,
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
    /// Saved status to restore when completion is explicitly reopened.
    #[serde(default)]
    pub previous_status: Option<StoryStatus>,
    /// Integrated HEAD that completed the story (a merge or its Auto run), which Reopen
    /// acknowledges. Absent for a manual completion, so later merges still count.
    #[serde(default)]
    pub completed_head: Option<String>,
    pub created_ms: u64,
    pub order: u32,
    /// The tracker item an extension imported this from. Re-importing updates its text;
    /// workflow fields (status, worktree and run links, components, order) stay Patchbay's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StorySource>,
}

/// Where an imported item came from, matched on `(extension, external_id)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorySource {
    pub extension: String,
    pub external_id: String,
    #[serde(default)]
    pub url: Option<String>,
}

/// One tracker item an extension imports. `parent` names another item's `external_id`,
/// in this batch or imported earlier by the same extension.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalItem {
    pub external_id: String,
    pub kind: StoryKind,
    pub title: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// What an import changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub created: usize,
    pub updated: usize,
    pub unchanged: usize,
}

impl Story {
    fn set_status(&mut self, status: StoryStatus) {
        if self.status == status {
            return;
        }
        self.previous_status = (status == StoryStatus::Done).then_some(self.status);
        self.completed_head = None;
        self.status = status;
    }

    /// Integrated work completed the story. Reopening it means more work on that link, so it
    /// resumes as Planned rather than at the stage (such as Merge) that was last seen.
    fn complete(&mut self, head: Option<String>) {
        if self.status != StoryStatus::Done {
            self.set_status(StoryStatus::Done);
            self.previous_status = Some(StoryStatus::Planned);
        }
        self.completed_head = head;
    }

    /// Before `previous_status` was saved, linked work had at least been planned.
    fn reopened_status(&self) -> StoryStatus {
        self.previous_status
            .unwrap_or(if self.task.is_some() || self.auto_run_id.is_some() {
                StoryStatus::Planned
            } else {
                StoryStatus::Backlog
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Restore the saved status and start a new merge baseline without unlinking work.
    #[serde(default)]
    pub reopen: bool,
    pub order: Option<u32>,
    /// A workflow's status write applies only while the saved progress and worktree linkage
    /// still match. Linkage and other fields in the same patch apply either way.
    pub expected_progress: Option<ExpectedProgress>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedProgress {
    pub status: StoryStatus,
    pub task: Option<String>,
    pub auto_run_id: Option<String>,
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

/// Criteria are trimmed and blank ones dropped, whichever command saves them.
fn clean_acceptance(acceptance: Vec<String>) -> Vec<String> {
    acceptance
        .into_iter()
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty())
        .collect()
}

fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn new_id(created_ms: u64) -> String {
    format!(
        "s{created_ms:x}{:x}{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn next_order(stories: &[Story]) -> u32 {
    stories
        .iter()
        .map(|s| s.order)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

/// Create a board item.
/// # Errors
/// Fails for an invalid title, parent, or store write.
pub fn create(root: &Path, draft: StoryDraft) -> Result<Story> {
    modify(root, |stories| {
        let created_ms = now_ms()?;
        let item = Story {
            id: new_id(created_ms),
            kind: draft.kind,
            parent: draft.parent,
            title: draft.title.trim().into(),
            description: draft.description,
            acceptance: clean_acceptance(draft.acceptance),
            components: draft.components,
            task: None,
            task_head: None,
            auto_run_id: None,
            status: StoryStatus::Backlog,
            previous_status: None,
            completed_head: None,
            created_ms,
            order: next_order(stories),
            source: None,
        };
        validate(&item, stories)?;
        stories.push(item.clone());
        Ok(item)
    })
}

/// Most items one import may carry.
pub const IMPORT_LIMIT: usize = 2000;
const EXTERNAL_ID_LIMIT: usize = 256;
const TITLE_LIMIT: usize = 500;
const DESCRIPTION_LIMIT: usize = 64 * 1024;
const ACCEPTANCE_LIMIT: usize = 100;
const CRITERION_LIMIT: usize = 2000;

fn check_external(item: &ExternalItem) -> Result<()> {
    let label = || format!("Imported item {:?}", item.external_id);
    ensure!(
        !item.external_id.is_empty()
            && item.external_id.len() <= EXTERNAL_ID_LIMIT
            && !item.external_id.chars().any(char::is_control),
        "{}: needs an id of at most {EXTERNAL_ID_LIMIT} bytes without control characters",
        label()
    );
    ensure!(
        !item.title.trim().is_empty() && item.title.len() <= TITLE_LIMIT,
        "{}: needs a title of at most {TITLE_LIMIT} bytes",
        label()
    );
    ensure!(
        item.description.len() <= DESCRIPTION_LIMIT,
        "{}: description exceeds {} KiB",
        label(),
        DESCRIPTION_LIMIT / 1024
    );
    ensure!(
        item.acceptance.len() <= ACCEPTANCE_LIMIT
            && item.acceptance.iter().all(|a| a.len() <= CRITERION_LIMIT),
        "{}: at most {ACCEPTANCE_LIMIT} acceptance criteria of {CRITERION_LIMIT} bytes each",
        label()
    );
    if let Some(url) = &item.url {
        crate::extensions::preview_url(url).with_context(label)?;
    }
    Ok(())
}

fn csv_fallback_slug(id: &str) -> Option<&str> {
    let (slug, hash) = id.strip_prefix("csv:")?.split_once('~')?;
    let hash = hash.split('~').next()?;
    (hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(slug)
}

// The first file importer used csv:<slug>-<row number>. Adopt old IDs only when a
// new CSV fallback ID and an existing card match unambiguously by kind and title.
fn legacy_csv_ids(
    extension: &str,
    items: &[ExternalItem],
    stories: &[Story],
) -> HashMap<String, String> {
    if extension != "patchbay.story-import" {
        return HashMap::new();
    }
    let incoming: HashSet<&str> = items.iter().map(|item| item.external_id.as_str()).collect();
    let existing: HashSet<&str> = stories
        .iter()
        .filter_map(|story| story.source.as_ref())
        .filter(|source| source.extension == extension)
        .map(|source| source.external_id.as_str())
        .collect();
    let mut counts = HashMap::new();
    for item in items
        .iter()
        .filter(|item| csv_fallback_slug(&item.external_id).is_some())
    {
        *counts.entry((item.kind, item.title.trim())).or_insert(0) += 1;
    }

    items
        .iter()
        .filter_map(|item| {
            let slug = csv_fallback_slug(&item.external_id)?;
            let title = item.title.trim();
            if counts[&(item.kind, title)] != 1 || existing.contains(item.external_id.as_str()) {
                return None;
            }
            let mut candidates = stories.iter().filter_map(|story| {
                let source = story
                    .source
                    .as_ref()
                    .filter(|src| src.extension == extension)?;
                if story.kind != item.kind
                    || story.title != title
                    || incoming.contains(source.external_id.as_str())
                {
                    return None;
                }
                let (old_slug, row) = source.external_id.strip_prefix("csv:")?.rsplit_once('-')?;
                (old_slug == slug && row.parse::<usize>().is_ok_and(|row| row > 0))
                    .then_some(&source.external_id)
            });
            let old = candidates.next()?;
            candidates
                .next()
                .is_none()
                .then(|| (item.external_id.clone(), old.clone()))
        })
        .collect()
}

/// Create or update items an extension imported, matched on their source. Epics come
/// first, then features, then stories, so each batch may name its own parents. Imports
/// replace text (title, description, acceptance, link) and leave workflow alone.
/// An existing item's parent is kept when the tracker omits it.
/// A story whose parent was never imported is unassigned; a feature's epic must exist.
/// The whole batch applies or none of it does.
/// # Errors
/// Fails for an invalid item, a duplicate or changed-kind id, a missing epic, or store I/O.
pub fn upsert_external(
    root: &Path,
    extension: &str,
    items: Vec<ExternalItem>,
) -> Result<ImportReport> {
    ensure!(
        items.len() <= IMPORT_LIMIT,
        "An import may carry at most {IMPORT_LIMIT} items"
    );
    let mut seen = HashSet::new();
    for item in &items {
        check_external(item)?;
        ensure!(
            seen.insert(item.external_id.as_str()),
            "Imported item {:?} appears twice",
            item.external_id
        );
    }
    let rank = |kind: StoryKind| match kind {
        StoryKind::Epic => 0,
        StoryKind::Feature => 1,
        StoryKind::Story => 2,
    };
    let mut items = items;
    items.sort_by_key(|item| rank(item.kind));
    let from = |s: &Story, external_id: &str| {
        s.source
            .as_ref()
            .is_some_and(|src| src.extension == extension && src.external_id == external_id)
    };
    modify(root, |stories| {
        let previous_ids = legacy_csv_ids(extension, &items, stories);
        let matches = |story: &Story, external_id: &str| {
            from(story, external_id)
                || previous_ids
                    .get(external_id)
                    .is_some_and(|old| from(story, old))
        };
        let created_ms = now_ms()?;
        let mut report = ImportReport::default();
        for item in items {
            let parent = match &item.parent {
                None => None,
                Some(external) => {
                    let found = stories
                        .iter()
                        .find(|s| matches(s, external))
                        .map(|s| s.id.clone());
                    ensure!(
                        found.is_some() || item.kind == StoryKind::Story,
                        "{:?} names parent {external:?}, which hasn't been imported",
                        item.title
                    );
                    found
                }
            };
            let source = Some(StorySource {
                extension: extension.into(),
                external_id: item.external_id.clone(),
                url: item.url.clone(),
            });
            if let Some(index) = stories.iter().position(|s| matches(s, &item.external_id)) {
                let existing = &stories[index];
                ensure!(
                    existing.kind == item.kind,
                    "{:?} was imported as a {:?} and can't become a {:?}; delete it first",
                    item.title,
                    existing.kind,
                    item.kind
                );
                let mut updated = existing.clone();
                updated.title = item.title.trim().into();
                updated.description = item.description;
                updated.acceptance = clean_acceptance(item.acceptance);
                if item.parent.is_some() {
                    updated.parent = parent;
                }
                updated.source = source;
                if updated == *existing {
                    report.unchanged += 1;
                    continue;
                }
                validate(&updated, stories)?;
                stories[index] = updated;
                report.updated += 1;
            } else {
                let created = Story {
                    id: new_id(created_ms),
                    kind: item.kind,
                    parent,
                    title: item.title.trim().into(),
                    description: item.description,
                    acceptance: clean_acceptance(item.acceptance),
                    components: vec![],
                    task: None,
                    task_head: None,
                    auto_run_id: None,
                    status: StoryStatus::Backlog,
                    previous_status: None,
                    completed_head: None,
                    created_ms,
                    order: next_order(stories),
                    source,
                };
                validate(&created, stories)?;
                stories.push(created);
                report.created += 1;
            }
        }
        Ok(report)
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
        let stale = patch.expected_progress.is_some_and(|expected| {
            expected.status != item.status
                || expected.task != item.task
                || expected.auto_run_id != item.auto_run_id
        });
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
            item.acceptance = clean_acceptance(v);
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
            item.completed_head = None;
        }
        if let Some(v) = patch.auto_run_id {
            item.auto_run_id = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = patch.status.filter(|_| !stale) {
            item.set_status(v);
        }
        if patch.reopen && item.status == StoryStatus::Done {
            // Integrated work that completed the story can't complete it again: its HEAD
            // becomes the merge baseline and its Auto run is done with it. A manual
            // completion keeps both, so merging the work still completes the story.
            if let Some(head) = item.completed_head.take() {
                item.task_head = Some(head);
                item.auto_run_id = None;
            }
            item.set_status(item.reopened_status());
        }
        if let Some(v) = patch.order {
            item.order = v;
        }
        validate(&item, stories)?;
        stories[index] = item.clone();
        Ok(item)
    })
}

/// Resolve a parent's status from saved child statuses. The board's `parentStatus` also counts
/// a story its matching Auto run completed before Done is saved, so the two can briefly differ.
#[must_use]
pub fn parent_status(item: &Story, stories: &[Story]) -> Option<ParentStatus> {
    let child_kind = match item.kind {
        StoryKind::Epic => StoryKind::Feature,
        StoryKind::Feature => StoryKind::Story,
        StoryKind::Story => return None,
    };
    let children = stories
        .iter()
        .filter(|child| child.kind == child_kind && child.parent.as_ref() == Some(&item.id));
    let closed = item.status == StoryStatus::Done
        || (children.clone().next().is_some()
            && children.into_iter().all(|child| match child.kind {
                StoryKind::Story => child.status == StoryStatus::Done,
                _ => parent_status(child, stories) == Some(ParentStatus::Closed),
            }));
    Some(if closed {
        ParentStatus::Closed
    } else {
        ParentStatus::Active
    })
}

/// Display order among siblings, mirrored by `lib/stories.ts` `ordered`.
fn sibling_order(a: &Story, b: &Story) -> std::cmp::Ordering {
    a.order
        .cmp(&b.order)
        .then(a.created_ms.cmp(&b.created_ms))
        .then_with(|| a.id.cmp(&b.id))
}

fn ordered<'a>(items: impl Iterator<Item = &'a Story>) -> Vec<&'a Story> {
    let mut items: Vec<_> = items.collect();
    items.sort_by(|a, b| sibling_order(a, b));
    items
}

/// The board's top-to-bottom priority, matching `lib/stories.ts` `tree`: each epic,
/// then its features, each followed by its stories, and finally unassigned stories
/// (including orphans). Features without an epic aren't shown on the board.
#[must_use]
pub fn board_order(stories: &[Story]) -> Vec<&Story> {
    let mut out = vec![];
    let mut features = vec![];
    for epic in ordered(stories.iter().filter(|s| s.kind == StoryKind::Epic)) {
        out.push(epic);
        for feature in ordered(stories.iter().filter(|s| {
            s.kind == StoryKind::Feature && s.parent.as_deref() == Some(epic.id.as_str())
        })) {
            out.push(feature);
            features.push(feature.id.as_str());
            out.extend(ordered(stories.iter().filter(|s| {
                s.kind == StoryKind::Story && s.parent.as_deref() == Some(feature.id.as_str())
            })));
        }
    }
    out.extend(ordered(stories.iter().filter(|s| {
        s.kind == StoryKind::Story && s.parent.as_deref().is_none_or(|p| !features.contains(&p))
    })));
    out
}

/// The highest-priority story nobody has started: saved as Backlog with no linked work.
#[must_use]
pub fn next(stories: &[Story]) -> Option<&Story> {
    board_order(stories).into_iter().find(|s| {
        s.kind == StoryKind::Story
            && s.status == StoryStatus::Backlog
            && s.task.is_none()
            && s.auto_run_id.is_none()
    })
}

/// The sibling group a board column reorders within, matching what `board_order` shows
/// together: a feature's stories, an epic's features, and otherwise one unassigned group.
fn sibling_group<'a>(item: &'a Story, stories: &[Story]) -> Option<&'a str> {
    let parent = item.parent.as_deref()?;
    let found = stories.iter().find(|s| s.id == parent)?;
    let shown = match (item.kind, found.kind) {
        (StoryKind::Feature, StoryKind::Epic) => true,
        // A story sits under its feature only while that feature sits under an epic.
        (StoryKind::Story, StoryKind::Feature) => found.parent.as_deref().is_some_and(|e| {
            stories
                .iter()
                .any(|s| s.id == e && s.kind == StoryKind::Epic)
        }),
        _ => false,
    };
    shown.then_some(parent)
}

/// Set the priority of one complete sibling group to the given top-to-bottom sequence.
/// # Errors
/// Fails unless `ids` lists every item of one sibling group exactly once, or on store I/O.
pub fn reorder(root: &Path, ids: &[String]) -> Result<()> {
    modify(root, |stories| {
        let first = ids
            .first()
            .and_then(|id| stories.iter().find(|s| &s.id == id))
            .ok_or_else(|| anyhow!("Unknown story to reorder"))?;
        let (kind, group) = (first.kind, sibling_group(first, stories).map(str::to_owned));
        let siblings: Vec<_> = stories
            .iter()
            .filter(|s| s.kind == kind && sibling_group(s, stories) == group.as_deref())
            .map(|s| s.id.as_str())
            .collect();
        ensure!(
            siblings.len() == ids.len() && siblings.iter().all(|id| ids.iter().any(|i| i == id)),
            "The board changed. Reload it and try again."
        );
        for (index, id) in ids.iter().enumerate() {
            if let Some(item) = stories.iter_mut().find(|s| &s.id == id) {
                item.order = u32::try_from(index)?;
            }
        }
        Ok(())
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
            .filter(|s| s.kind == StoryKind::Story && s.task.as_deref() == Some(&task.id))
        {
            if story
                .task_head
                .as_ref()
                .is_some_and(|baseline| baseline != &head)
            {
                story.complete(Some(head.clone()));
            }
        }
        Ok(())
    })
}

/// Save completion only while the story still belongs to this exact Auto run.
/// # Errors
/// Fails if the board cannot be read or saved.
pub fn complete_auto(root: &Path, task: &str, run_id: &str) -> Result<Vec<Story>> {
    // The run merged its work, so its HEAD is the integrated one. A removed worktree
    // leaves none, and with it nothing a later merge poll could complete again.
    let head = tasks::stored(root, task)
        .ok()
        .and_then(|t| git::run(git::git(Path::new(&t.worktree)).args(["rev-parse", "HEAD"])).ok());
    modify(root, |stories| {
        let mut completed = vec![];
        for story in stories.iter_mut().filter(|s| {
            s.kind == StoryKind::Story
                && s.task.as_deref() == Some(task)
                && s.auto_run_id.as_deref() == Some(run_id)
        }) {
            story.complete(head.clone());
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
        let _ = writeln!(body, "{} {}\n", "#".repeat(depth + 3), item.title);
        if let Some(url) = item.source.as_ref().and_then(|s| s.url.as_ref()) {
            let _ = writeln!(body, "Tracker: {url}\n");
        }
        let _ = writeln!(body, "{}\n", item.description);
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
            children.sort_by(|a, b| sibling_order(a, b));
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
    fn item(id: &str, kind: StoryKind, parent: Option<&str>, order: u32, created_ms: u64) -> Story {
        Story {
            id: id.into(),
            kind,
            parent: parent.map(Into::into),
            title: id.into(),
            description: String::new(),
            acceptance: vec![],
            components: vec![],
            task: None,
            task_head: None,
            auto_run_id: None,
            status: StoryStatus::Backlog,
            previous_status: None,
            completed_head: None,
            created_ms,
            order,
            source: None,
        }
    }

    /// Paired with `lib/stories.test.ts` "board order matches the core golden order".
    fn golden_board() -> Vec<Story> {
        use StoryKind::{Epic, Feature, Story as S};
        vec![
            item("s1", S, None, 1, 1),
            item("e2", Epic, None, 2, 2),
            item("e1", Epic, None, 1, 3),
            item("f2", Feature, Some("e1"), 0, 4),
            item("f1", Feature, Some("e1"), 0, 3),
            item("f3", Feature, Some("e2"), 0, 5),
            item("a2", S, Some("f1"), 5, 6),
            item("a1", S, Some("f1"), 5, 6),
            item("b1", S, Some("f2"), 0, 7),
            item("c1", S, Some("f3"), 0, 8),
            item("o1", S, Some("gone"), 0, 9),
            item("s0", S, None, 0, 10),
        ]
    }

    #[test]
    fn board_order_walks_epics_features_then_unassigned_stories() {
        let board = golden_board();
        let ids: Vec<_> = board_order(&board).iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "e1", "f1", "a1", "a2", "f2", "b1", "e2", "f3", "c1", "o1", "s0", "s1"
            ]
        );
    }

    #[test]
    fn parent_status_matches_the_board_golden_cases() {
        // Paired with the parent status golden cases in `lib/stories.test.ts`.
        use ParentStatus::{Active, Closed};
        use StoryKind::{Epic, Feature, Story as S};
        use StoryStatus::{Backlog, Building, Done, Merging, Reviewing};
        let board: Vec<_> = [
            ("empty", Epic, None, Building),
            ("complete", Epic, None, Backlog),
            ("allDone", Feature, Some("complete"), Backlog),
            ("done", S, Some("allDone"), Done),
            ("manual", Feature, Some("complete"), Done),
            ("review", S, Some("manual"), Reviewing),
            ("partial", Epic, None, Backlog),
            ("emptyFeature", Feature, Some("partial"), Backlog),
            ("inProgress", Feature, Some("partial"), Backlog),
            ("finished", S, Some("inProgress"), Done),
            ("merge", S, Some("inProgress"), Merging),
            ("closed", Epic, None, Done),
            ("openFeature", Feature, Some("closed"), Backlog),
        ]
        .into_iter()
        .map(|(id, kind, parent, status)| Story {
            status,
            ..item(id, kind, parent, 0, 1)
        })
        .collect();
        let statuses: Vec<_> = board
            .iter()
            .filter_map(|s| parent_status(s, &board).map(|status| (s.id.as_str(), status)))
            .collect();
        assert_eq!(
            statuses,
            [
                ("empty", Active),
                ("complete", Closed),
                ("allDone", Closed),
                ("manual", Closed),
                ("partial", Active),
                ("emptyFeature", Active),
                ("inProgress", Active),
                ("closed", Closed),
                ("openFeature", Active),
            ]
        );
    }

    #[test]
    fn saved_statuses_keep_their_wire_values_and_legacy_boards_load() {
        use StoryStatus::*;
        for (status, wire) in [
            (Backlog, "backlog"),
            (Planned, "planned"),
            (Building, "building"),
            (Reviewing, "reviewing"),
            (Merging, "merging"),
            (Done, "done"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<StoryStatus>(wire.into()).unwrap(),
                status
            );
        }
        let legacy: Store = serde_json::from_value(serde_json::json!({
            "version": 1,
            "stories": [{
                "id": "s", "kind": "story", "title": "Legacy story",
                "description": "", "acceptance": [], "components": [],
                "status": "building", "createdMs": 1, "order": 1
            }]
        }))
        .unwrap();
        assert_eq!(legacy.stories[0].status, Building);
        assert_eq!(legacy.stories[0].auto_run_id, None);
    }

    #[test]
    fn next_skips_started_done_and_linked_stories() {
        let mut board = golden_board();
        assert_eq!(next(&board).map(|s| s.id.as_str()), Some("a1"));
        for (id, change) in [("a1", 0), ("a2", 1), ("b1", 2), ("c1", 3)] {
            let s = board.iter_mut().find(|s| s.id == id).unwrap();
            match change {
                0 => s.status = StoryStatus::Done,
                1 => s.status = StoryStatus::Planned,
                2 => s.task = Some("t1".into()),
                _ => s.auto_run_id = Some("r1".into()),
            }
        }
        assert_eq!(next(&board).map(|s| s.id.as_str()), Some("o1"));
        board.retain(|s| s.kind != StoryKind::Story || s.status == StoryStatus::Done);
        assert!(next(&board).is_none());
    }

    #[test]
    fn sibling_groups_follow_the_columns_that_show_them() {
        use StoryKind::{Epic, Feature, Story as S};
        let board = vec![
            item("e", Epic, None, 0, 1),
            item("f", Feature, Some("e"), 0, 2),
            item("lost", Feature, None, 0, 3),
            item("a", S, Some("f"), 0, 4),
            item("x", S, Some("lost"), 0, 5),
            item("y", S, Some("e"), 0, 6),
            item("z", S, None, 0, 7),
        ];
        let group = |id: &str| sibling_group(board.iter().find(|s| s.id == id).unwrap(), &board);
        assert_eq!(group("f"), Some("e"));
        assert_eq!(group("a"), Some("f"));
        // Shown with the unassigned stories, so prioritized among them.
        for id in ["x", "y", "z", "e", "lost"] {
            assert_eq!(group(id), None, "{id}");
        }
    }

    #[test]
    fn reorder_sets_one_complete_sibling_group() {
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
        let epic = create(&root, draft(StoryKind::Epic, None, "Epic")).unwrap();
        let feature = create(&root, draft(StoryKind::Feature, Some(&epic.id), "F")).unwrap();
        let a = create(&root, draft(StoryKind::Story, Some(&feature.id), "A")).unwrap();
        let b = create(&root, draft(StoryKind::Story, Some(&feature.id), "B")).unwrap();
        let loose = create(&root, draft(StoryKind::Story, None, "Loose")).unwrap();
        reorder(&root, &[b.id.clone(), a.id.clone()]).unwrap();
        let board = load(&root).unwrap();
        let ids: Vec<_> = board_order(&board).iter().map(|s| &s.id).collect();
        assert_eq!(ids, [&epic.id, &feature.id, &b.id, &a.id, &loose.id]);
        // A partial group, another group's member or a duplicate leaves the store alone.
        for bad in [
            vec![a.id.clone()],
            vec![a.id.clone(), loose.id.clone()],
            vec![a.id.clone(), a.id.clone()],
            vec![],
        ] {
            assert!(reorder(&root, &bad).is_err());
        }
        assert_eq!(load(&root).unwrap(), board);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_preserves_saved_status_across_edits_and_reload() {
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
        let item = create(&root, draft(StoryKind::Story, None, "Story")).unwrap();
        for status in [
            StoryStatus::Planned,
            StoryStatus::Building,
            StoryStatus::Reviewing,
            StoryStatus::Merging,
            StoryStatus::Backlog,
        ] {
            for next in [status, StoryStatus::Done, StoryStatus::Done] {
                update(
                    &root,
                    &item.id,
                    StoryPatch {
                        status: Some(next),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
            let saved = load(&root).unwrap().remove(0);
            assert_eq!(saved.previous_status, Some(status));
            let reopened = update(
                &root,
                &item.id,
                StoryPatch {
                    reopen: true,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(reopened.status, status);
            assert_eq!(reopened.previous_status, None);
        }
        let mut legacy = serde_json::to_value(&item).unwrap();
        legacy.as_object_mut().unwrap().remove("previousStatus");
        legacy.as_object_mut().unwrap().remove("completedHead");
        let mut legacy = serde_json::from_value::<Story>(legacy).unwrap();
        assert_eq!(legacy.previous_status, None);
        assert_eq!(legacy.reopened_status(), StoryStatus::Backlog);
        legacy.task = Some("task".into());
        assert_eq!(legacy.reopened_status(), StoryStatus::Planned);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_stale_workflow_write_preserves_manual_completion() {
        let root = std::env::temp_dir().join(format!("patchbay-stories-{}", uuid::Uuid::new_v4()));
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        let item = create(&root, draft(StoryKind::Story, None, "Story")).unwrap();
        let done = update(
            &root,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Done),
                ..Default::default()
            },
        )
        .unwrap();
        let current = update(
            &root,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Reviewing),
                expected_progress: Some(ExpectedProgress {
                    status: item.status,
                    task: item.task,
                    auto_run_id: item.auto_run_id,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(current, done);
        assert_eq!(load(&root).unwrap(), std::slice::from_ref(&done));
        // Linkage sent with a stale status still applies; only the status is skipped.
        let linked = update(
            &root,
            &item.id,
            StoryPatch {
                auto_run_id: Some("run".into()),
                status: Some(StoryStatus::Reviewing),
                expected_progress: Some(ExpectedProgress {
                    status: StoryStatus::Backlog,
                    task: None,
                    auto_run_id: None,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(linked.status, StoryStatus::Done);
        assert_eq!(linked.auto_run_id.as_deref(), Some("run"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn acceptance_criteria_are_trimmed_on_create_and_update() {
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
        let mut story = draft(StoryKind::Story, None, "Story");
        story.acceptance = vec![" Works ".into(), String::new(), "  ".into()];
        let item = create(&root, story).unwrap();
        assert_eq!(item.acceptance, ["Works"]);
        let edited = update(
            &root,
            &item.id,
            StoryPatch {
                acceptance: Some(vec!["".into(), " Fast ".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(edited.acceptance, ["Fast"]);
        std::fs::remove_dir_all(root).unwrap();
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
        // The last stage seen was Merge, but reopening merged work resumes it as Planned.
        update(
            &root,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Merging),
                ..Default::default()
            },
        )
        .unwrap();
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Done);
        assert_eq!(
            load(&root).unwrap()[0].previous_status,
            Some(StoryStatus::Planned)
        );
        // The poll invokes the backend again for an already integrated branch.
        // Reopen preserves the task but acknowledges its old HEAD atomically.
        let reopened = update(
            &root,
            &item.id,
            StoryPatch {
                reopen: true,
                auto_run_id: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(reopened.status, StoryStatus::Planned);
        assert_eq!(reopened.task.as_deref(), Some(task.id.as_str()));
        for _ in 0..2 {
            complete_merge(&root, &worktree).unwrap();
            assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        }
        assert!(complete_auto(&root, &task.id, "new").unwrap().is_empty());
        git(
            &worktree,
            &["commit", "--allow-empty", "-qm", "reopened work"],
        );
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
        // Manual completion then Reopen must not detach an unfinished Auto run.
        update(
            &root,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Done),
                ..Default::default()
            },
        )
        .unwrap();
        let reopened = update(
            &root,
            &item.id,
            StoryPatch {
                reopen: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(reopened.auto_run_id.as_deref(), Some("next"));
        assert_eq!(reopened.status, StoryStatus::Planned);
        // That manual completion acknowledged nothing, so merging new work still completes it.
        git(
            &worktree,
            &["commit", "--allow-empty", "-qm", "manual work"],
        );
        let reopen = || {
            update(
                &root,
                &item.id,
                StoryPatch {
                    reopen: true,
                    ..Default::default()
                },
            )
            .unwrap()
        };
        update(
            &root,
            &item.id,
            StoryPatch {
                status: Some(StoryStatus::Done),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(reopen().status, StoryStatus::Planned);
        git(&root, &["merge", "--ff-only", "story"]);
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Done);
        // Reopening a merge its Auto run made also ends that run's claim, in the backend.
        let reopened = reopen();
        assert_eq!(reopened.status, StoryStatus::Planned);
        assert_eq!(reopened.auto_run_id, None);
        assert!(complete_auto(&root, &task.id, "next").unwrap().is_empty());
        complete_merge(&root, &worktree).unwrap();
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        update(
            &root,
            &item.id,
            StoryPatch {
                auto_run_id: Some("next".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            complete_auto(&root, &task.id, "next").unwrap()[0].status,
            StoryStatus::Done
        );
        git(&root, &["worktree", "remove", worktree.to_str().unwrap()]);
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Done);
        let completed = load(&root).unwrap().remove(0);
        assert_eq!(completed.previous_status, Some(StoryStatus::Planned));
        update(
            &root,
            &item.id,
            StoryPatch {
                reopen: true,
                auto_run_id: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(complete_auto(&root, &task.id, "next").unwrap().is_empty());
        assert_eq!(load(&root).unwrap()[0].status, StoryStatus::Planned);
        remove(&root, &item.id, true).unwrap();
        assert!(planner_section(&root, Some(&item.id)).unwrap().is_none());
        assert!(planner_section(&root, None).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn repo() -> std::path::PathBuf {
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
        root
    }

    fn external(id: &str, kind: StoryKind, parent: Option<&str>, title: &str) -> ExternalItem {
        ExternalItem {
            external_id: id.into(),
            kind,
            title: title.into(),
            parent: parent.map(Into::into),
            description: format!("{title} body"),
            acceptance: vec![" Works ".into(), String::new()],
            url: Some(format!("https://tracker.example/{id}")),
        }
    }

    #[test]
    fn import_creates_hierarchy_then_updates_text_without_duplicating() {
        let root = repo();
        let local = create(&root, draft(StoryKind::Story, None, "Local")).unwrap();
        // Children before parents: the import orders epics, features, then stories.
        let batch = vec![
            external("issue-1", StoryKind::Story, Some("milestone-1"), "Issue"),
            external(
                "issue-2",
                StoryKind::Story,
                Some("never-imported"),
                "Orphan",
            ),
            external("milestone-1", StoryKind::Feature, Some("repo"), "Milestone"),
            external("repo", StoryKind::Epic, None, "Repo"),
        ];
        let report = upsert_external(&root, "acme.tracker", batch.clone()).unwrap();
        assert_eq!(
            report,
            ImportReport {
                created: 4,
                updated: 0,
                unchanged: 0
            }
        );
        let board = load(&root).unwrap();
        let by = |id: &str| {
            board
                .iter()
                .find(|s| s.source.as_ref().is_some_and(|src| src.external_id == id))
                .unwrap()
        };
        assert_eq!(
            by("issue-1").parent.as_deref(),
            Some(by("milestone-1").id.as_str())
        );
        assert_eq!(
            by("milestone-1").parent.as_deref(),
            Some(by("repo").id.as_str())
        );
        assert_eq!(by("issue-2").parent, None);
        assert_eq!(by("issue-1").acceptance, ["Works"]);
        assert!(board.iter().any(|s| s.id == local.id && s.source.is_none()));

        // Workflow edits survive a re-import; tracker text is replaced.
        let issue = by("issue-1").id.clone();
        update(
            &root,
            &issue,
            StoryPatch {
                title: Some("Edited locally".into()),
                components: Some(vec!["api".into()]),
                status: Some(StoryStatus::Building),
                ..StoryPatch::default()
            },
        )
        .unwrap();
        let mut again = batch;
        again[0].title = "Issue renamed".into();
        let report = upsert_external(&root, "acme.tracker", again).unwrap();
        assert_eq!(
            report,
            ImportReport {
                created: 0,
                updated: 1,
                unchanged: 3
            }
        );
        let board = load(&root).unwrap();
        assert_eq!(board.len(), 5);
        let item = board.iter().find(|s| s.id == issue).unwrap();
        assert_eq!(item.title, "Issue renamed");
        assert_eq!(item.components, ["api"]);
        assert_eq!(item.status, StoryStatus::Building);
        // Another extension's ids are its own.
        upsert_external(
            &root,
            "other.tracker",
            vec![external("issue-1", StoryKind::Story, None, "Other")],
        )
        .unwrap();
        assert_eq!(load(&root).unwrap().len(), 6);
        let section = section(&load(&root).unwrap(), &issue).unwrap().body;
        assert!(section.contains("Tracker: https://tracker.example/issue-1"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reimport_keeps_local_parent_until_tracker_names_one() {
        let root = repo();
        let epic = create(&root, draft(StoryKind::Epic, None, "Local epic")).unwrap();
        let feature = create(
            &root,
            draft(StoryKind::Feature, Some(&epic.id), "Local feature"),
        )
        .unwrap();
        let issue = external("issue", StoryKind::Story, None, "Issue");
        upsert_external(&root, "acme.tracker", vec![issue.clone()]).unwrap();
        let id = load(&root)
            .unwrap()
            .into_iter()
            .find(|s| s.source.is_some())
            .unwrap()
            .id;
        update(
            &root,
            &id,
            StoryPatch {
                parent: Some(feature.id.clone()),
                ..StoryPatch::default()
            },
        )
        .unwrap();
        let report = upsert_external(&root, "acme.tracker", vec![issue.clone()]).unwrap();
        assert_eq!(report.unchanged, 1);
        assert_eq!(
            load(&root)
                .unwrap()
                .into_iter()
                .find(|s| s.id == id)
                .unwrap()
                .parent,
            Some(feature.id)
        );
        let mut issue = issue;
        issue.parent = Some("remote-feature".into());
        upsert_external(
            &root,
            "acme.tracker",
            vec![
                issue,
                external(
                    "remote-feature",
                    StoryKind::Feature,
                    Some("remote-epic"),
                    "Tracker feature",
                ),
                external("remote-epic", StoryKind::Epic, None, "Tracker epic"),
            ],
        )
        .unwrap();
        let board = load(&root).unwrap();
        let issue = board.iter().find(|s| s.id == id).unwrap();
        let parent = board
            .iter()
            .find(|s| Some(&s.id) == issue.parent.as_ref())
            .unwrap();
        assert_eq!(parent.title, "Tracker feature");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn csv_reimport_adopts_an_unambiguous_row_number_id() {
        let root = repo();
        let extension = "patchbay.story-import";
        let old = external("csv:first-1", StoryKind::Story, None, "First");
        upsert_external(&root, extension, vec![old]).unwrap();
        let id = load(&root).unwrap().pop().unwrap().id;

        let report = upsert_external(
            &root,
            extension,
            vec![
                external("csv:new~1234567890abcdef", StoryKind::Story, None, "New"),
                external(
                    "csv:first~1234567890abcdef",
                    StoryKind::Story,
                    None,
                    "First",
                ),
            ],
        )
        .unwrap();
        assert_eq!((report.created, report.updated), (1, 1));
        let board = load(&root).unwrap();
        let first = board.iter().find(|story| story.title == "First").unwrap();
        assert_eq!(first.id, id);
        assert_eq!(
            first.source.as_ref().unwrap().external_id,
            "csv:first~1234567890abcdef"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_is_all_or_nothing() {
        let root = repo();
        let ok = external("ok", StoryKind::Epic, None, "Fine");
        let mut no_title = external("blank", StoryKind::Story, None, " ");
        no_title.title = " ".into();
        let mut bad_url = external("url", StoryKind::Story, None, "Bad url");
        bad_url.url = Some("file:///etc/passwd".into());
        for bad in [
            vec![ok.clone(), no_title],
            vec![ok.clone(), bad_url],
            vec![ok.clone(), ok.clone()],
            vec![
                ok.clone(),
                external("f", StoryKind::Feature, Some("missing"), "No epic"),
            ],
            vec![
                ok.clone(),
                external("e", StoryKind::Epic, Some("ok"), "Nested epic"),
            ],
        ] {
            assert!(upsert_external(&root, "acme.tracker", bad).is_err());
        }
        assert!(load(&root).unwrap().is_empty());
        upsert_external(&root, "acme.tracker", vec![ok]).unwrap();
        assert!(
            upsert_external(
                &root,
                "acme.tracker",
                vec![external("ok", StoryKind::Story, None, "Kind changed")]
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
