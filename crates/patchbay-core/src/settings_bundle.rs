//! A portable file of the user's machine-wide settings, for backups and moving machines.
//!
//! It holds the user's preferences from the workspace document's `settings` block (agent roles,
//! notifications, usage and the like), editor preferences and agent profiles. Keychain keys,
//! runtime state such as pending merge cleanups, session history, project layouts and
//! per-repository task stores never enter it.
use crate::{navigation, profiles, workspace};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

pub const FORMAT: &str = "patchbay-settings";
pub const VERSION: u32 = 1;
/// The workspace settings that are the user's choices. Everything else in the block (hook
/// sources, pending merge cleanups, retired keys) describes this machine or work in progress,
/// so it is neither exported nor applied on import.
pub const PORTABLE_SETTINGS: &[&str] = &[
    "agentRoles",
    "notifications",
    "usage",
    "chatAgent",
    "autoKeepAwake",
    "mergeCleanup",
    "reviewCouncil",
];
const FILE_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    #[serde(default)]
    pub settings: Map<String, Value>,
    #[serde(default)]
    pub editor: Option<navigation::EditorPreferences>,
    #[serde(default)]
    pub agent_profiles: Vec<profiles::Profile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// Workspace settings for the frontend to apply and save.
    pub settings: Map<String, Value>,
    /// Names of imported OpenRouter profiles with no key on this machine.
    pub profiles_needing_keys: Vec<String>,
    /// Names of imported profiles whose executable isn't found on this machine.
    pub profiles_missing_programs: Vec<String>,
}

fn portable_settings(mut settings: Map<String, Value>) -> Map<String, Value> {
    settings.retain(|key, _| PORTABLE_SETTINGS.contains(&key.as_str()));
    settings
}

/// Leave profile environment values out, for an export the user wants to share.
pub fn drop_environments(bundle: &mut Bundle) {
    for profile in &mut bundle.agent_profiles {
        profile.environment.clear();
    }
}

/// Whether any exported profile carries environment variables, which may hold tokens.
#[must_use]
pub fn has_environments(bundle: &Bundle) -> bool {
    bundle
        .agent_profiles
        .iter()
        .any(|p| !p.environment.is_empty())
}

/// A bundle of the given workspace settings and this machine's editor and profiles.
/// # Errors
/// Fails if the editor preferences or profile store can't be read.
pub fn export(settings: Map<String, Value>) -> Result<Bundle> {
    Ok(bundle(
        settings,
        navigation::preferences()?,
        profiles::list()?,
    ))
}

fn bundle(
    settings: Map<String, Value>,
    editor: navigation::EditorPreferences,
    agent_profiles: Vec<profiles::Profile>,
) -> Bundle {
    Bundle {
        format: FORMAT.into(),
        version: VERSION,
        exported_at: chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
            .to_rfc3339(),
        settings: portable_settings(settings),
        editor: Some(editor),
        agent_profiles: agent_profiles.into_iter().map(profiles::portable).collect(),
    }
}

/// Write a bundle where the user chose, replacing the file whole. The file is readable only by
/// its owner; unlike `workspace::atomic_write`, the user's folder keeps its permissions.
/// # Errors
/// Fails if the file can't be written.
pub fn write(path: &Path, bundle: &Bundle) -> Result<()> {
    let parent = path.parent().context("Missing parent directory")?;
    let tmp = parent.join(format!(".patchbay-settings-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(bundle)?;
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        std::io::Write::write_all(&mut options.open(&tmp)?, &bytes)?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.with_context(|| format!("Cannot write {}", path.display()))
}

/// Read and check a bundle file.
/// # Errors
/// Fails if the file is too large, malformed, or not a settings file this version understands.
pub fn read(path: &Path) -> Result<Bundle> {
    let size = std::fs::metadata(path)
        .with_context(|| format!("Cannot read {}", path.display()))?
        .len();
    ensure!(size <= FILE_LIMIT, "Settings files are at most 4 MiB");
    parse(&std::fs::read(path)?)
}

fn parse(bytes: &[u8]) -> Result<Bundle> {
    let value: Value = serde_json::from_slice(bytes).context("Not a JSON file")?;
    ensure!(
        value.get("format").and_then(Value::as_str) == Some(FORMAT),
        "Not a Patchbay settings file"
    );
    let version = value.get("version").and_then(Value::as_u64);
    ensure!(
        version == Some(u64::from(VERSION)),
        "This settings file needs a newer version of Patchbay"
    );
    serde_json::from_value(value).context("Settings file is damaged")
}

/// Apply a bundle's editor preferences and profiles, and return its workspace settings for the
/// frontend. Both are checked first; if saving profiles fails, the earlier editor preferences
/// are put back, so a failed import changes neither.
/// # Errors
/// Fails if the bundle holds invalid preferences or profiles, or the stores can't be written.
pub fn import(bundle: Bundle) -> Result<Imported> {
    // Make sure the state folder exists for the frontend's workspace save.
    workspace::private_dir(&workspace::home()?)?;
    let previous = navigation::preferences()?;
    if let Some(editor) = &bundle.editor {
        navigation::validate_preferences(editor)?;
        navigation::save_preferences(editor)?;
    }
    let imported = match profiles::import(bundle.agent_profiles) {
        Ok(imported) => imported,
        Err(e) => {
            if bundle.editor.is_some() {
                let _ = navigation::save_preferences(&previous);
            }
            return Err(e);
        }
    };
    let profiles_missing_programs = imported
        .iter()
        .filter(|p| !p.archived && !profiles::executable_available(p))
        .map(|p| p.name.clone())
        .collect();
    Ok(Imported {
        settings: portable_settings(bundle.settings),
        profiles_needing_keys: profiles_needing_keys(&imported),
        profiles_missing_programs,
    })
}

fn profiles_needing_keys(imported: &[profiles::Profile]) -> Vec<String> {
    imported
        .iter()
        .filter(|p| {
            p.open_router && !p.archived && p.credential.is_none() && p.credential_env.is_none()
        })
        .map(|p| p.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn profile(name: &str) -> profiles::Profile {
        profiles::Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            executable: "claude".into(),
            config_dir: dirs::home_dir()
                .unwrap()
                .join(".patchbay/agents/x")
                .display()
                .to_string(),
            model: "anthropic/example".into(),
            open_router: true,
            environment: BTreeMap::new(),
            credential: Some(uuid::Uuid::new_v4().to_string()),
            credential_env: None,
            archived: false,
        }
    }

    fn settings() -> Map<String, Value> {
        serde_json::json!({
            "agentRoles": { "review": ["codex"] },
            "notifications": { "sound": false },
            "hookSources": { "claude": "/Users/someone/.claude" },
            "implementSubagents": true,
            "mergeCleanupJobs": [{ "id": "job" }],
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn export_leaves_out_keys_and_machine_settings() {
        let bundle = bundle(
            settings(),
            navigation::EditorPreferences::default(),
            vec![profile("Router")],
        );
        let text = serde_json::to_string(&bundle).unwrap();
        assert!(bundle.agent_profiles[0].credential.is_none());
        assert_eq!(bundle.agent_profiles[0].config_dir, "~/.patchbay/agents/x");
        for key in ["hookSources", "implementSubagents", "mergeCleanupJobs"] {
            assert!(!text.contains(key), "{key} stays on this machine");
        }
        assert_eq!(bundle.settings["agentRoles"]["review"][0], "codex");
    }

    #[test]
    fn written_bundle_reads_back_and_leaves_folder_permissions() {
        let dir = std::env::temp_dir().join(format!("patchbay-bundle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = dir.join("settings.json");
        let original = bundle(
            settings(),
            navigation::EditorPreferences::default(),
            vec![profile("Router")],
        );
        write(&path, &original).unwrap();
        let back = read(&path).unwrap();
        assert_eq!(back.settings, original.settings);
        assert_eq!(back.agent_profiles[0].id, original.agent_profiles[0].id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
            let file = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(file, 0o600, "Profile environments may hold tokens");
        }
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "No temp file left"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn environments_can_be_left_out() {
        let mut with_env = profile("Env");
        with_env.environment = BTreeMap::from([("GITHUB_TOKEN".into(), "ghp_x".into())]);
        let mut bundle = bundle(
            Map::new(),
            navigation::EditorPreferences::default(),
            vec![with_env, profile("Plain")],
        );
        assert!(has_environments(&bundle));
        drop_environments(&mut bundle);
        assert!(!has_environments(&bundle));
        assert!(!serde_json::to_string(&bundle).unwrap().contains("ghp_x"));
    }

    #[test]
    fn parse_rejects_other_files_and_versions() {
        assert!(parse(b"not json").is_err());
        assert!(parse(br#"{"format":"other","version":1}"#).is_err());
        let newer = parse(br#"{"format":"patchbay-settings","version":2,"exportedAt":""}"#);
        assert!(newer.unwrap_err().to_string().contains("newer version"));
        let minimal =
            parse(br#"{"format":"patchbay-settings","version":1,"exportedAt":""}"#).unwrap();
        assert!(minimal.settings.is_empty() && minimal.agent_profiles.is_empty());
    }

    #[test]
    fn only_openrouter_profiles_without_any_key_need_one() {
        let mut keyed = profile("Keyed");
        let mut from_env = profile("Env");
        from_env.credential = None;
        from_env.credential_env = Some("ROUTER_KEY".into());
        let mut missing = profile("Missing");
        missing.credential = None;
        let mut plain = profile("Plain");
        plain.credential = None;
        plain.open_router = false;
        keyed.archived = false;
        assert_eq!(
            profiles_needing_keys(&[keyed, from_env, missing, plain]),
            vec!["Missing".to_string()]
        );
    }
}
