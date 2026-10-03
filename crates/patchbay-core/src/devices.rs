//! Devices are terminal presets you can add to any component. Built-ins use the
//! same manifest format as user-defined devices in `~/.patchbay/devices/`.

use crate::model::TerminalKind;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceManifest {
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
    /// "builtin" or "user"; filled in on load.
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

#[must_use]
pub fn user_devices_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".patchbay").join("devices"))
}

/// Built-in devices plus everything in `~/.patchbay/devices/*.device.json`.
/// User devices with the same id override built-ins.
#[must_use]
pub fn load_devices() -> Vec<DeviceManifest> {
    let mut devices: Vec<DeviceManifest> = BUILTIN
        .iter()
        .filter_map(|s| serde_json::from_str::<DeviceManifest>(s).ok())
        .map(|mut d| {
            d.source = "builtin".into();
            d
        })
        .collect();

    if let Some(dir) = user_devices_dir()
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
    fn builtins_parse() {
        for s in super::BUILTIN {
            serde_json::from_str::<super::DeviceManifest>(s).expect(s);
        }
    }
}
