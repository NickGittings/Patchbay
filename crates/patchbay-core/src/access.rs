//! Backend-owned folder permissions shared by desktop integrations.

use crate::{Project, model};
use anyhow::{Result, bail};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Only a trusted picker or explicit user consent may open a root or grant a
/// folder. Untrusted component paths can narrow access but cannot grant it.
/// Filesystem checks run on snapshots, never while holding the state lock.
#[derive(Default)]
pub struct Access {
    state: Mutex<AccessSnapshot>,
}

/// A consistent copy of the current permission set for filesystem operations.
#[derive(Default, Clone)]
pub struct AccessSnapshot {
    root: Option<PathBuf>,
    granted: Vec<PathBuf>,
    roots: Vec<PathBuf>,
    watch_roots: Vec<PathBuf>,
    paths: Vec<String>,
    revision: u64,
}

impl Access {
    #[must_use]
    pub fn snapshot(&self) -> AccessSnapshot {
        self.state.lock().unwrap().clone()
    }

    #[must_use]
    pub fn roots(&self) -> Vec<PathBuf> {
        self.state.lock().unwrap().roots.clone()
    }

    /// Approved component folders, including nested folders that enclosing
    /// repositories may ignore. Keep these as independent watcher entry points.
    #[must_use]
    pub fn watch_roots(&self) -> Vec<PathBuf> {
        self.state.lock().unwrap().watch_roots.clone()
    }

    /// Reset permissions for a project opened by a trusted picker.
    ///
    /// # Errors
    /// Fails if the root cannot be resolved or the project has a reserved id.
    pub fn open(&self, project: &Project) -> Result<()> {
        project.validate()?;
        let root = Path::new(&project.root).canonicalize()?;
        {
            let mut state = self.state.lock().unwrap();
            state.revision += 1;
            state.root = Some(root.clone());
            state.granted.clear();
            state.roots = vec![root.clone()];
            state.watch_roots = vec![root];
            state.paths = project.components.iter().map(|c| c.path.clone()).collect();
        }
        self.refresh();
        Ok(())
    }

    /// Grant a folder chosen by the user and refresh the current map, even if
    /// none of its paths changed. Ancestors of the project are never granted.
    ///
    /// # Errors
    /// Fails if no project is open, the folder is missing, or it contains the root.
    pub fn grant(&self, dir: &Path) -> Result<()> {
        let dir = dir.canonicalize()?;
        {
            let mut state = self.state.lock().unwrap();
            let root = state
                .root
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("No project is open"))?;
            model::check_component_dir(root, &dir)?;
            if !dir.starts_with(root) && !state.granted.contains(&dir) {
                state.granted.push(dir);
                state.revision += 1;
            }
        }
        self.refresh();
        Ok(())
    }

    /// Recompute file roots from the component paths currently on the map.
    pub fn sync(&self, paths: Vec<String>) {
        {
            let mut state = self.state.lock().unwrap();
            state.paths = paths;
            state.revision += 1;
        }
        self.refresh();
    }

    fn refresh(&self) {
        loop {
            let snapshot = self.snapshot();
            let Some(root) = snapshot.root.clone() else {
                return;
            };
            let mut roots = vec![root.clone()];
            let mut watch_roots = roots.clone();
            for path in &snapshot.paths {
                if let Some(dir) = snapshot.readable(path) {
                    if !dir.starts_with(&root) && !roots.contains(&dir) {
                        roots.push(dir.clone());
                    }
                    if !watch_roots.contains(&dir) {
                        watch_roots.push(dir);
                    }
                }
            }
            let mut state = self.state.lock().unwrap();
            // A newer map, grant, or opened project wins over an in-flight scan.
            if state.revision == snapshot.revision {
                state.roots = roots;
                state.watch_roots = watch_roots;
                return;
            }
        }
    }
}

impl AccessSnapshot {
    #[must_use]
    pub fn root(&self) -> Option<PathBuf> {
        self.root.clone()
    }

    #[must_use]
    pub fn is_granted(&self, dir: &Path) -> bool {
        self.granted.iter().any(|g| dir.starts_with(g))
    }

    /// Resolve a component path and check it against canonical permissions.
    #[must_use]
    pub fn readable(&self, path: &str) -> Option<PathBuf> {
        let root = self.root.as_ref()?;
        let dir = root.join(path).canonicalize().ok()?;
        (dir.starts_with(root) || self.is_granted(&dir)).then_some(dir)
    }

    /// Replace the caller's root with the one opened by the backend.
    ///
    /// # Errors
    /// Fails if no project is open or a component has a reserved id.
    pub fn trust(&self, project: &mut Project) -> Result<PathBuf> {
        project.validate()?;
        let root = self
            .root
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No project is open"))?;
        project.root = root.display().to_string();
        Ok(root)
    }

    /// Remove locked components and their links from a briefing or launch map.
    ///
    /// # Errors
    /// Fails if a required component is missing or locked, or the map is invalid.
    pub fn restrict(&self, mut project: Project, required: &[String]) -> Result<Project> {
        self.trust(&mut project)?;
        let locked: HashSet<_> = project
            .components
            .iter()
            .filter(|c| self.readable(&c.path).is_none())
            .map(|c| c.id.clone())
            .collect();
        for id in required {
            if project.component(id).is_none() {
                bail!("unknown component {id}");
            }
            if locked.contains(id) {
                bail!(
                    "The folder of {id} is missing or not allowed; pick it with Browse… or Add repo…"
                );
            }
        }
        project.components.retain(|c| !locked.contains(&c.id));
        project
            .links
            .retain(|l| !locked.contains(&l.source) && !locked.contains(&l.target));
        Ok(project)
    }
}

/// Existing external folders a loaded map may ask the user to allow. A saved
/// path containing the root must never expose the enclosing tree.
#[must_use]
pub fn external_candidates(project: &Project, root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for component in &project.components {
        if let Ok(dir) = root.join(&component.path).canonicalize()
            && !dir.starts_with(root)
            && model::check_component_dir(root, &dir).is_ok()
            && !dirs.contains(&dir)
        {
            dirs.push(dir);
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PLAN_SCOPE, PROJECT_FILE, Position, SCHEMA_VERSION};
    use crate::{Component, ComponentKind, Link, detect, files};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "patchbay-access-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            for child in ["shop", "billing/api", "secret"] {
                fs::create_dir_all(dir.join(child)).unwrap();
            }
            fs::write(dir.join("billing/api/invoice.txt"), "invoice").unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn project(&self) -> Project {
            Project {
                schema_version: SCHEMA_VERSION,
                name: "Shop".into(),
                root: self.0.join("shop").display().to_string(),
                components: vec![
                    component("shop", "."),
                    component("billing", "../billing/api"),
                ],
                links: vec![Link {
                    id: "link".into(),
                    source: "shop".into(),
                    target: "billing".into(),
                    label: None,
                }],
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn component(id: &str, path: &str) -> Component {
        Component {
            id: id.into(),
            name: id.into(),
            kind: ComponentKind::Other,
            path: path.into(),
            notes: String::new(),
            terminals: vec![],
            position: Position::default(),
        }
    }

    #[test]
    fn grant_refreshes_files_and_reveal_without_a_path_change() {
        let fixture = Fixture::new();
        let project = fixture.project();
        let access = Access::default();
        access.open(&project).unwrap();
        assert!(files::list_dir(&access.roots(), Path::new("../billing/api")).is_err());
        assert!(files::resolve(&access.roots(), Path::new("../billing/api/invoice.txt")).is_err());
        access.grant(&fixture.0.join("billing/api")).unwrap();
        assert_eq!(
            files::list_dir(&access.roots(), Path::new("../billing/api")).unwrap()[0].name,
            "invoice.txt"
        );
        assert_eq!(
            files::resolve(&access.roots(), Path::new("../billing/api/invoice.txt")).unwrap(),
            fixture.0.join("billing/api/invoice.txt")
        );
    }

    #[test]
    fn add_existing_folder_refreshes_roots_even_when_merge_adds_nothing() {
        let fixture = Fixture::new();
        let mut project = fixture.project();
        let access = Access::default();
        access.open(&project).unwrap();
        let dir = fixture.0.join("billing/api");
        let found = detect::detect_folder(&project, &dir).unwrap();
        let count = project.components.len();
        detect::merge_new(&mut project, found);
        assert_eq!(project.components.len(), count);
        access.grant(&dir).unwrap();
        assert!(files::list_dir(&access.roots(), Path::new("../billing/api")).is_ok());
    }

    #[test]
    fn sync_cannot_grant_folders_and_removal_narrows_file_access() {
        let fixture = Fixture::new();
        let access = Access::default();
        access.open(&fixture.project()).unwrap();
        access.sync(vec!["../secret".into(), "../billing/api".into()]);
        assert_eq!(access.roots(), vec![fixture.0.join("shop")]);
        access.grant(&fixture.0.join("billing")).unwrap();
        assert!(files::list_dir(&access.roots(), Path::new("../billing/api")).is_ok());
        // A grant alone does not expose sibling folders that are absent from the map.
        assert!(files::list_dir(&access.roots(), Path::new("../billing")).is_err());
        access.sync(vec![".".into()]);
        assert!(files::list_dir(&access.roots(), Path::new("../billing/api")).is_err());
    }

    #[test]
    fn watch_roots_include_internal_components_and_only_approved_external_components() {
        let fixture = Fixture::new();
        let mut project = fixture.project();
        fs::create_dir_all(fixture.0.join("shop/child/src")).unwrap();
        project.components.push(component("child", "child/src"));
        let access = Access::default();
        access.open(&project).unwrap();
        let shop = fixture.0.join("shop");
        assert_eq!(access.roots(), vec![shop.clone()]);
        assert_eq!(
            access.watch_roots(),
            vec![shop.clone(), shop.join("child/src")]
        );
        access.grant(&fixture.0.join("billing/api")).unwrap();
        assert!(
            access
                .watch_roots()
                .contains(&fixture.0.join("billing/api"))
        );
        access.sync(vec![".".into(), "../secret".into()]);
        assert_eq!(access.watch_roots(), vec![shop]);
    }

    #[test]
    fn restrictions_report_locked_ids_and_ignore_a_forged_root() {
        let fixture = Fixture::new();
        let mut project = fixture.project();
        let access = Access::default();
        access.open(&project).unwrap();
        project.root = fixture.0.join("secret").display().to_string();
        let snapshot = access.snapshot();
        let error = snapshot
            .restrict(project.clone(), &["billing".into()])
            .unwrap_err();
        assert!(error.to_string().contains("not allowed"));
        assert!(
            snapshot
                .restrict(project.clone(), &["missing".into()])
                .is_err()
        );
        let safe = snapshot.restrict(project.clone(), &[]).unwrap();
        assert_eq!(safe.root, fixture.project().root);
        assert_eq!(safe.components.len(), 1);
        assert!(safe.links.is_empty());
        access.grant(&fixture.0.join("billing")).unwrap();
        assert_eq!(
            access
                .snapshot()
                .restrict(project, &["billing".into()])
                .unwrap()
                .components
                .len(),
            2
        );
    }

    #[test]
    fn ancestors_are_never_granted_and_candidates_are_deduplicated() {
        let fixture = Fixture::new();
        let mut project = fixture.project();
        project.components.extend([
            component("parent", ".."),
            component("duplicate", "../billing/api"),
            component("missing", "../missing"),
        ]);
        let access = Access::default();
        access.open(&project).unwrap();
        assert!(access.grant(&fixture.0).is_err());
        assert_eq!(
            external_candidates(&project, Path::new(&project.root)),
            vec![fixture.0.join("billing/api")]
        );
    }

    #[test]
    fn opening_another_project_clears_previous_grants() {
        let fixture = Fixture::new();
        let access = Access::default();
        access.open(&fixture.project()).unwrap();
        access.grant(&fixture.0.join("billing")).unwrap();
        let mut project = fixture.project();
        project.root = fixture.0.join("secret").display().to_string();
        access.open(&project).unwrap();
        assert_eq!(access.roots(), vec![fixture.0.join("secret")]);
        assert!(access.snapshot().readable("../billing/api").is_none());
    }

    #[test]
    fn loaded_and_untrusted_maps_reject_the_reserved_planner_id() {
        let fixture = Fixture::new();
        let mut project = fixture.project();
        project.components[0].id = PLAN_SCOPE.into();
        fs::write(
            Path::new(&project.root).join(PROJECT_FILE),
            serde_json::to_string(&project).unwrap(),
        )
        .unwrap();
        let error = Project::load(Path::new(&project.root)).unwrap_err();
        assert!(error.to_string().contains("reserved"));
        assert!(project.save().is_err());
        let access = Access::default();
        assert!(access.open(&project).is_err());
        access.open(&fixture.project()).unwrap();
        assert!(access.snapshot().restrict(project, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_expand_a_grant_or_redirect_file_roots() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let access = Access::default();
        symlink(
            fixture.0.join("secret"),
            fixture.0.join("billing/api/escape"),
        )
        .unwrap();
        symlink(fixture.0.join("billing/api"), fixture.0.join("shop/alias")).unwrap();
        let mut project = fixture.project();
        project.components.push(component("alias", "alias"));
        access.open(&project).unwrap();
        assert!(access.snapshot().readable("alias").is_none());
        access.grant(&fixture.0.join("billing/api")).unwrap();
        assert!(access.snapshot().readable("alias").is_some());
        assert!(
            access
                .snapshot()
                .readable("../billing/api/escape")
                .is_none()
        );
        assert_eq!(access.roots().len(), 2);
        fs::rename(
            fixture.0.join("billing/api"),
            fixture.0.join("billing/original"),
        )
        .unwrap();
        symlink(fixture.0.join("secret"), fixture.0.join("billing/api")).unwrap();
        assert!(files::list_dir(&access.roots(), Path::new("../billing/api")).is_err());
        access.sync(project.components.iter().map(|c| c.path.clone()).collect());
        assert!(access.snapshot().readable("alias").is_none());
        assert_eq!(access.roots().len(), 1);
    }
}
