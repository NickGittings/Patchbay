//! Debounced filesystem signals for Git refreshes, independent of any UI.

use crate::git;
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

/// Canonical, approved roots plus enclosing repositories' metadata directories.
/// Nested entries remain independent roots so parent ignore rules cannot prune
/// mapped components. Missing roots and roots replaced by symlinks are skipped
/// rather than following them into a newly unapproved location.
#[must_use]
pub fn watch_dirs(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<_> = roots.iter().filter(|d| unchanged_dir(d)).cloned().collect();
    for root in dirs.clone() {
        if let Some(repo) = git::repo_root(&root)
            && !dirs.contains(&repo)
            && unchanged_dir(&repo.join(".git"))
        {
            dirs.push(repo.join(".git"));
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn unchanged_dir(path: &Path) -> bool {
    path.is_dir() && path.canonicalize().is_ok_and(|resolved| resolved == path)
}

/// Filter metadata churn; worktree exclusions are evaluated using Git below.
#[must_use]
pub fn relevant(path: &Path) -> bool {
    let parts: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    if let Some(git) = parts.iter().position(|name| *name == ".git") {
        let rest = &parts[git + 1..];
        if rest
            .iter()
            .any(|name| name.to_string_lossy().ends_with(".lock"))
        {
            return false;
        }
        return rest.is_empty()
            || rest[0] == "info"
            || rest[0] == "refs"
            || (rest.len() == 1
                && ["index", "HEAD", "packed-refs", "config"]
                    .iter()
                    .any(|name| rest[0] == *name));
    }
    true
}

/// Core-owned watcher lifecycle. Setup and retries run on a detached worker;
/// shutdown only signals cancellation and never waits for filesystem traversal.
#[derive(Default)]
pub struct GitWatcher {
    worker: Mutex<Option<mpsc::Sender<()>>>,
    stopped: Arc<AtomicBool>,
}

impl GitWatcher {
    /// Synchronize against the latest access snapshot, including concurrent updates.
    pub fn update(
        &self,
        roots: impl Fn() -> Vec<PathBuf> + Send + 'static,
        on_change: impl Fn() + Send + 'static,
    ) {
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = worker.as_ref() {
            let _ = tx.send(());
            return;
        }
        let (tx, rx) = mpsc::channel();
        *worker = Some(tx);
        let stopped = self.stopped.clone();
        std::thread::spawn(move || run(roots, on_change, rx, stopped));
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(tx) = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = tx.send(());
        }
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

// check-ignore honors repository/global rules and, by default, keeps tracked
// files even when they match an ignore pattern. Failure means keep the path.
fn ignored(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Some(repo) = git::repo_root(parent) else {
        return false;
    };
    let excluded = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["check-ignore", "-q", "--"])
        .arg(path)
        .output()
        .is_ok_and(|o| o.status.code() == Some(0));
    if !excluded {
        return false;
    }
    // Ignored directories may still contain force-added tracked files. Preserve
    // their watches, including after deletion when the directory no longer exists.
    Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["ls-files", "--cached", "-z", "--"])
        .arg(path)
        .output()
        .is_ok_and(|o| o.status.success() && o.stdout.is_empty())
}

fn relevant_to(roots: &[PathBuf], path: &Path) -> bool {
    roots.iter().any(|root| {
        path.strip_prefix(root).is_ok_and(|rel| {
            let rel = if root.file_name().is_some_and(|n| n == ".git") {
                Path::new(".git").join(rel)
            } else {
                rel.to_path_buf()
            };
            rel.as_os_str().is_empty()
                || (relevant(&rel)
                    && (rel.components().any(|c| c.as_os_str() == ".git")
                        || affects_exclusions(path)
                        || !ignored(path)))
        })
    })
}

// Register one directory at a time: ignored trees and objects never consume
// inotify watches. One inaccessible directory must not discard other watches.
fn register(
    watcher: &mut impl Watcher,
    roots: &[PathBuf],
    registered: &mut HashSet<PathBuf>,
    stopped: &AtomicBool,
) -> bool {
    let mut complete = true;
    let mut pending = roots.to_vec();
    let mut wanted = HashSet::new();
    while let Some(dir) = pending.pop() {
        if stopped.load(Ordering::Relaxed) {
            return false;
        }
        if !unchanged_dir(&dir) {
            complete = false;
            continue;
        }
        if !wanted.insert(dir.clone()) {
            continue;
        }
        if !registered.contains(&dir) {
            match watcher.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    registered.insert(dir.clone());
                }
                Err(e) => {
                    eprintln!("Git watch {}: {e}", dir.display());
                    complete = false;
                }
            }
        }
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else {
                        complete = false;
                        continue;
                    };
                    if entry.file_type().is_ok_and(|t| t.is_dir())
                        && relevant_to(roots, &entry.path())
                    {
                        pending.push(entry.path());
                    }
                }
            }
            Err(_) => complete = false,
        }
    }
    registered.retain(|dir| {
        if wanted.contains(dir) {
            true
        } else {
            let _ = watcher.unwatch(dir);
            false
        }
    });
    complete
}

// Git's index can change which ignored paths are tracked, so staging also
// requires reevaluating exclusions. Ordinary worktree content edits do not.
fn affects_exclusions(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == ".gitignore")
        || path.ends_with(".git/info/exclude")
        || path.ends_with(".git/config")
        || path.ends_with(".git/index")
}

#[derive(Default)]
struct PendingChanges {
    paths: HashSet<PathBuf>,
    structural: HashSet<PathBuf>,
    rescan: bool,
    since: Option<Instant>,
}

impl PendingChanges {
    fn push(&mut self, event: Event) {
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        self.since.get_or_insert_with(Instant::now);
        self.rescan |= event.need_rescan();
        let structural = !matches!(
            event.kind,
            EventKind::Create(CreateKind::File)
                | EventKind::Remove(RemoveKind::File)
                | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
        );
        for path in event.paths {
            if structural || affects_exclusions(&path) {
                self.structural.insert(path.clone());
            }
            self.paths.insert(path);
        }
    }

    fn assess(&self, roots: &[PathBuf], registered: &HashSet<PathBuf>) -> (bool, bool) {
        let mut dirty = self.rescan;
        let mut rescan = self.rescan;
        for path in &self.paths {
            if relevant_to(roots, path) {
                dirty = true;
                rescan |= self.structural.contains(path)
                    && (affects_exclusions(path) || path.is_dir() || registered.contains(path));
            }
        }
        (dirty, rescan)
    }
}

fn run(
    roots: impl Fn() -> Vec<PathBuf>,
    on_change: impl Fn(),
    updates: mpsc::Receiver<()>,
    stopped: Arc<AtomicBool>,
) {
    run_with_watcher(roots, on_change, updates, stopped, |tx| {
        RecommendedWatcher::new(
            move |event| {
                let _ = tx.send(event);
            },
            notify::Config::default().with_follow_symlinks(false),
        )
    });
}

fn run_with_watcher<W: Watcher>(
    roots: impl Fn() -> Vec<PathBuf>,
    on_change: impl Fn(),
    updates: mpsc::Receiver<()>,
    stopped: Arc<AtomicBool>,
    mut create_watcher: impl FnMut(mpsc::Sender<notify::Result<Event>>) -> notify::Result<W>,
) {
    let (tx, events) = mpsc::channel();
    let mut watcher = None;
    let mut registered = HashSet::new();
    let mut requested_before = Vec::new();
    let mut current = Vec::new();
    let mut complete = false;
    let mut pending = PendingChanges::default();
    let mut last_fallback = Instant::now();
    let mut last_retry = Instant::now() - Duration::from_secs(30);
    while !stopped.load(Ordering::Relaxed) {
        let requested = roots();
        let requested_changed = requested != requested_before;
        requested_before = requested.clone();
        let dirs = watch_dirs(&requested);
        let missing = requested.iter().any(|root| !unchanged_dir(root));
        let changed = dirs != current;
        let coverage_changed = changed && !requested_changed;
        current = dirs;
        let was_complete = complete;
        let mut dirty = coverage_changed;
        let mut rescan = false;
        while let Ok(event) = events.try_recv() {
            match event {
                Ok(event) => pending.push(event),
                Err(error) => {
                    eprintln!("Git watcher: {error}");
                    watcher = None;
                    registered.clear();
                    complete = false;
                    dirty = true;
                    rescan = true;
                }
            }
        }
        // Flush at a bounded interval even during continuous writes. Preserve
        // event kinds until this point so file edits reuse the existing watches.
        if pending
            .since
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(1))
        {
            let batch = std::mem::take(&mut pending);
            let (batch_dirty, batch_rescan) = batch.assess(&current, &registered);
            dirty |= batch_dirty;
            rescan |= batch_rescan;
        }
        // Publish invalidation before potentially expensive structural scans.
        if dirty && !requested.is_empty() {
            on_change();
            last_fallback = Instant::now();
        }
        if changed || rescan || (!complete && last_retry.elapsed() >= Duration::from_secs(30)) {
            if watcher.is_none() {
                watcher = create_watcher(tx.clone()).ok();
            }
            complete = watcher
                .as_mut()
                .is_some_and(|w| register(w, &current, &mut registered, &stopped))
                && !missing;
            last_retry = Instant::now();
        }
        let recovered = !was_complete && complete && !requested_changed;
        if !requested.is_empty()
            && !dirty
            && (recovered || (!complete && last_fallback.elapsed() >= Duration::from_secs(5)))
        {
            on_change();
            last_fallback = Instant::now();
        }
        // The frontend refreshes after map synchronization, when new components
        // exist. Requested root updates only change coverage. Availability
        // changes and successful retries independently invalidate stale badges.
        let _ = updates.recv_timeout(Duration::from_millis(100));
        while updates.try_recv().is_ok() {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, Flag, MetadataKind, RenameMode};
    use std::fs;
    use std::sync::atomic::AtomicU64;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "patchbay-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            let f = Self(path.canonicalize().unwrap());
            f.git(&["init", "-q"]);
            f
        }
        fn git(&self, args: &[&str]) {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&self.0)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        fn write(&self, path: &str, contents: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // Registration succeeds without emitting initial events. This models
    // backends where restored coverage cannot itself invalidate Git status.
    struct SilentWatcher;

    impl Watcher for SilentWatcher {
        fn new<F: notify::EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
            Ok(Self)
        }

        fn watch(&mut self, _: &Path, _: RecursiveMode) -> notify::Result<()> {
            Ok(())
        }

        fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
            Ok(())
        }

        fn kind() -> notify::WatcherKind {
            notify::WatcherKind::NullWatcher
        }
    }

    #[test]
    fn ignored_nested_repositories_keep_independent_worktree_and_metadata_watches() {
        let f = Fixture::new();
        f.write(".gitignore", "ignored/\n");
        f.write("ignored/child/src/file", "tracked");
        let child = Fixture(f.0.join("ignored/child"));
        child.git(&["init", "-q"]);
        child.git(&["add", "src/file"]);
        child.git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "Initial",
        ]);
        child.write(".gitignore", "target/\n");
        child.write("target/artifact", "");
        let mut registered = HashSet::new();
        // Cover both maps that include the nested repo itself and maps that
        // contain only a component below its root.
        for component in [child.0.clone(), child.0.join("src")] {
            let dirs = watch_dirs(&[f.0.clone(), component.clone()]);
            assert!(dirs.contains(&component));
            assert!(register(
                &mut SilentWatcher,
                &dirs,
                &mut registered,
                &AtomicBool::new(false)
            ));
            assert!(registered.contains(&child.0.join("src")));
            assert!(registered.contains(&child.0.join(".git")));
            assert!(registered.contains(&child.0.join(".git/refs/heads")));
            assert!(!registered.contains(&child.0.join("target")));
            assert!(!registered.contains(&f.0.join("ignored")));
            for path in ["src/file", ".git/index", ".git/refs/heads/main"] {
                assert!(relevant_to(&dirs, &child.0.join(path)), "{path}");
            }
        }
    }

    #[test]
    fn content_changes_reuse_coverage_including_atomic_saves() {
        let f = Fixture::new();
        f.write("src/file", "");
        let roots = vec![f.0.clone()];
        let registered = HashSet::from([f.0.join("src")]);
        for kind in [
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            EventKind::Any,
        ] {
            let mut pending = PendingChanges::default();
            pending.push(Event::new(kind).add_path(f.0.join("src/file")));
            assert_eq!(
                pending.assess(&roots, &registered),
                (true, false),
                "{kind:?}"
            );
        }
        let mut pending = PendingChanges::default();
        pending
            .push(Event::new(EventKind::Access(AccessKind::Read)).add_path(f.0.join("src/file")));
        assert!(pending.since.is_none());
        assert_eq!(pending.assess(&roots, &registered), (false, false));
    }

    #[test]
    fn directory_and_exclusion_changes_rebuild_coverage() {
        let f = Fixture::new();
        f.write("new/subdir/file", "");
        f.write(".gitignore", "target/\n");
        f.write("target/artifact", "");
        let roots = vec![f.0.clone()];
        let deleted = f.0.join("deleted");
        let registered = HashSet::from([deleted.clone()]);
        for event in [
            Event::new(EventKind::Create(CreateKind::Folder)).add_path(f.0.join("new")),
            Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(deleted),
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                .add_path(f.0.join("new/subdir")),
            Event::new(EventKind::Any).add_path(f.0.join("new")),
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(f.0.join(".gitignore")),
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(f.0.join(".git/info/exclude")),
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(f.0.join(".git/config")),
            Event::new(EventKind::Create(CreateKind::File)).add_path(f.0.join(".git/index")),
            Event::new(EventKind::Other).set_flag(Flag::Rescan),
        ] {
            let mut pending = PendingChanges::default();
            pending.push(event);
            assert_eq!(pending.assess(&roots, &registered), (true, true));
        }
        let mut pending = PendingChanges::default();
        pending
            .push(Event::new(EventKind::Create(CreateKind::Folder)).add_path(f.0.join("target")));
        assert_eq!(pending.assess(&roots, &registered), (false, false));
    }

    #[test]
    fn restored_roots_refresh_without_registration_events() {
        let f = Fixture::new();
        let root = f.0.join("missing");
        let requested = root.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let (tx, rx) = mpsc::channel();
        let (update_tx, update_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run_with_watcher(
                move || vec![requested.clone()],
                move || {
                    let _ = tx.send(());
                },
                update_rx,
                worker_stopped,
                |_| Ok(SilentWatcher),
            );
        });
        // Let a fallback invalidate badges while the root is unavailable, then
        // require another invalidation sooner than the next fallback interval.
        rx.recv_timeout(Duration::from_secs(7)).unwrap();
        fs::create_dir(&root).unwrap();
        let refreshed = rx.recv_timeout(Duration::from_secs(2));
        stopped.store(true, Ordering::Relaxed);
        update_tx.send(()).unwrap();
        worker.join().unwrap();
        refreshed.unwrap();
    }

    #[test]
    fn metadata_filter_keeps_config_exclusions_and_ref_deletions() {
        for p in [
            ".git",
            ".git/index",
            ".git/HEAD",
            ".git/packed-refs",
            ".git/config",
            ".git/info",
            ".git/info/exclude",
            ".git/refs/heads/build",
            "tools/build",
            "target",
            "vendor/file",
        ] {
            assert!(relevant(Path::new(p)), "{p}");
        }
        for p in [
            ".git/objects",
            ".git/objects/ab/cd",
            ".git/logs/HEAD",
            ".git/index.lock",
            ".git/refs/heads/main.lock",
        ] {
            assert!(!relevant(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn git_rules_filter_artifacts_but_preserve_tracked_paths_and_directories() {
        let f = Fixture::new();
        f.write(
            ".gitignore",
            "target/\n.next/\n.venv/\n*.log\n.DS_Store\n*.sqlite\n",
        );
        f.write("target/tracked", "tracked");
        f.git(&["add", "-f", "target/tracked"]);
        for p in [
            "target/tracked",
            "target",
            "vendor/code",
            "build",
            "tools/build",
        ] {
            assert!(!ignored(&f.0.join(p)), "{p}");
        }
        for p in [
            "target/artifact",
            ".next/cache",
            ".venv/lib",
            "app.log",
            ".DS_Store",
            "db.sqlite",
        ] {
            // Parent directories must exist for Git to locate the repository.
            fs::create_dir_all(f.0.join(p).parent().unwrap()).unwrap();
            assert!(ignored(&f.0.join(p)), "{p}");
        }
        fs::remove_file(f.0.join("target/tracked")).unwrap();
        assert!(!ignored(&f.0.join("target/tracked")));
        f.write(".git/info/exclude", "local/\n");
        fs::create_dir_all(f.0.join("local")).unwrap();
        assert!(ignored(&f.0.join("local/file")));
        f.write(".git/info/exclude", "");
        assert!(!ignored(&f.0.join("local/file")));
    }

    #[test]
    fn registration_prunes_ignored_trees_and_keeps_healthy_roots_on_failure() {
        let f = Fixture::new();
        f.write(".gitignore", "target/\nnode_modules/\n");
        f.write("target/deep/artifact", "");
        f.write("node_modules/pkg/index.js", "");
        f.write("vendor/tracked", "");
        let mut watcher =
            RecommendedWatcher::new(|_: notify::Result<Event>| {}, notify::Config::default())
                .unwrap();
        let mut registered = HashSet::new();
        let stopped = AtomicBool::new(false);
        assert!(!register(
            &mut watcher,
            &[f.0.clone(), f.0.join("missing")],
            &mut registered,
            &stopped
        ));
        assert!(registered.contains(&f.0));
        assert!(registered.contains(&f.0.join("vendor")));
        assert!(!registered.contains(&f.0.join("target")));
        assert!(!registered.contains(&f.0.join("node_modules")));
        assert!(!registered.contains(&f.0.join(".git/objects")));
        f.write("target/deep/keep", "");
        f.git(&["add", "-f", "target/deep/keep"]);
        assert!(register(
            &mut watcher,
            std::slice::from_ref(&f.0),
            &mut registered,
            &stopped
        ));
        assert!(registered.contains(&f.0.join("target/deep")));
    }

    #[test]
    fn lifecycle_watches_new_directories_and_shutdown_does_not_wait_for_setup() {
        let f = Fixture::new();
        let watcher = GitWatcher::default();
        let root = f.0.clone();
        let (tx, rx) = mpsc::channel();
        watcher.update(
            move || vec![root.clone()],
            move || {
                let _ = tx.send(());
            },
        );
        // Positive assertions tolerate startup/rescan events on FSEvents. The
        // deterministic tests above verify filtering without timing assumptions.
        std::thread::sleep(Duration::from_secs(2));
        while rx.try_recv().is_ok() {}
        f.write("build/new/file", "new");
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        std::thread::sleep(Duration::from_secs(2));
        while rx.try_recv().is_ok() {}
        f.write("build/new/file", "edited");
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let start = Instant::now();
        watcher.stop();
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn unavailable_roots_get_periodic_refreshes() {
        let f = Fixture::new();
        let root = f.0.join("missing");
        let watcher = GitWatcher::default();
        let (tx, rx) = mpsc::channel();
        watcher.update(
            move || vec![root.clone()],
            move || {
                let _ = tx.send(());
            },
        );
        rx.recv_timeout(Duration::from_secs(7)).unwrap();
        watcher.stop();
    }

    #[test]
    fn stop_does_not_wait_for_a_blocked_worker() {
        let watcher = GitWatcher::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        watcher.update(
            move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv();
                Vec::new()
            },
            || {},
        );
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        watcher.stop();
        assert!(start.elapsed() < Duration::from_millis(100));
        release_tx.send(()).unwrap();
    }

    #[test]
    fn includes_enclosing_metadata_for_component_roots() {
        let f = Fixture::new();
        f.write("tools/build/file", "");
        let component = f.0.join("tools/build");
        let dirs = watch_dirs(&[component.clone(), component.clone()]);
        assert_eq!(dirs.len(), 2);
        assert!(dirs.contains(&component));
        assert!(dirs.contains(&f.0.join(".git")));
        assert!(relevant_to(&dirs, &f.0.join(".git/info/exclude")));
        assert!(relevant_to(&dirs, &f.0.join(".git/config")));
        assert_eq!(
            watch_dirs(&[component.clone(), f.0.clone()]),
            vec![f.0.clone(), component]
        );
    }

    #[test]
    fn failed_registration_can_be_retried_with_the_same_roots() {
        let f = Fixture::new();
        let root = f.0.join("later");
        // A disappearing child keeps the remaining registration active and
        // reports incomplete coverage so the lifecycle enables fallback/retry.
        let mut watcher =
            RecommendedWatcher::new(|_: notify::Result<Event>| {}, notify::Config::default())
                .unwrap();
        let mut registered = HashSet::new();
        let stopped = AtomicBool::new(false);
        assert!(!register(
            &mut watcher,
            std::slice::from_ref(&root),
            &mut registered,
            &stopped
        ));
        fs::create_dir(&root).unwrap();
        assert!(register(
            &mut watcher,
            std::slice::from_ref(&root),
            &mut registered,
            &stopped
        ));
        assert!(registered.contains(&root));
    }
}
