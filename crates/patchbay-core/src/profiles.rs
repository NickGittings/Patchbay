//! Local Claude profiles. Commands snapshot non-secret settings; credentials are resolved at spawn.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const MARKER: &str = "PATCHBAY_AGENT_PROFILE=";
const SERVICE: &str = "app.patchbay.agent-profiles";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub config_dir: String,
    pub model: String,
    pub open_router: bool,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// An OS-store entry id, never its value.
    #[serde(default)]
    pub credential: Option<String>,
    #[serde(default)]
    pub credential_env: Option<String>,
    #[serde(default)]
    pub archived: bool,
}

fn path() -> Result<PathBuf> {
    Ok(crate::workspace::home()?.join("agent-profiles.json"))
}

pub fn list() -> Result<Vec<Profile>> {
    list_at(&path()?)
}

fn list_at(path: &Path) -> Result<Vec<Profile>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&std::fs::read(path)?).context("Cannot read agent profiles")
}

fn expanded(value: &str) -> Result<PathBuf> {
    let path = if let Some(rest) = value.strip_prefix("~/") {
        dirs::home_dir()
            .context("Home directory unavailable")?
            .join(rest)
    } else {
        PathBuf::from(value)
    };
    anyhow::ensure!(
        path.is_absolute(),
        "Claude configuration directory must be absolute"
    );
    Ok(path)
}

fn valid_variable(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

fn entry(id: &str) -> Result<keyring::Entry> {
    anyhow::ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "Invalid credential reference"
    );
    keyring::Entry::new(SERVICE, id)
        .context("OS credential store unavailable; use an environment variable instead")
}

pub fn save(profile: Profile, key: Option<String>, clear_key: bool) -> Result<Profile> {
    save_at(&path()?, profile, key, clear_key)
}

fn save_at(
    path: &Path,
    mut profile: Profile,
    key: Option<String>,
    clear_key: bool,
) -> Result<Profile> {
    let directory = path.parent().context("Missing profile store directory")?;
    crate::workspace::private_dir(directory)?;
    // Lock a stable sibling: atomic replacement changes the store file's identity.
    let guard = crate::workspace::lock(&path.with_extension("lock"))?;
    guard.lock()?;
    let mut profiles = list_at(path)?;
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
        // Duplicates never silently share saved keys.
        profile.credential = None;
    } else {
        let previous = profiles
            .iter()
            .find(|p| p.id == profile.id)
            .context("Profile no longer exists")?;
        profile.credential.clone_from(&previous.credential);
    }
    normalize(&mut profile, directory)?;
    std::fs::create_dir_all(&profile.config_dir)?;
    // Saving validates locally without making an API request.
    if !profile.archived {
        crate::adapters::require_executable(
            &command(&profile)?,
            &PathBuf::from(&profile.config_dir),
            &profile.environment,
        )?;
    }
    if profile.open_router && !profile.archived && key.as_ref().is_none_or(|k| k.is_empty()) {
        let mut candidate = profile.clone();
        if clear_key {
            candidate.credential = None;
        }
        let _ = token(&candidate)?;
    }
    if clear_key && key.as_ref().is_none_or(|k| k.is_empty()) {
        if let Some(id) = &profile.credential {
            entry(id)?.delete_credential().or_else(|e| {
                if matches!(e, keyring::Error::NoEntry) {
                    Ok(())
                } else {
                    Err(e)
                }
            })?;
        }
        profile.credential = None;
    }
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        let id = profile
            .credential
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        entry(&id)?
            .set_password(&key)
            .context("Could not save API key; use an environment variable instead")?;
        profile.credential = Some(id);
        profile.credential_env = None;
    }
    profiles.retain(|p| p.id != profile.id);
    profiles.push(profile.clone());
    crate::workspace::atomic_write(path, &serde_json::to_vec_pretty(&profiles)?)?;
    Ok(profile)
}

/// Checks the fields every stored profile needs and fills the default configuration directory.
fn normalize(profile: &mut Profile, directory: &Path) -> Result<()> {
    anyhow::ensure!(!profile.name.trim().is_empty(), "Enter a profile name");
    anyhow::ensure!(
        !profile.executable.trim().is_empty(),
        "Enter an executable path"
    );
    if profile.config_dir.trim().is_empty() {
        profile.config_dir = directory
            .join("agents")
            .join(&profile.id)
            .display()
            .to_string();
    }
    profile.config_dir = expanded(&profile.config_dir)?.display().to_string();
    anyhow::ensure!(
        !profile.open_router || !profile.model.trim().is_empty(),
        "Enter an OpenRouter model ID"
    );
    for name in profile.environment.keys() {
        anyhow::ensure!(
            valid_variable(name)
                && !name.to_ascii_uppercase().starts_with("PATCHBAY_")
                && !name.to_ascii_uppercase().starts_with("ANTHROPIC_")
                && !["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL"]
                    .contains(&name.to_ascii_uppercase().as_str()),
            "Reserved or invalid environment variable: {name}"
        );
    }
    if let Some(name) = &profile.credential_env {
        anyhow::ensure!(
            valid_variable(name),
            "Invalid credential environment variable"
        );
    }
    Ok(())
}

/// Merge exported profiles into this machine's store, matching on id. Profiles not in `incoming`
/// are kept. Keys never travel: a matching local profile keeps its saved key, others have none.
/// Executables and keys aren't required yet, since the bundle may come from another machine.
/// # Errors
/// Fails if a profile is invalid or the store can't be written; nothing is written then.
pub fn import(incoming: Vec<Profile>) -> Result<Vec<Profile>> {
    import_at(&path()?, incoming)
}

fn import_at(path: &Path, incoming: Vec<Profile>) -> Result<Vec<Profile>> {
    let directory = path.parent().context("Missing profile store directory")?;
    crate::workspace::private_dir(directory)?;
    let guard = crate::workspace::lock(&path.with_extension("lock"))?;
    guard.lock()?;
    let mut profiles = list_at(path)?;
    let mut imported = Vec::with_capacity(incoming.len());
    for mut profile in incoming {
        anyhow::ensure!(
            uuid::Uuid::parse_str(&profile.id).is_ok(),
            "Invalid profile id in settings file"
        );
        anyhow::ensure!(
            imported.iter().all(|p: &Profile| p.id != profile.id),
            "Duplicate profile in settings file"
        );
        // Exported executables under the home folder are written with `~/`.
        if profile.executable.starts_with("~/") {
            profile.executable = expanded(&profile.executable)?.display().to_string();
        }
        normalize(&mut profile, directory)
            .with_context(|| format!("Profile \"{}\"", profile.name))?;
        profile.credential = profiles
            .iter()
            .find(|p| p.id == profile.id)
            .and_then(|p| p.credential.clone());
        imported.push(profile);
    }
    for profile in &imported {
        std::fs::create_dir_all(&profile.config_dir).with_context(|| {
            format!(
                "Cannot create the configuration folder {} of profile \"{}\"",
                profile.config_dir, profile.name
            )
        })?;
    }
    profiles.retain(|p| imported.iter().all(|i| i.id != p.id));
    profiles.extend(imported.iter().cloned());
    crate::workspace::atomic_write(path, &serde_json::to_vec_pretty(&profiles)?)?;
    Ok(imported)
}

/// A profile as it leaves this machine: no keychain reference, and a configuration directory
/// and executable under the home folder written with `~/` so they resolve on the importing
/// machine.
#[must_use]
pub fn portable(mut profile: Profile) -> Profile {
    profile.credential = None;
    if let Some(home) = dirs::home_dir() {
        for path in [&mut profile.config_dir, &mut profile.executable] {
            if let Ok(rest) = Path::new(path.as_str()).strip_prefix(&home)
                && !rest.as_os_str().is_empty()
            {
                *path = format!("~/{}", rest.display());
            }
        }
    }
    profile
}

/// Whether the profile's executable resolves on this machine, as launching it would.
#[must_use]
pub fn executable_available(profile: &Profile) -> bool {
    command(profile).is_ok_and(|command| {
        crate::adapters::require_executable(
            &command,
            Path::new(&profile.config_dir),
            &profile.environment,
        )
        .is_ok()
    })
}

/// Credential failures are classified at their source, before crossing the session transport.
#[derive(Debug)]
pub struct CredentialError(pub anyhow::Error);
impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:#}", self.0)
    }
}
impl std::error::Error for CredentialError {}

fn token(profile: &Profile) -> Result<String> {
    let value = if let Some(name) = &profile.credential_env {
        std::env::var(name).with_context(|| {
            format!("Set {name} in the session service environment and restart the helper")
        })?
    } else if let Some(id) = &profile.credential {
        entry(id)?
            .get_password()
            .context("Profile API key unavailable; replace it in Agent profiles")?
    } else {
        bail!("Set an API key in Agent profiles");
    };
    anyhow::ensure!(!value.is_empty(), "Profile API key is empty");
    Ok(value)
}

pub fn from_command(command: &str) -> Result<Option<Profile>> {
    let Some(words) = crate::context::launch_words(command) else {
        return Ok(None);
    };
    let prefix_length = crate::context::launch_program(command).map_or(0, |(index, _)| index);
    let Some(encoded) = words
        .iter()
        .take(prefix_length)
        .find_map(|word| word.strip_prefix(MARKER))
    else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(encoded)
            .context("Invalid profile snapshot")?,
    )?))
}

pub fn command(profile: &Profile) -> Result<String> {
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(profile)?);
    let mut vars = profile.environment.clone();
    vars.insert("CLAUDE_CONFIG_DIR".into(), profile.config_dir.clone());
    if profile.open_router {
        vars.insert(
            "ANTHROPIC_BASE_URL".into(),
            "https://openrouter.ai/api".into(),
        );
        vars.insert("ANTHROPIC_API_KEY".into(), String::new());
        for alias in ["SONNET", "OPUS", "HAIKU"] {
            vars.insert(
                format!("ANTHROPIC_DEFAULT_{alias}_MODEL"),
                profile.model.clone(),
            );
        }
        vars.insert("CLAUDE_CODE_SUBAGENT_MODEL".into(), profile.model.clone());
    }
    let mut command = format!("{MARKER}{encoded} ");
    for (key, value) in vars {
        command.push_str(&format!(
            "{key}={} ",
            crate::context::quote_argument(&value)
        ));
    }
    if profile.open_router {
        command.push_str("ANTHROPIC_AUTH_TOKEN=\"$PATCHBAY_PROFILE_TOKEN\" ");
    }
    command.push_str(&crate::context::quote_argument(&profile.executable));
    if !profile.model.is_empty() {
        command.push_str(&format!(
            " --model {}",
            crate::context::quote_argument(&profile.model)
        ));
    }
    Ok(command)
}

/// Called only at the PTY boundary; resolved keys never enter a serializable session spec.
pub fn launch_token(command: &str) -> Result<Option<String>> {
    let Some(snapshot) = from_command(command)?.filter(|p| p.open_router) else {
        return Ok(None);
    };
    let profiles = list()?;
    token(credential_profile(&snapshot, &profiles))
        .map(Some)
        .map_err(|e| CredentialError(e).into())
}

fn credential_profile<'a>(snapshot: &'a Profile, profiles: &'a [Profile]) -> &'a Profile {
    // Saved commands retain their launch settings, but clearing or replacing a key must
    // also repair existing sessions. Keep the snapshot fallback for removed profiles.
    profiles
        .iter()
        .find(|profile| profile.id == snapshot.id)
        .unwrap_or(snapshot)
}

pub fn devices() -> Result<Vec<crate::devices::DeviceManifest>> {
    list()?
        .iter()
        .filter(|p| !p.archived)
        .map(|p| {
            Ok(crate::devices::DeviceManifest {
                id: format!("profile-{}", p.id),
                name: p.name.clone(),
                category: "Agents".into(),
                description: Some(
                    if p.open_router {
                        "Claude Code via OpenRouter"
                    } else {
                        "Claude Code profile"
                    }
                    .into(),
                ),
                command: command(p)?,
                kind: crate::TerminalKind::Agent,
                adapter: Some(crate::adapters::Adapter::Claude),
                ready_when: String::new(),
                source: "profile".into(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Store(PathBuf);

    impl Store {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("patchbay-profiles-{}", uuid::Uuid::new_v4())))
        }

        fn path(&self) -> PathBuf {
            self.0.join("agent-profiles.json")
        }
    }

    impl Drop for Store {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> Profile {
        Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Router ✓".into(),
            executable: "claude".into(),
            config_dir: "/tmp/patchbay profile".into(),
            model: "anthropic/example".into(),
            open_router: true,
            environment: BTreeMap::from([("EXAMPLE".into(), "one ' two".into())]),
            credential: Some(uuid::Uuid::new_v4().to_string()),
            credential_env: None,
            archived: false,
        }
    }

    #[test]
    fn import_merges_by_id_keeps_local_keys_and_never_takes_bundle_keys() {
        let store = Store::new();
        let mut local = fixture();
        local.config_dir = store.0.join("local").display().to_string();
        let untouched = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Untouched".into(),
            ..local.clone()
        };
        std::fs::create_dir_all(&store.0).unwrap();
        std::fs::write(
            store.path(),
            serde_json::to_vec(&[local.clone(), untouched.clone()]).unwrap(),
        )
        .unwrap();

        let mut renamed = portable(local.clone());
        renamed.name = "Renamed".into();
        // An executable missing on this machine doesn't block the import.
        renamed.executable = "/nowhere/claude".into();
        let mut arriving = fixture();
        arriving.config_dir.clear();
        let imported = import_at(&store.path(), vec![renamed, arriving.clone()]).unwrap();
        assert_eq!(imported[0].credential, local.credential);
        assert_eq!(
            imported[1].credential, None,
            "A bundle's key reference is dropped"
        );
        assert!(imported[1].config_dir.ends_with(&arriving.id));

        let stored = list_at(&store.path()).unwrap();
        assert_eq!(stored.len(), 3);
        assert!(
            stored
                .iter()
                .any(|p| p.id == untouched.id && p.name == "Untouched")
        );
        assert!(
            stored
                .iter()
                .any(|p| p.id == local.id && p.name == "Renamed")
        );
    }

    #[test]
    fn home_paths_travel_as_tilde_and_expand_on_import() {
        let store = Store::new();
        let home = dirs::home_dir().unwrap();
        let mut profile = fixture();
        profile.executable = home.join(".local/bin/claude").display().to_string();
        profile.config_dir = home.join(".patchbay/agents/x").display().to_string();
        let exported = portable(profile);
        assert_eq!(exported.executable, "~/.local/bin/claude");
        assert_eq!(exported.config_dir, "~/.patchbay/agents/x");
        let mut arriving = exported;
        // Keep the created folder inside the test store.
        arriving.config_dir = store.0.join("cfg").display().to_string();
        let imported = import_at(&store.path(), vec![arriving]).unwrap();
        assert_eq!(
            imported[0].executable,
            home.join(".local/bin/claude").display().to_string()
        );
        assert!(!executable_available(&Profile {
            executable: "/nowhere/patchbay-missing-claude".into(),
            ..imported[0].clone()
        }));
    }

    #[test]
    fn import_writes_nothing_when_any_profile_is_invalid() {
        let store = Store::new();
        let mut good = fixture();
        good.config_dir = store.0.join("good").display().to_string();
        let mut bad = good.clone();
        bad.id = uuid::Uuid::new_v4().to_string();
        bad.environment = BTreeMap::from([("ANTHROPIC_API_KEY".into(), "x".into())]);
        assert!(import_at(&store.path(), vec![good.clone(), bad]).is_err());
        let mut duplicate = good.clone();
        duplicate.name = "Again".into();
        assert!(import_at(&store.path(), vec![good.clone(), duplicate]).is_err());
        let mut odd = good;
        odd.id = "../escape".into();
        assert!(import_at(&store.path(), vec![odd]).is_err());
        assert!(list_at(&store.path()).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn save_finds_executable_on_profile_path() {
        use std::os::unix::fs::PermissionsExt;

        let store = Store::new();
        let bin = store.0.join("custom bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = format!("profile-claude-{}", uuid::Uuid::new_v4());
        let binary = bin.join(&executable);
        std::fs::write(&binary, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut profile = fixture();
        profile.id.clear();
        profile.config_dir.clear();
        profile.executable = executable;
        profile.open_router = false;
        profile.environment = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let saved = save_at(&store.path(), profile, None, false).unwrap();
        assert_eq!(list_at(&store.path()).unwrap()[0].id, saved.id);

        // A different effective PATH must still reject the missing executable.
        let mut missing = saved;
        missing.environment.insert("PATH".into(), "/bin".into());
        assert!(save_at(&store.path(), missing, None, false).is_err());
    }

    // Run by the concurrency test with isolated process environment and state.
    #[test]
    fn save_in_child_process() {
        let Ok(name) = std::env::var("PATCHBAY_PROFILE_TEST_CHILD") else {
            return;
        };
        let directory = crate::workspace::home().unwrap();
        std::fs::write(directory.join(format!("ready-{name}")), "").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !directory.join("start").exists() {
            assert!(std::time::Instant::now() < deadline, "Save start timed out");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut profile = fixture();
        profile.id.clear();
        profile.name = name;
        profile.config_dir.clear();
        profile.open_router = false;
        profile.executable = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into();
        save(profile, None, false).unwrap();
    }

    #[test]
    fn concurrent_process_saves_preserve_every_profile() {
        let store = Store::new();
        std::fs::create_dir_all(&store.0).unwrap();
        let children: Vec<_> = (0..8)
            .map(|index| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "profiles::tests::save_in_child_process",
                        "--nocapture",
                    ])
                    .env("PATCHBAY_STATE_DIR", &store.0)
                    .env("PATCHBAY_PROFILE_TEST_CHILD", index.to_string())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !(0..8).all(|index| store.0.join(format!("ready-{index}")).exists()) {
            assert!(
                std::time::Instant::now() < deadline,
                "Save readiness timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::fs::write(store.0.join("start"), "").unwrap();
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        let profiles = list_at(&store.path()).unwrap();
        assert_eq!(profiles.len(), 8);
        for index in 0..8 {
            assert!(
                profiles
                    .iter()
                    .any(|profile| profile.name == index.to_string())
            );
        }
    }
    #[test]
    fn snapshot_preserves_launch_settings_without_resolving_credentials() {
        let profile = fixture();
        let command = command(&profile).unwrap();
        let snapshot = from_command(&command).unwrap().unwrap();
        assert_eq!(snapshot.config_dir, profile.config_dir);
        assert_eq!(snapshot.model, profile.model);
        assert_eq!(snapshot.environment, profile.environment);
        assert_eq!(snapshot.credential, profile.credential);
        assert!(
            crate::context::launch_words(&command)
                .unwrap()
                .contains(&"ANTHROPIC_API_KEY=".to_owned())
        );
        assert!(command.contains("ANTHROPIC_DEFAULT_HAIKU_MODEL="));
        assert_eq!(
            crate::adapters::Adapter::default_for(&command),
            Some(crate::adapters::Adapter::Claude)
        );
    }
    #[test]
    fn custom_executable_is_still_a_claude_profile() {
        let mut profile = fixture();
        profile.executable = "/tmp/custom claude binary".into();
        let command = command(&profile).unwrap();
        assert_eq!(
            crate::context::command_provider(&command),
            Some(crate::adapters::Adapter::Claude)
        );
        assert!(crate::context::launch_program(&command).is_some());
    }
    #[test]
    fn resumed_session_uses_current_environment_credentials_and_recorded_settings() {
        let original = fixture();
        let saved_command = command(&original).unwrap();
        let snapshot = from_command(&saved_command).unwrap().unwrap();
        let mut current = original.clone();
        current.credential = None;
        current.credential_env = Some("PATH".into());
        current.model = "different/model".into();
        current.config_dir = "/tmp/different profile".into();
        let profiles = [current];

        let credentials = credential_profile(&snapshot, &profiles);
        assert!(credentials.credential.is_none());
        assert_eq!(credentials.credential_env.as_deref(), Some("PATH"));
        assert_eq!(token(credentials).unwrap(), std::env::var("PATH").unwrap());
        assert_eq!(snapshot.model, original.model);
        assert_eq!(snapshot.config_dir, original.config_dir);
        assert_eq!(
            from_command(&saved_command).unwrap().unwrap().model,
            original.model
        );
    }
    #[test]
    fn resumed_session_uses_replacement_saved_key_and_honors_cleared_credentials() {
        let snapshot = fixture();
        let mut current = snapshot.clone();
        current.credential = Some(uuid::Uuid::new_v4().to_string());
        let profiles = [current.clone()];
        assert_eq!(
            credential_profile(&snapshot, &profiles).credential,
            current.credential
        );
        current.credential = None;
        let profiles = [current];
        assert!(token(credential_profile(&snapshot, &profiles)).is_err());
        assert_eq!(
            credential_profile(&snapshot, &[]).credential,
            snapshot.credential
        );
    }
    #[test]
    fn invalid_snapshot_and_missing_credentials_fail_without_fallback() {
        assert!(from_command("PATCHBAY_AGENT_PROFILE=bad claude").is_err());
        assert!(from_command("claude").unwrap().is_none());
        let mut profile = fixture();
        profile.credential = None;
        assert!(launch_token(&command(&profile).unwrap()).is_err());
        profile.open_router = false;
        assert!(launch_token(&command(&profile).unwrap()).unwrap().is_none());
    }
    #[test]
    fn names_and_paths_are_validated() {
        assert!(valid_variable("OPENROUTER_API_KEY"));
        assert!(!valid_variable("A;echo"));
        assert!(!valid_variable("1KEY"));
        assert!(expanded("relative/path").is_err());
    }
}
