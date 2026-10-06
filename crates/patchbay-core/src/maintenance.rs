//! Reviewed structural maintenance. Detection never replaces user configuration.
use crate::access::AccessSnapshot;
use crate::extensions::DetectorContribution;
use crate::model::{Component, DetectionProvenance, Link, Project, SCHEMA_VERSION};
use crate::{detect, model};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueKind {
    Missing,
    Locked,
    Unreadable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapIssue {
    pub component_id: String,
    pub kind: IssueKind,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    AddComponent {
        component: Component,
    },
    AddLink {
        link: Link,
    },
    RemoveLink {
        #[serde(rename = "linkId")]
        link_id: String,
    },
    RemoveComponent {
        #[serde(rename = "componentId")]
        component_id: String,
    },
    MoveComponent {
        #[serde(rename = "componentId")]
        component_id: String,
        path: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub selected: bool,
    pub description: String,
    pub change: Change,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationPreview {
    pub id: String,
    pub access_revision: u64,
    pub issues: Vec<MapIssue>,
    pub proposals: Vec<Proposal>,
}

/// Check only permitted folders, distinguishing missing paths from denied access.
#[must_use]
pub fn issues(project: &Project, access: &AccessSnapshot) -> Vec<MapIssue> {
    project
        .components
        .iter()
        .filter_map(|c| {
            let (kind, message) = if !access.allows_path(&c.path) {
                (
                    IssueKind::Locked,
                    "Folder access is not granted; choose Browse… to allow it".into(),
                )
            } else {
                match std::fs::metadata(Path::new(&project.root).join(&c.path)) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
                        IssueKind::Missing,
                        "Folder is missing; review a move or choose Browse…".into(),
                    ),
                    Err(e) => (IssueKind::Unreadable, e.to_string()),
                    Ok(meta) if !meta.is_dir() => (
                        IssueKind::Unreadable,
                        "The component path is not a folder".into(),
                    ),
                    Ok(_) if access.readable(&c.path).is_none() => (
                        IssueKind::Locked,
                        "Folder resolves outside the allowed roots".into(),
                    ),
                    Ok(_) => match std::fs::read_dir(Path::new(&project.root).join(&c.path)) {
                        Ok(_) => return None,
                        Err(e) => (IssueKind::Unreadable, e.to_string()),
                    },
                }
            };
            Some(MapIssue {
                component_id: c.id.clone(),
                kind,
                message,
            })
        })
        .collect()
}

fn responsible_scan(
    component: &Component,
    project: &Project,
    available: &HashSet<String>,
    responsible: &str,
    scanned: &HashSet<(std::path::PathBuf, String)>,
) -> bool {
    let Some(origin) = &component.detection else {
        return false;
    };
    if origin.detector != responsible
        || !available.contains(responsible)
        || !scanned.contains(&(project.component_dir(component), responsible.to_string()))
    {
        return false;
    }
    let dir = project.component_dir(component);
    // Detection's forgiving readers must not turn malformed/unreadable manifests into removals.
    for file in [
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "requirements.txt",
        "go.mod",
    ] {
        let path = dir.join(file);
        if std::fs::symlink_metadata(&path).is_ok()
            && !path.canonicalize().is_ok_and(|p| p.starts_with(&dir))
        {
            return false;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                let valid = match file {
                    "package.json" => serde_json::from_str::<serde_json::Value>(&text)
                        .is_ok_and(|v| v.is_object()),
                    "Cargo.toml" | "pyproject.toml" => toml::from_str::<toml::Value>(&text).is_ok(),
                    _ => true,
                };
                if !valid {
                    return false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    // Declarative extension detectors report component markers, not dependency snapshots.
    // They cannot authoritatively prove their old relationships absent.
    if origin.detector != "builtin" {
        return false;
    }
    true
}

/// Append one folder's scan to the combined result. Every scan numbers its ids on its own,
/// and the later id-keyed maps would conflate two components sharing one, so colliding ids
/// are renamed (and that scan's links rewritten) first.
fn append_scan(into: &mut Project, found: Project) {
    let mut taken: HashSet<String> = into.components.iter().map(|c| c.id.clone()).collect();
    let mut renamed = HashMap::new();
    for mut c in found.components {
        let mut id = c.id.clone();
        let mut n = 2;
        while !taken.insert(id.clone()) {
            id = format!("{}-{n}", c.id);
            n += 1;
        }
        if id != c.id {
            renamed.insert(std::mem::replace(&mut c.id, id.clone()), id);
        }
        into.components.push(c);
    }
    for mut link in found.links {
        for end in [&mut link.source, &mut link.target] {
            if let Some(id) = renamed.get(end.as_str()) {
                end.clone_from(id);
            }
        }
        link.id = format!("{}->{}", link.source, link.target);
        into.links.push(link);
    }
}

/// Build proposals using only canonical allowed roots. Existing records are never rewritten.
/// # Errors
/// Fails if the project or its root cannot be scanned.
pub fn preview(
    project: &Project,
    access: &AccessSnapshot,
    detectors: &[DetectorContribution],
) -> Result<ReconciliationPreview> {
    project.validate()?;
    let issues = issues(project, access);
    let unavailable: HashSet<_> = issues.iter().map(|i| i.component_id.clone()).collect();
    let missing: HashSet<_> = issues
        .iter()
        .filter(|i| i.kind == IssueKind::Missing)
        .map(|i| i.component_id.clone())
        .collect();
    let mut detected = detect::detect_with(Path::new(&project.root), detectors)?;
    let roots: std::collections::BTreeSet<_> = project.external_dirs().into_iter().collect();
    for dir in &roots {
        if !access.is_granted(dir) || roots.iter().any(|o| o != dir && dir.starts_with(o)) {
            continue;
        }
        if let Ok(found) = detect::detect_folder_with(project, dir, detectors) {
            // Collect every scanned dependency, including links between pre-existing nodes.
            append_scan(&mut detected, found);
        }
    }
    let mut scanned_folders = HashSet::new();
    detected.components.retain(|c| {
        access.readable(&c.path).is_some()
            && scanned_folders.insert(model::resolve_dir(&Path::new(&project.root).join(&c.path)))
    });
    let mut merged = project.clone();
    detect::merge_new(&mut merged, detected.clone());
    let old_ids: HashSet<_> = project.components.iter().map(|c| c.id.as_str()).collect();
    let new: Vec<_> = merged
        .components
        .iter()
        .filter(|c| !old_ids.contains(c.id.as_str()))
        .cloned()
        .collect();
    let mut proposals = Vec::new();
    let mut moved_candidates = HashSet::new();
    for old in project
        .components
        .iter()
        .filter(|c| missing.contains(&c.id))
    {
        if let Some(identity) = old
            .detection
            .as_ref()
            .filter(|d| d.package_identity.is_some())
        {
            let candidates: Vec<_> = new
                .iter()
                .filter(|c| c.detection.as_ref() == Some(identity))
                .collect();
            // Both directions must be unique: two missing packages sharing a name are ambiguous.
            let matching_old = project
                .components
                .iter()
                .filter(|c| missing.contains(&c.id) && c.detection.as_ref() == Some(identity))
                .count();
            if candidates.len() == 1 && matching_old == 1 {
                let candidate = candidates[0];
                moved_candidates.insert(candidate.id.clone());
                proposals.push(Proposal {
                    id: format!("move:{}", old.id),
                    selected: false,
                    description: format!("Repair {}: {} → {}", old.name, old.path, candidate.path),
                    change: Change::MoveComponent {
                        component_id: old.id.clone(),
                        path: candidate.path.clone(),
                    },
                });
            }
        }
        proposals.push(Proposal {
            id: format!("remove:{}", old.id),
            selected: false,
            description: format!(
                "Remove missing component {} and its relationships",
                old.name
            ),
            change: Change::RemoveComponent {
                component_id: old.id.clone(),
            },
        });
    }
    for component in &new {
        proposals.push(Proposal {
            id: format!("add:{}", component.id),
            selected: !moved_candidates.contains(&component.id),
            description: format!("Add {} ({})", component.name, component.path),
            change: Change::AddComponent {
                component: component.clone(),
            },
        });
    }
    let by_dir: HashMap<_, _> = merged
        .components
        .iter()
        .map(|c| (merged.component_dir(c), c.id.clone()))
        .collect();
    let remap: HashMap<_, _> = detected
        .components
        .iter()
        .filter_map(|c| {
            by_dir
                .get(&detected.component_dir(c))
                .map(|id| (c.id.clone(), id.clone()))
        })
        .collect();
    let pairs: HashSet<_> = project
        .links
        .iter()
        .map(|l| (l.source.clone(), l.target.clone()))
        .collect();
    let mut detected_pairs = HashSet::new();
    let scanned: HashSet<_> = detected
        .components
        .iter()
        .filter_map(|c| {
            c.detection
                .as_ref()
                .map(|d| (detected.component_dir(c), d.detector.clone()))
        })
        .collect();
    for mut link in detected.links {
        let (Some(source), Some(target)) = (remap.get(&link.source), remap.get(&link.target))
        else {
            continue;
        };
        link.source.clone_from(source);
        link.target.clone_from(target);
        link.id = format!("{source}->{target}");
        // Duplicate endpoint relationships preserve the user's label and origin.
        if !detected_pairs.insert((source.clone(), target.clone()))
            || pairs.contains(&(source.clone(), target.clone()))
        {
            continue;
        }
        let selected = !moved_candidates.contains(source) && !moved_candidates.contains(target);
        proposals.push(Proposal {
            id: format!("link:{}", link.id),
            selected,
            description: format!("Add dependency {source} → {target}"),
            change: Change::AddLink { link },
        });
    }
    let available: HashSet<_> = std::iter::once("builtin".into())
        .chain(detectors.iter().map(|d| d.id.clone()))
        .collect();
    for link in &project.links {
        let Some(origin) = &link.detection else {
            continue;
        };
        if !available.contains(&origin.detector)
            || detected_pairs.contains(&(link.source.clone(), link.target.clone()))
        {
            continue;
        }
        let endpoints = [
            project.component(&link.source),
            project.component(&link.target),
        ];
        if endpoints.into_iter().all(|c| {
            c.is_some_and(|c| {
                !unavailable.contains(&c.id)
                    && responsible_scan(c, project, &available, &origin.detector, &scanned)
            })
        }) {
            proposals.push(Proposal {
                id: format!("unlink:{}", link.id),
                selected: false,
                description: format!(
                    "Remove stale detected dependency {} → {}",
                    link.source, link.target
                ),
                change: Change::RemoveLink {
                    link_id: link.id.clone(),
                },
            });
        }
    }
    Ok(ReconciliationPreview {
        id: String::new(),
        access_revision: access.revision(),
        issues,
        proposals,
    })
}

/// Components whose paths or existence will change, requiring stopped work.
#[must_use]
pub fn affected(preview: &ReconciliationPreview, selected: &[String]) -> Vec<String> {
    preview
        .proposals
        .iter()
        .filter(|p| selected.contains(&p.id))
        .filter_map(|p| match &p.change {
            Change::RemoveComponent { component_id }
            | Change::MoveComponent { component_id, .. } => Some(component_id.clone()),
            _ => None,
        })
        .collect()
}

/// Apply reviewed proposals to a draft. Persistence is deliberately separate.
/// # Errors
/// Rejects unknown selections, conflicting move/add/removal choices and invalid relationships.
pub fn apply(
    project: &Project,
    preview: &ReconciliationPreview,
    selected: &[String],
) -> Result<Project> {
    ensure!(
        selected
            .iter()
            .all(|id| preview.proposals.iter().any(|p| &p.id == id)),
        "Unknown proposal; refresh the preview"
    );
    let proposals: Vec<_> = preview
        .proposals
        .iter()
        .filter(|p| selected.contains(&p.id))
        .collect();
    let mut draft = project.clone();
    for proposal in &proposals {
        match &proposal.change {
            Change::AddComponent { component } => {
                ensure!(
                    draft.component(&component.id).is_none(),
                    "Component already exists"
                );
                draft.components.push(component.clone());
            }
            Change::MoveComponent { component_id, path } => {
                ensure!(!proposals.iter().any(|p| matches!(&p.change, Change::RemoveComponent { component_id: id } if id == component_id)), "Choose either path repair or removal");
                let target = model::resolve_dir(&Path::new(&draft.root).join(path));
                ensure!(
                    !draft
                        .components
                        .iter()
                        .any(|c| c.id != *component_id && draft.component_dir(c) == target),
                    "Choose either the move repair or the matching new component"
                );
                let c = draft
                    .components
                    .iter_mut()
                    .find(|c| c.id == *component_id)
                    .ok_or_else(|| anyhow::anyhow!("Component no longer exists"))?;
                c.path.clone_from(path);
            }
            _ => {}
        }
    }
    let moved_ids: HashMap<String, String> = proposals
        .iter()
        .filter_map(|p| {
            let Change::MoveComponent { component_id, path } = &p.change else {
                return None;
            };
            preview.proposals.iter().find_map(|candidate| {
                let Change::AddComponent { component } = &candidate.change else {
                    return None;
                };
                (component.path == *path).then(|| (component.id.clone(), component_id.clone()))
            })
        })
        .collect();
    for proposal in proposals {
        match &proposal.change {
            Change::AddLink { link: original } => {
                let mut link = original.clone();
                if let Some(id) = moved_ids.get(&link.source) {
                    link.source.clone_from(id);
                }
                if let Some(id) = moved_ids.get(&link.target) {
                    link.target.clone_from(id);
                }
                if link.source != original.source || link.target != original.target {
                    link.id = format!("{}->{}", link.source, link.target);
                }
                if draft
                    .links
                    .iter()
                    .any(|l| l.source == link.source && l.target == link.target)
                {
                    continue;
                }
                ensure!(
                    draft.component(&link.source).is_some()
                        && draft.component(&link.target).is_some(),
                    "Select the new components required by this dependency"
                );
                ensure!(
                    !draft.links.iter().any(|l| l.id == link.id),
                    "Link ID already exists"
                );
                draft.links.push(link);
            }
            Change::RemoveLink { link_id } => draft.links.retain(|l| l.id != *link_id),
            Change::RemoveComponent { component_id } => {
                draft.components.retain(|c| c.id != *component_id);
                draft
                    .links
                    .retain(|l| l.source != *component_id && l.target != *component_id);
                for group in &mut draft.groups {
                    group.component_ids.retain(|id| id != component_id);
                }
            }
            _ => {}
        }
    }
    for proposal in preview
        .proposals
        .iter()
        .filter(|p| selected.contains(&p.id))
    {
        if let Change::MoveComponent { path, .. } = &proposal.change {
            let dir = model::resolve_dir(&Path::new(&draft.root).join(path));
            ensure!(
                draft
                    .components
                    .iter()
                    .filter(|c| draft.component_dir(c) == dir)
                    .count()
                    == 1,
                "Choose either the move repair or the matching new component"
            );
        }
    }
    draft.schema_version = SCHEMA_VERSION;
    draft.validate()?;
    Ok(draft)
}

/// An explicit user classification; rescanning never infers ownership for legacy records.
#[must_use]
pub fn manual() -> DetectionProvenance {
    DetectionProvenance {
        detector: "manual".into(),
        package_identity: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Access;
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("patchbay-maintenance-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
        fn package(&self, folder: &str, name: &str, deps: &[&str]) {
            let dir = self.0.join(folder);
            std::fs::create_dir_all(&dir).unwrap();
            let dependencies: serde_json::Map<String, serde_json::Value> =
                deps.iter().map(|d| (d.to_string(), json!("*"))).collect();
            std::fs::write(
                dir.join("package.json"),
                json!({"name":name,"dependencies": dependencies}).to_string(),
            )
            .unwrap();
        }
        fn detected(&self) -> (Project, Access) {
            let project = detect::detect(&self.0).unwrap();
            let access = Access::default();
            access.open(&project).unwrap();
            (project, access)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn removals(preview: &ReconciliationPreview) -> usize {
        preview
            .proposals
            .iter()
            .filter(|p| matches!(p.change, Change::RemoveLink { .. }))
            .count()
    }

    #[test]
    fn legacy_records_stay_unclassified_and_manual_configuration_survives() {
        let f = Fixture::new();
        f.package("web", "web", &["api"]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        project.schema_version = 3;
        for c in &mut project.components {
            c.detection = None;
            c.name = format!("User {}", c.name);
            c.notes = "retain these notes".into();
            c.position.x = 92.0;
        }
        project.links[0].detection = None;
        project.links[0].label = Some("Manual label".into());
        f.package("web", "web", &[]);
        f.package("new", "new", &[]);
        let before = serde_json::to_value(&project).unwrap();
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert_eq!(removals(&review), 0);
        assert_eq!(review.proposals.len(), 1);
        assert!(review.proposals[0].selected);
        let draft = apply(
            &project,
            &review,
            std::slice::from_ref(&review.proposals[0].id),
        )
        .unwrap();
        for original in before["components"].as_array().unwrap() {
            let kept = draft.component(original["id"].as_str().unwrap()).unwrap();
            assert_eq!(serde_json::to_value(kept).unwrap(), *original);
            assert!(kept.detection.is_none());
        }
        assert_eq!(draft.links[0].label.as_deref(), Some("Manual label"));
        assert!(draft.links[0].detection.is_none());
        assert_eq!(draft.schema_version, SCHEMA_VERSION);
        assert!(
            !f.0.join(model::PROJECT_FILE).exists(),
            "Apply must not Save"
        );
    }

    #[test]
    fn detects_dependencies_between_existing_components_without_replacing_manual_links() {
        let f = Fixture::new();
        f.package("web", "web", &[]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        f.package("web", "web", &["api"]);
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert_eq!(review.proposals.len(), 1);
        assert!(review.proposals[0].selected);
        assert!(matches!(review.proposals[0].change, Change::AddLink { .. }));
        project.links.push(
            serde_json::from_value(
                json!({"id":"custom","source":"web","target":"api","label":"REST"}),
            )
            .unwrap(),
        );
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert!(review.proposals.is_empty());
        assert!(project.links[0].detection.is_none());
    }

    #[test]
    fn stale_detected_links_require_positive_scans_and_manual_links_never_remove() {
        let f = Fixture::new();
        f.package("web", "web", &["api"]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        f.package("web", "web", &[]);
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert_eq!(removals(&review), 1);
        assert!(!review.proposals[0].selected);
        std::fs::write(f.0.join("web/package.json"), "{invalid").unwrap();
        assert_eq!(
            removals(&preview(&project, &access.snapshot(), &[]).unwrap()),
            0
        );
        f.package("web", "web", &[]);
        project.links[0].detection = Some(manual());
        assert_eq!(
            removals(&preview(&project, &access.snapshot(), &[]).unwrap()),
            0
        );
        project.links[0].detection = Some(DetectionProvenance {
            detector: "extension:missing:detector".into(),
            package_identity: None,
        });
        assert_eq!(
            removals(&preview(&project, &access.snapshot(), &[]).unwrap()),
            0
        );
    }

    #[test]
    fn link_detector_must_match_both_successfully_scanned_endpoints() {
        let f = Fixture::new();
        f.package("web", "web", &["api"]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        f.package("web", "web", &[]);
        project
            .components
            .iter_mut()
            .find(|c| c.id == "api")
            .unwrap()
            .detection = Some(DetectionProvenance {
            detector: "extension:other:detector".into(),
            package_identity: None,
        });
        assert_eq!(
            removals(&preview(&project, &access.snapshot(), &[]).unwrap()),
            0
        );
    }

    #[test]
    fn external_scans_sharing_an_id_keep_each_components_relationships() {
        let f = Fixture::new();
        f.package("proj/api", "api", &["lib"]);
        f.package("proj/lib", "lib", &[]);
        f.package("api", "api", &[]);
        let root = f.0.join("proj");
        let mut project = detect::detect(&root).unwrap();
        let access = Access::default();
        access.open(&project).unwrap();
        access.grant(&f.0.join("api")).unwrap();
        let external = detect::detect_folder(&project, &f.0.join("api")).unwrap();
        assert!(detect::merge_new(&mut project, external) > 0);
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert!(
            review.proposals.is_empty(),
            "{:?}",
            review
                .proposals
                .iter()
                .map(|p| &p.description)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn missing_locked_and_non_directory_are_distinct_and_do_not_remove_links() {
        let f = Fixture::new();
        f.package("web", "web", &["api"]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        std::fs::remove_dir_all(f.0.join("api")).unwrap();
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert_eq!(review.issues[0].kind, IssueKind::Missing);
        assert_eq!(removals(&review), 0);
        project.components[0].path = "../not-granted".into();
        assert!(
            issues(&project, &access.snapshot())
                .iter()
                .any(|i| i.kind == IssueKind::Locked)
        );
        std::fs::write(f.0.join("file"), "file").unwrap();
        project.components[0].path = "file".into();
        assert!(
            issues(&project, &access.snapshot())
                .iter()
                .any(|i| i.kind == IssueKind::Unreadable)
        );
    }

    #[test]
    fn unique_package_move_preserves_id_configuration_and_requires_selection() {
        let f = Fixture::new();
        f.package("old", "same-package", &[]);
        let (mut project, access) = f.detected();
        project.components[0].name = "Custom name".into();
        project.components[0].notes = "custom notes".into();
        project.components[0].position.x = 567.0;
        std::fs::rename(f.0.join("old"), f.0.join("new")).unwrap();
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        let proposal = review
            .proposals
            .iter()
            .find(|p| matches!(p.change, Change::MoveComponent { .. }))
            .unwrap();
        assert!(!proposal.selected);
        assert!(review.proposals.iter().all(|p| !p.selected));
        let draft = apply(&project, &review, std::slice::from_ref(&proposal.id)).unwrap();
        assert_eq!(draft.components[0].id, "old");
        assert_eq!(draft.components[0].path, "new");
        assert_eq!(draft.components[0].name, "Custom name");
        assert_eq!(draft.components[0].notes, "custom notes");
        assert_eq!(draft.components[0].position.x, 567.0);
        let mut expected = project.components[0].clone();
        expected.path = "new".into();
        assert_eq!(
            serde_json::to_value(&draft.components[0]).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        let add = review
            .proposals
            .iter()
            .find(|p| matches!(p.change, Change::AddComponent { .. }))
            .unwrap();
        assert!(apply(&project, &review, &[proposal.id.clone(), add.id.clone()]).is_err());
    }

    #[test]
    fn ambiguous_or_unclassified_packages_never_suggest_moves() {
        let f = Fixture::new();
        f.package("old", "same", &[]);
        let (mut project, access) = f.detected();
        std::fs::remove_dir_all(f.0.join("old")).unwrap();
        f.package("one", "same", &[]);
        f.package("two", "same", &[]);
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        assert!(
            !review
                .proposals
                .iter()
                .any(|p| matches!(p.change, Change::MoveComponent { .. }))
        );
        project.components[0].detection = None;
        std::fs::remove_dir_all(f.0.join("two")).unwrap();
        assert!(
            !preview(&project, &access.snapshot(), &[])
                .unwrap()
                .proposals
                .iter()
                .any(|p| matches!(p.change, Change::MoveComponent { .. }))
        );
    }

    #[test]
    fn removal_cleans_incident_links_and_groups_and_unknown_selections_fail() {
        let f = Fixture::new();
        f.package("web", "web", &["api"]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        project.groups.push(
            serde_json::from_value(
                json!({"id":"dev","name":"Development","componentIds":["web","api"]}),
            )
            .unwrap(),
        );
        std::fs::remove_dir_all(f.0.join("api")).unwrap();
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        let draft = apply(&project, &review, &["remove:api".into()]).unwrap();
        assert!(draft.component("api").is_none());
        assert!(draft.links.is_empty());
        assert_eq!(draft.groups[0].component_ids, ["web"]);
        assert!(apply(&project, &review, &["forged-change".into()]).is_err());
    }

    #[test]
    fn unchanged_access_sync_does_not_invalidate_previews_and_folder_changes_do() {
        let f = Fixture::new();
        f.package("web", "web", &[]);
        let (project, access) = f.detected();
        let revision = access.snapshot().revision();
        access.sync(project.components.iter().map(|c| c.path.clone()).collect());
        assert_eq!(access.snapshot().revision(), revision);
        access.sync(vec!["other".into()]);
        assert_ne!(access.snapshot().revision(), revision);
    }
    #[test]
    fn move_and_new_dependency_remap_to_preserved_component_identity() {
        let f = Fixture::new();
        f.package("old", "same", &[]);
        f.package("api", "api", &[]);
        let (mut project, access) = f.detected();
        project.links.push(
            serde_json::from_value(
                json!({"id":"manual","source":"api","target":"old","label":"Keep manual"}),
            )
            .unwrap(),
        );
        std::fs::rename(f.0.join("old"), f.0.join("new")).unwrap();
        f.package("new", "same", &["api"]);
        let review = preview(&project, &access.snapshot(), &[]).unwrap();
        let selected: Vec<_> = review
            .proposals
            .iter()
            .filter(|p| {
                matches!(
                    p.change,
                    Change::MoveComponent { .. } | Change::AddLink { .. }
                )
            })
            .map(|p| p.id.clone())
            .collect();
        let draft = apply(&project, &review, &selected).unwrap();
        assert_eq!(draft.component("old").unwrap().path, "new");
        assert!(draft.component("new").is_none());
        assert!(
            draft
                .links
                .iter()
                .any(|l| l.source == "old" && l.target == "api")
        );
        assert_eq!(
            draft
                .links
                .iter()
                .find(|l| l.id == "manual")
                .unwrap()
                .label
                .as_deref(),
            Some("Keep manual")
        );
    }
    #[cfg(unix)]
    #[test]
    fn missing_descendants_and_manifests_behind_denied_symlinks_stay_locked() {
        let f = Fixture::new();
        let outside = Fixture::new();
        f.package("web", "web", &[]);
        let (mut project, access) = f.detected();
        std::os::unix::fs::symlink(&outside.0, f.0.join("alias")).unwrap();
        project.components[0].path = "alias/missing".into();
        assert_eq!(
            issues(&project, &access.snapshot())[0].kind,
            IssueKind::Locked
        );
        outside.package("secret", "private-name", &[]);
        std::fs::create_dir_all(f.0.join("leak")).unwrap();
        std::os::unix::fs::symlink(
            outside.0.join("secret/package.json"),
            f.0.join("leak/package.json"),
        )
        .unwrap();
        let detected = detect::detect(&f.0).unwrap();
        assert!(!detected.components.iter().any(|c| c.name == "private-name"));
    }

    #[test]
    fn enabled_component_marker_detector_cannot_establish_stale_dependency_removal() {
        let f = Fixture::new();
        for folder in ["one", "two"] {
            std::fs::create_dir_all(f.0.join(folder)).unwrap();
            std::fs::write(f.0.join(folder).join("custom.marker"), "ok").unwrap();
        }
        let detector = DetectorContribution {
            id: "extension:test:marker".into(),
            files: vec!["custom.marker".into()],
            kind: model::ComponentKind::Other,
            terminals: vec![],
        };
        let mut project = detect::detect_with(&f.0, std::slice::from_ref(&detector)).unwrap();
        project.links.push(serde_json::from_value(json!({"id":"old","source":"one","target":"two","detection":{"detector":"extension:test:marker"}})).unwrap());
        let access = Access::default();
        access.open(&project).unwrap();
        assert_eq!(
            removals(&preview(&project, &access.snapshot(), &[detector]).unwrap()),
            0
        );
    }
}
