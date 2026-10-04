//! Debounced filesystem signals for Git refreshes, independent of any UI.

use crate::git;
use notify::event::{CreateKind, ModifyKind, RemoveKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, WatcherKind};
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

/// Events are batched for this long, even during continuous writes.
const DEBOUNCE: Duration = Duration::from_secs(1);
/// Roots, repositories and global excludes are rechecked this often without events.
const REVALIDATE: Duration = Duration::from_secs(5);
/// A missing root is checked this often so its return refreshes promptly.
const MISSING_POLL: Duration = Duration::from_secs(1);
/// Status refresh interval while a failed watch leaves a gap in coverage.
const FALLBACK: Duration = Duration::from_secs(5);
/// Failed watches are retried after this long, doubling up to `RETRY_MAX`.
const RETRY_MIN: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(300);
/// Bounds on the per-path caches, which are only hints and safe to drop.
const CACHE_LIMIT: usize = 50_000;

/// Canonical, approved roots inside a Git repository, plus enclosing
/// repositories' metadata directories. Git status reports nothing outside a
/// repository, so other roots aren't watched. Nested entries remain independent
/// roots so parent ignore rules cannot prune mapped components. Missing roots
/// and roots replaced by symlinks are skipped rather than following them into a
/// newly unapproved location.
#[must_use]
pub fn watch_dirs(roots: &[PathBuf]) -> Vec<PathBuf> {
    let found: Vec<_> = roots
        .iter()
        .filter(|d| unchanged_dir(d))
        .filter_map(|d| Some((d.clone(), git::repo_root(d)?)))
        .collect();
    let mut dirs: Vec<_> = found.iter().map(|(dir, _)| dir.clone()).collect();
    for (_, repo) in found {
        if !dirs.contains(&repo) && unchanged_dir(&repo.join(".git")) {
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
    worker: Mutex<Option<Worker>>,
    stopped: Arc<AtomicBool>,
}

struct Worker {
    updates: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

impl GitWatcher {
    /// Synchronize against the latest access snapshot, including concurrent
    /// updates. A worker that died (it panicked) is replaced, not silently fed.
    pub fn update(
        &self,
        roots: impl Fn() -> Vec<PathBuf> + Send + 'static,
        on_change: impl Fn() + Send + 'static,
    ) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        let mut worker = self.worker.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = worker.as_ref()
            && !w.thread.is_finished()
            && w.updates.send(()).is_ok()
        {
            return;
        }
        let (updates, rx) = mpsc::channel();
        let stopped = self.stopped.clone();
        let thread = std::thread::spawn(move || run(roots, on_change, rx, stopped));
        *worker = Some(Worker { updates, thread });
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(w) = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = w.updates.send(());
        }
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// One recursive watch per outermost root, for backends that watch trees
    /// natively and restart their stream for every added path (`FSEvents`).
    Recursive,
    /// One watch per relevant directory, so ignored trees never consume
    /// inotify (or kqueue) watches.
    PerDirectory,
}

impl Mode {
    fn for_kind(kind: WatcherKind) -> Self {
        match kind {
            WatcherKind::Fsevent | WatcherKind::ReadDirectoryChangesWatcher => Self::Recursive,
            _ => Self::PerDirectory,
        }
    }
}

/// Git's exclusion rules for one repository. A path counts as ignored only
/// when status would hide it: tracked files never are, and neither are
/// directories holding tracked files.
struct Rules {
    /// Ignored paths with no tracked content; everything below them is ignored.
    ignored: HashSet<PathBuf>,
    /// Paths Git reported as not ignored.
    kept: HashSet<PathBuf>,
    /// Tracked files matching an ignore pattern. Staging changes this set,
    /// which alters which ignored directories must stay watched.
    tracked: Vec<PathBuf>,
    /// The global excludes file and its modification time when loaded.
    excludes: Option<(PathBuf, Option<SystemTime>)>,
}

impl Rules {
    /// Two processes list every ignored file and collapsed ignored directory,
    /// so walking a tree never needs to ask Git again.
    fn load(repo: &Path) -> Self {
        let mut rules = Self {
            ignored: HashSet::new(),
            kept: HashSet::new(),
            tracked: ls_ignored(repo, "-c").unwrap_or_default(),
            excludes: excludes_file(repo).map(|path| {
                let modified = modified(&path);
                (path, modified)
            }),
        };
        for path in ls_ignored(repo, "-o").unwrap_or_default() {
            rules.classify(path, true);
        }
        rules
    }

    fn classify(&mut self, path: PathBuf, ignored: bool) {
        if ignored && !self.tracked.iter().any(|t| t.starts_with(&path)) {
            self.ignored.insert(path);
        } else {
            self.kept.insert(path);
        }
    }

    /// `None` when neither the path nor any parent within `repo` is known.
    fn lookup(&self, repo: &Path, path: &Path) -> Option<bool> {
        if path
            .ancestors()
            .take_while(|a| *a != repo && a.starts_with(repo))
            .any(|a| self.ignored.contains(a))
        {
            return Some(true);
        }
        self.kept.contains(path).then_some(false)
    }
}

/// Exclusion rules cached per repository; cleared whenever the rules change.
#[derive(Default)]
struct Ignores {
    repos: HashMap<PathBuf, Rules>,
    /// Nearest repository for each directory seen in an event.
    repo_of: HashMap<PathBuf, Option<PathBuf>>,
}

impl Ignores {
    fn clear(&mut self) {
        self.repos.clear();
        self.repo_of.clear();
    }

    fn rules(&mut self, repo: &Path) -> &mut Rules {
        self.repos
            .entry(repo.to_path_buf())
            .or_insert_with(|| Rules::load(repo))
    }

    fn repo_of(&mut self, path: &Path) -> Option<PathBuf> {
        let dir = path.parent()?;
        if self.repo_of.len() >= CACHE_LIMIT {
            self.repo_of.clear();
        }
        self.repo_of
            .entry(dir.to_path_buf())
            .or_insert_with(|| git::repo_root(dir))
            .clone()
    }

    /// Whether a directory found while walking `repo` is ignored. The repo's
    /// listing covers every existing directory, so this starts no process.
    fn prunes(&mut self, repo: &Path, dir: &Path) -> bool {
        self.rules(repo).lookup(repo, dir) == Some(true)
    }

    /// Ask Git once per repository about the paths the cache doesn't cover.
    /// Their parents are asked too, so a newly created ignored directory is
    /// learned once rather than once per file written inside it.
    fn prepare<'a>(&mut self, paths: impl IntoIterator<Item = &'a Path>) {
        let mut unknown: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();
        for path in paths {
            let Some(repo) = self.repo_of(path) else {
                continue;
            };
            let rules = self.rules(&repo);
            if rules.lookup(&repo, path).is_some() {
                continue;
            }
            let ask = unknown.entry(repo.clone()).or_default();
            for a in path
                .ancestors()
                .take_while(|a| *a != repo && a.starts_with(&repo))
            {
                if !rules.kept.contains(a) {
                    ask.insert(a.to_path_buf());
                }
            }
        }
        for (repo, ask) in unknown {
            let ask: Vec<_> = ask.into_iter().collect();
            let ignored = check_ignore(&repo, &ask);
            let rules = self.rules(&repo);
            if rules.kept.len() >= CACHE_LIMIT {
                rules.kept.clear();
            }
            for path in ask {
                let is_ignored = ignored.contains(&path);
                rules.classify(path, is_ignored);
            }
        }
    }

    fn ignored(&mut self, path: &Path) -> bool {
        self.prepare([path]);
        self.repo_of(path)
            .is_some_and(|repo| self.rules(&repo).lookup(&repo, path) == Some(true))
    }

    /// After the index changed: whether its ignored-but-tracked files did too.
    /// If so the repo's rules are dropped so the next walk reloads them.
    fn tracked_changed(&mut self, repo: &Path) -> bool {
        let Some(rules) = self.repos.get(repo) else {
            return false;
        };
        if ls_ignored(repo, "-c").unwrap_or_default() == rules.tracked {
            return false;
        }
        self.repos.remove(repo);
        true
    }

    /// Whether a loaded repository's global excludes file was edited.
    fn excludes_changed(&self) -> bool {
        self.repos.values().any(|rules| {
            rules
                .excludes
                .as_ref()
                .is_some_and(|(path, when)| modified(path) != *when)
        })
    }
}

/// Ignored paths in `repo`: `-o` lists untracked files and collapsed
/// directories (only those without tracked content), `-c` tracked files.
fn ls_ignored(repo: &Path, which: &str) -> Option<Vec<PathBuf>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-z", "-i", "--exclude-standard", "--directory"])
        .arg(which)
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    Some(
        nul_separated(&out.stdout)
            .map(|p| repo.join(p.trim_end_matches('/')))
            .collect(),
    )
}

/// The subset of `paths` (all inside `repo`) that Git ignores, in one process.
/// Tracked files and directories holding them are never reported. Failure
/// reports nothing, which keeps every path.
fn check_ignore(repo: &Path, paths: &[PathBuf]) -> HashSet<PathBuf> {
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashSet::new();
    };
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.to_string_lossy().as_bytes());
        input.push(0);
    }
    // Write from another thread so a large reply can't fill the pipe first.
    let writer = child.stdin.take().map(|mut stdin| {
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let output = child.wait_with_output();
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    // Exit 1 means nothing matched; anything but 0 or 1 is a failure.
    output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| nul_separated(&o.stdout).map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn nul_separated(bytes: &[u8]) -> impl Iterator<Item = String> + '_ {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
}

/// `core.excludesFile`, or Git's default `$XDG_CONFIG_HOME/git/ignore`.
fn excludes_file(repo: &Path) -> Option<PathBuf> {
    let configured = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["config", "--path", "--get", "core.excludesFile"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_owned())
        .filter(|path| !path.is_empty());
    if let Some(path) = configured {
        return Some(repo.join(path));
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?;
    Some(config.join("git").join("ignore"))
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

enum Scope {
    Outside,
    /// The root itself, Git metadata and exclusion rules: always relevant.
    Always,
    /// Worktree content: relevant unless Git ignores it.
    Worktree,
}

fn scope(roots: &[PathBuf], path: &Path) -> Scope {
    let mut found = Scope::Outside;
    for root in roots {
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = if root.file_name().is_some_and(|n| n == ".git") {
            Path::new(".git").join(rel)
        } else {
            rel.to_path_buf()
        };
        if rel.as_os_str().is_empty() {
            return Scope::Always;
        }
        if relevant(&rel) {
            if rel.components().any(|c| c.as_os_str() == ".git") || affects_exclusions(path) {
                return Scope::Always;
            }
            found = Scope::Worktree;
        }
    }
    found
}

fn relevant_to(roots: &[PathBuf], path: &Path, ignores: &mut Ignores) -> bool {
    match scope(roots, path) {
        Scope::Outside => false,
        Scope::Always => true,
        Scope::Worktree => !ignores.ignored(path),
    }
}

/// Watch `roots`; returns false when a watch failed and coverage has a gap.
/// Unreadable or vanished directories don't count: Git can't report them
/// either, and a parent's watch reports a directory that comes back.
fn register(
    watcher: &mut impl Watcher,
    mode: Mode,
    roots: &[PathBuf],
    registered: &mut HashSet<PathBuf>,
    ignores: &mut Ignores,
    stopped: &AtomicBool,
) -> bool {
    let mut complete = true;
    let wanted = match mode {
        Mode::Recursive => {
            let wanted: HashSet<_> = roots
                .iter()
                .filter(|root| !roots.iter().any(|o| o != *root && root.starts_with(o)))
                .filter(|root| unchanged_dir(root))
                .cloned()
                .collect();
            for dir in &wanted {
                if !registered.contains(dir) {
                    complete &= add_watch(watcher, dir, RecursiveMode::Recursive, registered);
                }
            }
            wanted
        }
        Mode::PerDirectory => {
            let Some(wanted) = walk(watcher, roots, registered, ignores, stopped, &mut complete)
            else {
                return false;
            };
            wanted
        }
    };
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

fn add_watch(
    watcher: &mut impl Watcher,
    dir: &Path,
    mode: RecursiveMode,
    registered: &mut HashSet<PathBuf>,
) -> bool {
    match watcher.watch(dir, mode) {
        Ok(()) => {
            registered.insert(dir.to_path_buf());
            true
        }
        Err(e) => {
            let skipped = match &e.kind {
                notify::ErrorKind::PathNotFound => true,
                notify::ErrorKind::Io(io) => {
                    matches!(io.kind(), ErrorKind::NotFound | ErrorKind::PermissionDenied)
                }
                _ => false,
            };
            eprintln!("Git watch {}: {e}", dir.display());
            skipped
        }
    }
}

// Register one directory at a time: ignored trees and objects never consume
// inotify watches. One inaccessible directory must not discard other watches.
// Returns `None` if stopped.
fn walk(
    watcher: &mut impl Watcher,
    roots: &[PathBuf],
    registered: &mut HashSet<PathBuf>,
    ignores: &mut Ignores,
    stopped: &AtomicBool,
    complete: &mut bool,
) -> Option<HashSet<PathBuf>> {
    // Each directory carries its repository (`None` inside metadata), found
    // structurally: a child holding `.git` starts a nested repository.
    let mut pending: Vec<(PathBuf, Option<PathBuf>)> = roots
        .iter()
        .map(|root| {
            let meta = root.file_name().is_some_and(|n| n == ".git");
            (root.clone(), if meta { None } else { git::repo_root(root) })
        })
        .collect();
    let mut wanted = HashSet::new();
    while let Some((dir, repo)) = pending.pop() {
        if stopped.load(Ordering::Relaxed) {
            return None;
        }
        if !unchanged_dir(&dir) || !wanted.insert(dir.clone()) {
            continue;
        }
        if !registered.contains(&dir) {
            *complete &= add_watch(watcher, &dir, RecursiveMode::NonRecursive, registered);
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) => {
                if !matches!(e.kind(), ErrorKind::NotFound | ErrorKind::PermissionDenied) {
                    eprintln!("Git watch {}: {e}", dir.display());
                    *complete = false;
                }
                continue;
            }
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if !entry.file_type().is_ok_and(|t| t.is_dir()) || !relevant(&child) {
                continue;
            }
            if entry.file_name() == ".git" {
                pending.push((child, None));
                continue;
            }
            let Some(repo) = &repo else {
                // Inside metadata: `relevant` already filtered it.
                pending.push((child, None));
                continue;
            };
            if child.join(".git").exists() {
                pending.push((child.clone(), Some(child)));
            } else if !ignores.prunes(repo, &child) {
                pending.push((child, Some(repo.clone())));
            }
        }
    }
    Some(wanted)
}

// Rule files change which paths are ignored. The index is handled separately:
// staging only matters when it changes which ignored paths are tracked.
fn affects_exclusions(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == ".gitignore")
        || path.ends_with(".git/info/exclude")
        || path.ends_with(".git/config")
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
            if structural {
                self.structural.insert(path.clone());
            }
            self.paths.insert(path);
        }
    }

    fn assess(
        &self,
        roots: &[PathBuf],
        registered: &HashSet<PathBuf>,
        ignores: &mut Ignores,
    ) -> (bool, bool) {
        let mut dirty = self.rescan;
        let mut rescan = self.rescan;
        let scoped: Vec<_> = self
            .paths
            .iter()
            .map(|path| (path, scope(roots, path)))
            .filter(|(_, s)| !matches!(s, Scope::Outside))
            .collect();
        // Rule changes first, so the other paths are judged by the new rules.
        for (path, _) in &scoped {
            if affects_exclusions(path) {
                ignores.clear();
                rescan = true;
            } else if path.ends_with(".git/index")
                && let Some(repo) = path.parent().and_then(Path::parent)
                && ignores.tracked_changed(repo)
            {
                rescan = true;
            }
        }
        ignores.prepare(
            scoped
                .iter()
                .filter(|(_, s)| matches!(s, Scope::Worktree))
                .map(|(path, _)| path.as_path()),
        );
        for (path, _) in scoped {
            if relevant_to(roots, path, ignores) {
                dirty = true;
                rescan |=
                    self.structural.contains(path) && (path.is_dir() || registered.contains(path));
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
    let mode = Mode::for_kind(RecommendedWatcher::kind());
    run_with_watcher(roots, on_change, updates, stopped, mode, |tx| {
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
    mode: Mode,
    mut create_watcher: impl FnMut(mpsc::Sender<notify::Result<Event>>) -> notify::Result<W>,
) {
    let (tx, events) = mpsc::channel();
    let mut watcher = None;
    let mut registered = HashSet::new();
    let mut ignores = Ignores::default();
    let mut pending = PendingChanges::default();
    let mut requested = Vec::new();
    let mut current = Vec::new();
    let mut missing = false;
    // A watch failed, so changes may go unseen until a retry succeeds.
    let mut failed = false;
    let mut retry_after = RETRY_MIN;
    let mut last_retry = Instant::now();
    let mut last_refresh = Instant::now();
    // `None` asks for a check of roots and coverage on this pass.
    let mut last_check: Option<Instant> = None;
    while !stopped.load(Ordering::Relaxed) {
        let mut dirty = false;
        let mut rescan = false;
        let mut settle = false;
        while let Ok(event) = events.try_recv() {
            match event {
                Ok(event) => pending.push(event),
                Err(error) => {
                    eprintln!("Git watcher: {error}");
                    watcher = None;
                    registered.clear();
                    dirty = true;
                    rescan = true;
                }
            }
        }
        // Flush at a bounded interval even during continuous writes. Preserve
        // event kinds until this point so file edits reuse the existing watches.
        if pending.since.is_some_and(|t| t.elapsed() >= DEBOUNCE) {
            let batch = std::mem::take(&mut pending);
            let (batch_dirty, batch_rescan) = batch.assess(&current, &registered, &mut ignores);
            dirty |= batch_dirty;
            rescan |= batch_rescan;
            // A root itself may have been deleted or recreated.
            last_check = None;
        }
        let interval = if missing { MISSING_POLL } else { REVALIDATE };
        if last_check.is_none_or(|t| t.elapsed() >= interval) {
            last_check = Some(Instant::now());
            let next = roots();
            let dirs = watch_dirs(&next);
            missing = next.iter().any(|root| !unchanged_dir(root));
            if next != requested {
                // The frontend refreshes after map synchronization, possibly
                // before new coverage is in place: refresh again once it is.
                settle = true;
                requested = next;
            } else if dirs != current {
                // A root or repository appeared or vanished on its own.
                dirty = true;
            }
            if dirs != current {
                current = dirs;
                rescan = true;
            }
            if ignores.excludes_changed() {
                ignores.clear();
                dirty = true;
                rescan = true;
            }
        }
        let watching = !requested.is_empty();
        // Publish invalidation before potentially expensive structural scans.
        if dirty && watching {
            on_change();
            last_refresh = Instant::now();
        }
        let retry = failed && last_retry.elapsed() >= retry_after;
        if rescan || retry {
            if watcher.is_none() {
                watcher = create_watcher(tx.clone())
                    .inspect_err(|e| eprintln!("Git watcher: {e}"))
                    .ok();
            }
            let ok = watcher.as_mut().is_some_and(|w| {
                register(w, mode, &current, &mut registered, &mut ignores, &stopped)
            });
            if stopped.load(Ordering::Relaxed) {
                break;
            }
            // Changes inside a gap that just closed went unseen.
            let recovered = failed && ok;
            if ok {
                retry_after = RETRY_MIN;
            } else if retry {
                retry_after = (retry_after * 2).min(RETRY_MAX);
            }
            failed = !ok;
            last_retry = Instant::now();
            if (recovered || settle) && watching {
                on_change();
                last_refresh = Instant::now();
            }
        }
        if failed && watching && last_refresh.elapsed() >= FALLBACK {
            on_change();
            last_refresh = Instant::now();
        }
        if updates.recv_timeout(Duration::from_millis(100)).is_ok() {
            last_check = None;
        }
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
            let f = Self::plain();
            f.git(&["init", "-q"]);
            f
        }
        fn plain() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "patchbay-watch-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
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

    fn ignored(path: &Path) -> bool {
        Ignores::default().ignored(path)
    }

    fn register_all(
        watcher: &mut impl Watcher,
        roots: &[PathBuf],
        registered: &mut HashSet<PathBuf>,
    ) -> bool {
        let stopped = AtomicBool::new(false);
        register(
            watcher,
            Mode::PerDirectory,
            roots,
            registered,
            &mut Ignores::default(),
            &stopped,
        )
    }

    // Registration succeeds without emitting initial events. This models
    // backends where restored coverage cannot itself invalidate Git status.
    // Watching a path whose name is `full` fails like an exhausted inotify.
    struct SilentWatcher;

    impl Watcher for SilentWatcher {
        fn new<F: notify::EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
            Ok(Self)
        }

        fn watch(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
            if path.file_name().is_some_and(|n| n == "full") {
                return Err(notify::Error::generic("no space left"));
            }
            Ok(())
        }

        fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
            Ok(())
        }

        fn kind() -> notify::WatcherKind {
            notify::WatcherKind::NullWatcher
        }
    }

    fn spawn_worker(roots: Vec<PathBuf>) -> (mpsc::Receiver<()>, impl FnOnce()) {
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let (tx, rx) = mpsc::channel();
        let (update_tx, update_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run_with_watcher(
                move || roots.clone(),
                move || {
                    let _ = tx.send(());
                },
                update_rx,
                worker_stopped,
                Mode::PerDirectory,
                |_| Ok(SilentWatcher),
            );
        });
        let stop = move || {
            stopped.store(true, Ordering::Relaxed);
            update_tx.send(()).unwrap();
            worker.join().unwrap();
        };
        (rx, stop)
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
            assert!(register_all(&mut SilentWatcher, &dirs, &mut registered));
            assert!(registered.contains(&child.0.join("src")));
            assert!(registered.contains(&child.0.join(".git")));
            assert!(registered.contains(&child.0.join(".git/refs/heads")));
            assert!(!registered.contains(&child.0.join("target")));
            assert!(!registered.contains(&f.0.join("ignored")));
            let mut ignores = Ignores::default();
            for path in ["src/file", ".git/index", ".git/refs/heads/main"] {
                assert!(
                    relevant_to(&dirs, &child.0.join(path), &mut ignores),
                    "{path}"
                );
            }
        }
    }

    #[test]
    fn content_changes_reuse_coverage_including_atomic_saves() {
        let f = Fixture::new();
        f.write("src/file", "");
        let roots = vec![f.0.clone()];
        let registered = HashSet::from([f.0.join("src")]);
        let mut ignores = Ignores::default();
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
                pending.assess(&roots, &registered, &mut ignores),
                (true, false),
                "{kind:?}"
            );
        }
        let mut pending = PendingChanges::default();
        pending
            .push(Event::new(EventKind::Access(AccessKind::Read)).add_path(f.0.join("src/file")));
        assert!(pending.since.is_none());
        assert_eq!(
            pending.assess(&roots, &registered, &mut ignores),
            (false, false)
        );
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
        let mut ignores = Ignores::default();
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
            Event::new(EventKind::Other).set_flag(Flag::Rescan),
        ] {
            let mut pending = PendingChanges::default();
            pending.push(event);
            assert_eq!(
                pending.assess(&roots, &registered, &mut ignores),
                (true, true)
            );
        }
        let mut pending = PendingChanges::default();
        pending
            .push(Event::new(EventKind::Create(CreateKind::Folder)).add_path(f.0.join("target")));
        assert_eq!(
            pending.assess(&roots, &registered, &mut ignores),
            (false, false)
        );
    }

    #[test]
    fn index_changes_rescan_only_when_ignored_paths_become_tracked() {
        let f = Fixture::new();
        f.write(".gitignore", "target/\n");
        f.write("target/artifact", "");
        f.write("src/file", "");
        let roots = vec![f.0.clone()];
        let mut ignores = Ignores::default();
        let index = || {
            let mut pending = PendingChanges::default();
            pending.push(
                Event::new(EventKind::Create(CreateKind::File)).add_path(f.0.join(".git/index")),
            );
            pending
        };
        assert!(ignores.prunes(&f.0, &f.0.join("target")));
        f.git(&["add", "src/file"]);
        assert_eq!(
            index().assess(&roots, &HashSet::new(), &mut ignores),
            (true, false)
        );
        f.git(&["add", "-f", "target/artifact"]);
        assert_eq!(
            index().assess(&roots, &HashSet::new(), &mut ignores),
            (true, true)
        );
        assert!(!ignores.prunes(&f.0, &f.0.join("target")));
    }

    #[test]
    fn restored_roots_refresh_without_registration_events() {
        let f = Fixture::new();
        let root = f.0.join("missing");
        let (rx, stop) = spawn_worker(vec![root.clone()]);
        std::thread::sleep(Duration::from_millis(1500));
        while rx.try_recv().is_ok() {}
        fs::create_dir(&root).unwrap();
        let refreshed = rx.recv_timeout(Duration::from_secs(2));
        stop();
        refreshed.unwrap();
    }

    #[test]
    fn missing_roots_do_not_poll_status() {
        let f = Fixture::new();
        let (rx, stop) = spawn_worker(vec![f.0.join("missing")]);
        let refreshed = rx.recv_timeout(FALLBACK + Duration::from_secs(1));
        stop();
        assert!(refreshed.is_err());
    }

    #[test]
    fn new_roots_refresh_once_coverage_is_in_place() {
        let f = Fixture::new();
        let (rx, stop) = spawn_worker(vec![f.0.clone()]);
        let refreshed = rx.recv_timeout(Duration::from_secs(2));
        stop();
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
    fn learned_ignored_directories_answer_later_paths_from_the_cache() {
        let f = Fixture::new();
        f.write(".gitignore", "target/\n");
        f.write("src/file", "");
        let mut ignores = Ignores::default();
        ignores.rules(&f.0);
        // Created after the repo's listing, as by a build after `cargo clean`.
        f.write("target/debug/a", "");
        assert!(ignores.ignored(&f.0.join("target/debug/a")));
        let rules = &ignores.repos[&f.0];
        assert!(rules.ignored.contains(&f.0.join("target")));
        assert_eq!(rules.lookup(&f.0, &f.0.join("target/debug/b")), Some(true));
    }

    #[test]
    fn registration_prunes_ignored_trees_and_skips_missing_roots() {
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
        let mut ignores = Ignores::default();
        assert!(register(
            &mut watcher,
            Mode::PerDirectory,
            &[f.0.clone(), f.0.join("missing")],
            &mut registered,
            &mut ignores,
            &stopped
        ));
        assert!(registered.contains(&f.0));
        assert!(registered.contains(&f.0.join("vendor")));
        assert!(!registered.contains(&f.0.join("target")));
        assert!(!registered.contains(&f.0.join("node_modules")));
        assert!(!registered.contains(&f.0.join(".git/objects")));
        f.write("target/deep/keep", "");
        f.git(&["add", "-f", "target/deep/keep"]);
        assert!(ignores.tracked_changed(&f.0));
        assert!(register(
            &mut watcher,
            Mode::PerDirectory,
            std::slice::from_ref(&f.0),
            &mut registered,
            &mut ignores,
            &stopped
        ));
        assert!(registered.contains(&f.0.join("target/deep")));
    }

    #[test]
    fn recursive_mode_watches_only_outermost_roots() {
        let f = Fixture::new();
        f.write("tools/build/file", "");
        let mut registered = HashSet::new();
        let roots = [f.0.clone(), f.0.join("tools/build"), f.0.join(".git")];
        assert!(register(
            &mut SilentWatcher,
            Mode::Recursive,
            &roots,
            &mut registered,
            &mut Ignores::default(),
            &AtomicBool::new(false)
        ));
        assert_eq!(registered, HashSet::from([f.0.clone()]));
    }

    #[test]
    fn only_failed_watches_leave_gaps() {
        let f = Fixture::new();
        f.write("src/file", "");
        let mut registered = HashSet::new();
        assert!(register_all(
            &mut SilentWatcher,
            std::slice::from_ref(&f.0),
            &mut registered
        ));
        fs::create_dir(f.0.join("full")).unwrap();
        assert!(!register_all(
            &mut SilentWatcher,
            std::slice::from_ref(&f.0),
            &mut registered
        ));
        assert!(registered.contains(&f.0.join("src")));
        fs::remove_dir(f.0.join("full")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = f.0.join("locked");
            fs::create_dir_all(locked.join("inner")).unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
            let complete = register_all(
                &mut SilentWatcher,
                std::slice::from_ref(&f.0),
                &mut registered,
            );
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(complete);
        }
    }

    #[test]
    fn roots_outside_repositories_are_not_watched() {
        let plain = Fixture::plain();
        if git::repo_root(&plain.0).is_some() {
            return;
        }
        fs::create_dir_all(plain.0.join("node_modules/pkg")).unwrap();
        assert!(watch_dirs(std::slice::from_ref(&plain.0)).is_empty());
    }

    #[test]
    fn edited_global_excludes_invalidate_rules() {
        let f = Fixture::new();
        let excludes = f.0.join("global-ignore");
        fs::write(&excludes, "build/\n").unwrap();
        f.git(&["config", "core.excludesFile", excludes.to_str().unwrap()]);
        let mut ignores = Ignores::default();
        ignores.rules(&f.0);
        assert!(!ignores.excludes_changed());
        let later = SystemTime::now() + Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(&excludes)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert!(ignores.excludes_changed());
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
    fn a_dead_worker_is_replaced_on_the_next_update() {
        let f = Fixture::new();
        let watcher = GitWatcher::default();
        watcher.update(|| panic!("worker failure"), || {});
        let start = Instant::now();
        while !watcher
            .worker
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .thread
            .is_finished()
        {
            assert!(start.elapsed() < Duration::from_secs(2));
            std::thread::yield_now();
        }
        let root = f.0.clone();
        let (tx, rx) = mpsc::channel();
        watcher.update(
            move || vec![root.clone()],
            move || {
                let _ = tx.send(());
            },
        );
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
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
        let mut ignores = Ignores::default();
        assert!(relevant_to(
            &dirs,
            &f.0.join(".git/info/exclude"),
            &mut ignores
        ));
        assert!(relevant_to(&dirs, &f.0.join(".git/config"), &mut ignores));
        assert_eq!(
            watch_dirs(&[component.clone(), f.0.clone()]),
            vec![f.0.clone(), component]
        );
    }
}
