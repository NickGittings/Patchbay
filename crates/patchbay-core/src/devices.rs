//! Devices are terminal presets you can add to any component. Built-ins use the
//! same manifest format as user-defined devices in `~/.patchbay/devices/`.

use crate::model::TerminalKind;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<crate::adapters::Adapter>,
    pub id: String,
    pub name: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Empty for an interactive shell.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub kind: TerminalKind,
    /// Copied to the terminal's `readyWhen`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ready_when: String,
    /// "builtin", "extension:<id>" or "user"; filled in on load.
    #[serde(default)]
    pub source: String,
}

fn default_category() -> String {
    "Custom".into()
}

const BUILTIN: &[&str] = &[
    include_str!("../../../devices/shell.device.json"),
    include_str!("../../../devices/claude.device.json"),
    include_str!("../../../devices/codex.device.json"),
    include_str!("../../../devices/lazygit.device.json"),
];

/// `devices` in Patchbay's state folder (`~/.patchbay`, or `$PATCHBAY_STATE_DIR` for a test run).
#[must_use]
pub fn user_devices_dir() -> Option<PathBuf> {
    crate::workspace::home().ok().map(|h| h.join("devices"))
}

/// Built-in devices, enabled extension devices, then user device files.
/// Later sources override earlier devices with the same id.
#[must_use]
pub fn load_devices(registry: &crate::extensions::Registry) -> Vec<DeviceManifest> {
    load_from(registry, user_devices_dir().as_deref())
}

fn load_from(
    registry: &crate::extensions::Registry,
    user_dir: Option<&std::path::Path>,
) -> Vec<DeviceManifest> {
    let mut devices: Vec<DeviceManifest> = BUILTIN
        .iter()
        .filter_map(|s| serde_json::from_str::<DeviceManifest>(s).ok())
        .map(|mut d| {
            d.source = "builtin".into();
            d
        })
        .collect();

    for device in registry.devices() {
        devices.retain(|d| d.id != device.id);
        devices.push(device);
    }
    if let Some(dir) = user_dir
        && let Ok(entries) = std::fs::read_dir(dir)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.to_string_lossy().ends_with(".device.json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut d) = serde_json::from_str::<DeviceManifest>(&text) else {
                continue;
            };
            d.source = "user".into();
            devices.retain(|x| x.id != d.id);
            devices.push(d);
        }
    }
    devices
}

/// # Errors
/// Fails if the user devices folder cannot be created or written.
pub fn save_device(device: &DeviceManifest) -> Result<PathBuf> {
    let dir = user_devices_dir().context("no home directory")?;
    std::fs::create_dir_all(&dir)?;
    let slug: String = device
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path = dir.join(format!("{slug}.device.json"));
    let mut d = device.clone();
    d.source = String::new();
    std::fs::write(&path, serde_json::to_string_pretty(&d)?)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    #[test]
    fn precedence_is_builtin_extension_user() {
        let dir =
            std::env::temp_dir().join(format!("patchbay-device-precedence-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let device: super::DeviceManifest =
            serde_json::from_str(r#"{"id":"shell","name":"Extension shell","command":"ext"}"#)
                .unwrap();
        let mut manifest = crate::extensions::ExtensionManifest::default();
        manifest.contributes.devices.push(device);
        let registry = crate::extensions::Registry {
            extensions: vec![crate::extensions::Extension {
                id: "acme.test".into(),
                dir: dir.clone(),
                manifest,
                enabled: true,
                errors: vec![],
            }],
            errors: vec![],
        };
        let devices = super::load_from(&registry, None);
        assert_eq!(
            devices.iter().find(|d| d.id == "shell").unwrap().command,
            "ext"
        );
        std::fs::write(
            dir.join("shell.device.json"),
            r#"{"id":"shell","name":"User shell","command":"user"}"#,
        )
        .unwrap();
        let devices = super::load_from(&registry, Some(&dir));
        let shell = devices.iter().find(|d| d.id == "shell").unwrap();
        assert_eq!(shell.command, "user");
        assert_eq!(shell.source, "user");
        assert!(
            devices
                .iter()
                .any(|d| d.id != "shell" && d.source == "builtin")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn user_folder_skips_other_and_malformed_files() {
        let dir =
            std::env::temp_dir().join(format!("patchbay-device-skips-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
        write("notes.json", r#"{"id":"notes","name":"Not a device"}"#);
        write("broken.device.json", "{");
        write("nameless.device.json", r#"{"id":"nameless"}"#);
        write("deploy.device.json", r#"{"id":"deploy","name":"Deploy"}"#);
        let registry = crate::extensions::Registry::default();
        let devices = super::load_from(&registry, Some(&dir));
        let user: Vec<_> = devices.iter().filter(|d| d.source == "user").collect();
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].id, "deploy");
        // Unset fields take their defaults.
        assert_eq!(user[0].category, "Custom");
        assert!(user[0].command.is_empty() && user[0].ready_when.is_empty());
        assert_eq!(
            devices.iter().filter(|d| d.source == "builtin").count(),
            super::BUILTIN.len()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn builtins_parse() {
        for s in super::BUILTIN {
            serde_json::from_str::<super::DeviceManifest>(s).expect(s);
        }
    }
}
