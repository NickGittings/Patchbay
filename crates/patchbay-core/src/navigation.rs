//! Machine-local editor handoff and bounded, read-only path search.
use crate::{files, model, workspace};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorKind {
    #[default]
    VsCode,
    Cursor,
    Zed,
    Custom,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreferences {
    pub editor: EditorKind,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
}
impl Default for EditorPreferences {
    fn default() -> Self {
        Self {
            editor: EditorKind::VsCode,
            executable: String::new(),
            arguments: vec!["{file}".into()],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTarget {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorLauncher {
    pub editor: EditorKind,
    pub executable: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    /// Always relative to the requested workspace root, including sibling repos.
    pub path: String,
    pub name: String,
}

/// Load preferences outside the saved component map.
/// # Errors
/// Fails on malformed preferences or inaccessible machine-local state.
pub fn preferences() -> Result<EditorPreferences> {
    match std::fs::read(workspace::home()?.join("editor.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(EditorPreferences::default()),
        Err(e) => Err(e.into()),
    }
}
/// Save machine-local preferences atomically.
/// # Errors
/// Fails if a custom executable is empty or preferences cannot be saved.
pub fn save_preferences(prefs: &EditorPreferences) -> Result<()> {
    ensure!(
        prefs.editor != EditorKind::Custom || !prefs.executable.trim().is_empty(),
        "Set a custom editor executable"
    );
    ensure!(
        prefs.arguments.len() <= 100,
        "At most 100 editor arguments are supported"
    );
    workspace::atomic_write(
        &workspace::home()?.join("editor.json"),
        &serde_json::to_vec_pretty(prefs)?,
    )
}

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(windows)]
    {
        path.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
}
#[cfg(unix)]
fn probe_login_path(
    shell: &std::ffi::OsStr,
    timeout: std::time::Duration,
) -> Option<std::ffi::OsString> {
    use std::io::Read;
    use std::os::unix::{ffi::OsStringExt, fs::OpenOptionsExt};
    // A file avoids pipe readers waiting indefinitely for shell-startup descendants.
    let output_path =
        std::env::temp_dir().join(format!("patchbay-editor-path-{}", uuid::Uuid::new_v4()));
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output_path)
        .ok()?;
    let result = (|| {
        let mut child = Command::new(shell)
            .args(["-ilc", "printf '\\0PATCHBAY_EDITOR_PATH\\0%s\\0' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(output)
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return None;
                    }
                    break;
                }
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&output_path)
            .ok()?
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .ok()?;
        let mut parts = bytes.split(|b| *b == 0);
        while let Some(part) = parts.next() {
            if part == b"PATCHBAY_EDITOR_PATH" {
                return parts
                    .next()
                    .map(|path| std::ffi::OsString::from_vec(path.to_vec()));
            }
        }
        None
    })();
    let _ = std::fs::remove_file(output_path);
    result
}
/// Only fixed shell code probes PATH; neither project paths nor custom strings enter it.
/// Probed once per process, since starting a login shell can take seconds.
fn login_path() -> std::ffi::OsString {
    static PATH: std::sync::OnceLock<std::ffi::OsString> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        #[cfg(unix)]
        {
            let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
            if let Some(path) = probe_login_path(&shell, std::time::Duration::from_secs(2)) {
                return path;
            }
        }
        std::env::var_os("PATH").unwrap_or_default()
    })
    .clone()
}
fn find_program(program: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    let p = Path::new(program);
    if p.is_absolute() {
        return executable(p).then(|| p.to_path_buf());
    }
    // Never resolve executables against a repository's current directory.
    if p.components().count() != 1 {
        return None;
    }
    std::env::split_paths(path)
        .filter(|p| p.is_absolute())
        .find_map(|dir| {
            let p = dir.join(program);
            if executable(&p) {
                return Some(p);
            }
            #[cfg(windows)]
            if p.extension().is_none() && executable(&p.with_extension("exe")) {
                return Some(p.with_extension("exe"));
            }
            None
        })
}
fn built_in(editor: &EditorKind, path: &std::ffi::OsStr) -> Option<PathBuf> {
    let name = match editor {
        EditorKind::VsCode => "code",
        EditorKind::Cursor => "cursor",
        EditorKind::Zed => "zed",
        EditorKind::Custom => return None,
    };
    if let Some(found) = find_program(name, path) {
        return Some(found);
    }
    let mut candidates = Vec::<PathBuf>::new();
    #[cfg(target_os = "macos")]
    {
        let (app, launcher) = match editor {
            EditorKind::VsCode => ("Visual Studio Code", "Resources/app/bin/code"),
            EditorKind::Cursor => ("Cursor", "Resources/app/bin/cursor"),
            EditorKind::Zed => ("Zed", "MacOS/cli"),
            EditorKind::Custom => unreachable!(),
        };
        candidates.push(PathBuf::from(format!(
            "/Applications/{app}.app/Contents/{launcher}"
        )));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(format!("Applications/{app}.app/Contents/{launcher}")));
        }
    }
    #[cfg(target_os = "linux")]
    {
        candidates.extend(
            [
                format!("/usr/bin/{name}"),
                format!("/usr/local/bin/{name}"),
                format!("/snap/bin/{name}"),
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join(format!(".local/bin/{name}")));
        }
    }
    #[cfg(windows)]
    {
        let (folder, exe) = match editor {
            EditorKind::VsCode => ("Microsoft VS Code", "Code.exe"),
            EditorKind::Cursor => ("cursor", "Cursor.exe"),
            EditorKind::Zed => ("Zed", "zed.exe"),
            EditorKind::Custom => unreachable!(),
        };
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs").join(folder).join(exe));
        }
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(key) {
                candidates.push(PathBuf::from(dir).join(folder).join(exe));
            }
        }
    }
    candidates.into_iter().find(|p| executable(p))
}
/// Discover supported launchers using login-shell PATH and standard installations.
#[must_use]
pub fn discover() -> Vec<EditorLauncher> {
    let path = login_path();
    [EditorKind::VsCode, EditorKind::Cursor, EditorKind::Zed]
        .into_iter()
        .map(|editor| {
            let executable = built_in(&editor, &path).map(|p| p.to_string_lossy().into_owned());
            EditorLauncher { editor, executable }
        })
        .collect()
}

fn arguments(prefs: &EditorPreferences, target: &EditorTarget, path: &Path) -> Result<Vec<String>> {
    ensure!(
        target.line != Some(0) && target.column != Some(0),
        "Line and column must start at 1"
    );
    let file = path.to_string_lossy();
    let folder = if path.is_dir() {
        path
    } else {
        path.parent().context("Missing parent folder")?
    }
    .to_string_lossy();
    if prefs.editor == EditorKind::Custom {
        let line = target.line.unwrap_or(1).to_string();
        let column = target.column.unwrap_or(1).to_string();
        // Substitute once. A filename containing a placeholder must remain literal.
        return Ok(prefs
            .arguments
            .iter()
            .map(|arg| {
                let mut out = String::new();
                let mut rest = arg.as_str();
                while let Some(start) = rest.find('{') {
                    out.push_str(&rest[..start]);
                    let found = [
                        ("{folder}", folder.as_ref()),
                        ("{file}", file.as_ref()),
                        ("{line}", line.as_str()),
                        ("{column}", column.as_str()),
                    ]
                    .into_iter()
                    .find(|(key, _)| rest[start..].starts_with(key));
                    if let Some((key, value)) = found {
                        out.push_str(value);
                        rest = &rest[start + key.len()..];
                    } else {
                        out.push('{');
                        rest = &rest[start + 1..];
                    }
                }
                out.push_str(rest);
                out
            })
            .collect());
    }
    if path.is_dir() || target.line.is_none() {
        return Ok(vec![file.into_owned()]);
    }
    let located = format!(
        "{}:{}:{}",
        file,
        target.line.unwrap_or(1),
        target.column.unwrap_or(1)
    );
    Ok(if prefs.editor == EditorKind::Zed {
        vec![located]
    } else {
        vec!["--goto".into(), located]
    })
}
/// Resolve through canonical access checks, then launch with literal argument boundaries.
/// # Errors
/// Fails on unavailable launchers, invalid/denied targets, or process launch failure.
pub fn open(prefs: &EditorPreferences, roots: &[PathBuf], target: &EditorTarget) -> Result<()> {
    let resolved = files::resolve(roots, Path::new(&target.path))?;
    let path = login_path();
    let program = if prefs.editor == EditorKind::Custom { find_program(&prefs.executable, &path) } else { built_in(&prefs.editor, &path) }
        .context("Editor unavailable: Install its command-line launcher or set a custom executable in Preferred editor")?;
    let args = arguments(prefs, target, &resolved)?;
    let mut child = Command::new(program)
        .args(args)
        .env("PATH", &path)
        .current_dir(&roots[0])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context(
            "Editor unavailable: Could not launch the selected editor; check Preferred editor",
        )?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Parse compiler-style locations without guessing or looking up other filenames.
/// # Errors
/// Fails if a reference does not contain a valid positive line/column.
pub fn reference(text: &str) -> Result<EditorTarget> {
    let positive = |v: &str| -> Result<u32> {
        let n = v.parse::<u32>()?;
        ensure!(n > 0, "Line and column must start at 1");
        Ok(n)
    };
    let (path, line, column) = if let Some(body) = text.strip_suffix(')') {
        let (path, location) = body.rsplit_once('(').context("Invalid file reference")?;
        let (line, col) = location.split_once(',').context("Invalid file reference")?;
        (path, positive(line)?, Some(positive(col)?))
    } else {
        let (prefix, last) = text.rsplit_once(':').context("Invalid file reference")?;
        let last = positive(last)?;
        if let Some((path, line)) = prefix.rsplit_once(':')
            && let Ok(line) = positive(line)
        {
            (path, line, Some(last))
        } else {
            (prefix, last, None)
        }
    };
    let path = path.trim_matches(['\'', '"']);
    ensure!(
        !path.is_empty() && !path.contains("://"),
        "Invalid file reference"
    );
    Ok(EditorTarget {
        path: path.into(),
        line: Some(line),
        column,
    })
}

/// Bounds the walk of folders outside Git, which have no ignore rules to prune them.
const WALK_DEPTH: usize = 16;
const WALK_LIMIT: usize = 200_000;
fn walk(dir: &Path, depth: usize, paths: &mut BTreeSet<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == ".git" || crate::detect::SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        if paths.len() >= WALK_LIMIT {
            break;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if depth < WALK_DEPTH {
                walk(&entry.path(), depth + 1, paths)?;
            }
        } else if kind.is_file() || kind.is_symlink() {
            paths.insert(entry.path());
        }
    }
    Ok(())
}
fn rank(path: &str, query: &str) -> Option<(usize, usize)> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if query.is_empty() {
        return Some((5, path.len()));
    }
    if name == query {
        return Some((0, path.len()));
    }
    if name.starts_with(query) {
        return Some((1, path.len()));
    }
    if name.contains(query) {
        return Some((2, path.len()));
    }
    if path.contains(query) {
        return Some((3, path.len()));
    }
    let mut chars = query.chars();
    let mut next = chars.next();
    for c in path.chars() {
        if next == Some(c) {
            next = chars.next();
        }
    }
    next.is_none().then_some((4, path.len()))
}
/// Search paths under approved roots. Git supplies ignored-untracked filtering while
/// including tracked files even if a later ignore rule matches them. No symlinks are walked.
/// # Errors
/// Fails if an available root cannot be read or a Git enumeration fails.
pub fn search(
    roots: &[PathBuf],
    scan_roots: &[PathBuf],
    query: &str,
) -> Result<Vec<FileSearchResult>> {
    let root = roots.first().context("No project is open")?;
    let mut paths = BTreeSet::new();
    // A root inside another scanned root (a component folder in the project) adds nothing.
    let mut scanned: Vec<&PathBuf> = Vec::new();
    let mut ordered: Vec<&PathBuf> = scan_roots.iter().collect();
    ordered.sort_by_key(|d| d.components().count());
    for dir in ordered {
        if !dir.exists() || scanned.iter().any(|s| dir.starts_with(s)) {
            continue;
        }
        files::resolve(roots, dir)?;
        scanned.push(dir);
        let repo = crate::git::repo_root(dir);
        if repo.is_some() {
            let output = crate::git::git(dir)
                .args([
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    ".",
                ])
                .output()?;
            ensure!(
                output.status.success(),
                "File search failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            for name in output.stdout.split(|b| *b == 0).filter(|n| !n.is_empty()) {
                #[cfg(unix)]
                let name = {
                    use std::os::unix::ffi::OsStrExt;
                    std::ffi::OsStr::from_bytes(name).to_os_string()
                };
                #[cfg(windows)]
                let name = std::ffi::OsString::from(String::from_utf8(name.to_vec())?);
                paths.insert(dir.join(name));
            }
        } else {
            walk(dir, 0, &mut paths)?;
        }
    }
    let query = query.trim().replace('\\', "/").to_lowercase();
    // Rank the cheap relative names first; only the best candidates touch the filesystem.
    let mut ranked: Vec<_> = paths
        .into_iter()
        .filter_map(|full| {
            let path = model::relative_path(root, &full);
            let score = rank(&path.to_lowercase(), &query)?;
            Some((score, path, full))
        })
        .collect();
    ranked.sort_by(|(a, x, _), (b, y, _)| a.cmp(b).then_with(|| x.cmp(y)));
    Ok(ranked
        .into_iter()
        .filter(|(_, _, full)| files::resolve(roots, full).is_ok_and(|r| r.is_file()))
        .take(100)
        .map(|(_, path, _)| {
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            FileSearchResult { path, name }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("patchbay-navigation-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn roots(&self) -> &[PathBuf] {
            std::slice::from_ref(&self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[cfg(unix)]
    #[test]
    fn login_path_probe_ignores_startup_output_and_has_a_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let shell = fixture.0.join("shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\nprintf 'startup output\\n'\n/bin/sh -c \"$2\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            probe_login_path(shell.as_os_str(), std::time::Duration::from_secs(1)),
            std::env::var_os("PATH")
        );
        std::fs::write(&shell, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        let start = std::time::Instant::now();
        assert!(
            probe_login_path(shell.as_os_str(), std::time::Duration::from_millis(50)).is_none()
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
    }
    #[test]
    fn parses_both_formats_and_windows_drive_without_guessing() {
        let t = reference("src/main.rs:12:4").unwrap();
        assert_eq!(t.path, "src/main.rs");
        assert_eq!(t.column, Some(4));
        let t = reference("C:\\project\\main.rs(12,4)").unwrap();
        assert_eq!(t.path, "C:\\project\\main.rs");
        assert_eq!(reference("'some file.rs':7").unwrap().path, "some file.rs");
        assert!(reference("src/a.rs:0").is_err());
        assert!(reference("https://example.com:80").is_err());
    }
    #[test]
    fn placeholders_keep_spaces_punctuation_and_literal_placeholder_names() {
        let f = Fixture::new();
        let path = f.0.join("a {line} ' $().rs");
        std::fs::write(&path, "").unwrap();
        let prefs = EditorPreferences {
            editor: EditorKind::Custom,
            executable: "/bin/echo".into(),
            arguments: vec![
                "{file}".into(),
                "--location={line}:{column}".into(),
                "{folder}".into(),
            ],
        };
        let target = EditorTarget {
            path: path.display().to_string(),
            line: Some(11),
            column: Some(3),
        };
        let args = arguments(&prefs, &target, &path).unwrap();
        assert_eq!(args[0], path.to_string_lossy());
        assert_eq!(args[1], "--location=11:3");
        assert_eq!(args[2], f.0.to_string_lossy());
    }
    #[cfg(unix)]
    #[test]
    fn launches_custom_editor_with_literal_argv_and_no_shell_evaluation() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let target = fixture.0.join("file ; $() ' {line}.rs");
        std::fs::write(&target, "").unwrap();
        let output = fixture.0.join("argv");
        let launcher = fixture.0.join("editor with spaces");
        std::fs::write(
            &launcher,
            format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" > '{}'\n",
                output.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let prefs = EditorPreferences {
            editor: EditorKind::Custom,
            executable: launcher.display().to_string(),
            arguments: vec![
                "{file}".into(),
                "{line}".into(),
                "; touch unexpected".into(),
            ],
        };
        open(
            &prefs,
            fixture.roots(),
            &EditorTarget {
                path: target.display().to_string(),
                line: Some(7),
                column: None,
            },
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Ok(bytes) = std::fs::read(&output)
                && !bytes.is_empty()
            {
                let expected =
                    format!("{}\0{}\0{}\0", target.display(), 7, "; touch unexpected").into_bytes();
                assert_eq!(bytes, expected);
                assert!(!fixture.0.join("unexpected").exists());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "editor did not receive arguments"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[test]
    fn missing_launcher_reports_actionable_configuration_error() {
        let f = Fixture::new();
        let prefs = EditorPreferences {
            editor: EditorKind::Custom,
            executable: f.0.join("missing editor").display().to_string(),
            arguments: vec!["{file}".into()],
        };
        let error = open(
            &prefs,
            f.roots(),
            &EditorTarget {
                path: ".".into(),
                line: None,
                column: None,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("Editor unavailable:"));
        assert!(error.to_string().contains("Preferred editor"));
    }
    #[test]
    fn sibling_roots_are_searchable_only_when_approved() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.0.join("project")).unwrap();
        std::fs::create_dir_all(f.0.join("sibling/src")).unwrap();
        std::fs::write(f.0.join("sibling/src/component.rs"), "").unwrap();
        let roots = [f.0.join("project"), f.0.join("sibling")];
        assert_eq!(
            search(&roots, &roots, "component").unwrap()[0].path,
            "../sibling/src/component.rs"
        );
        assert!(search(&roots[..1], &roots, "component").is_err());
    }
    #[test]
    fn git_search_includes_tracked_ignored_and_omits_untracked_ignored_files() {
        let f = Fixture::new();
        let git = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&f.0)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        git(&["init", "-q"]);
        std::fs::write(f.0.join("tracked.log"), "").unwrap();
        git(&["add", "tracked.log"]);
        std::fs::write(f.0.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(f.0.join("ignored.log"), "").unwrap();
        std::fs::write(f.0.join("visible.txt"), "").unwrap();
        let found = search(f.roots(), f.roots(), "").unwrap();
        assert!(found.iter().any(|r| r.path == "tracked.log"));
        assert!(!found.iter().any(|r| r.path == "ignored.log"));
        assert!(found.iter().any(|r| r.path == "visible.txt"));
    }
    #[test]
    fn ranks_filenames_before_paths_and_caps_results() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join("needle")).unwrap();
        for i in 0..150 {
            std::fs::write(f.0.join(format!("needle/other-{i}.txt")), "").unwrap();
        }
        std::fs::write(f.0.join("needle.txt"), "").unwrap();
        let found = search(f.roots(), f.roots(), "needle").unwrap();
        assert_eq!(found.len(), 100);
        assert_eq!(found[0].path, "needle.txt");
    }
    #[cfg(unix)]
    #[test]
    fn refuses_denied_roots_and_symlink_escape_targets() {
        let f = Fixture::new();
        let outside = Fixture::new();
        std::fs::write(outside.0.join("secret.txt"), "").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.txt"), f.0.join("alias.txt")).unwrap();
        assert!(search(f.roots(), outside.roots(), "").is_err());
        assert!(search(f.roots(), f.roots(), "").unwrap().is_empty());
        let prefs = EditorPreferences {
            editor: EditorKind::Custom,
            executable: "/bin/echo".into(),
            arguments: vec!["{file}".into()],
        };
        assert!(
            open(
                &prefs,
                f.roots(),
                &EditorTarget {
                    path: "alias.txt".into(),
                    line: None,
                    column: None
                }
            )
            .is_err()
        );
    }
}
