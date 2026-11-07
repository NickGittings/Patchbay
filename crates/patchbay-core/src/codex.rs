//! Per-invocation command networking. No user configuration is written.
use anyhow::{Context, Result, anyhow, ensure};
use std::path::{Path, PathBuf};
use toml::{Table, Value};

#[derive(Default)]
struct Denies {
    features: Table,
    profiles: std::collections::BTreeMap<String, Table>,
}

/// Read local configuration conservatively, including project layers even when
/// Codex might ignore an untrusted layer. Keeping an extra deny is preferable to
/// accidentally replacing it with Patchbay's loopback allowance. Managed policy
/// remains Codex's responsibility and cannot be overridden by these options.
pub(crate) fn launch_options(command: &str, cwd: &Path) -> Result<Vec<String>> {
    let words = crate::context::launch_words(command).context("Unsupported Codex command")?;
    let (program, _) = crate::context::launch_program(command).context("Missing Codex program")?;
    let args = &words[program + 1..];
    ensure!(
        !args.iter().any(|arg| matches!(
            arg.as_str(),
            "--dangerously-bypass-approvals-and-sandbox" | "--yolo"
        )),
        "Codex sandbox bypass cannot enforce scoped command networking"
    );
    ensure!(
        !words[..program]
            .iter()
            .any(|word| matches!(word.as_str(), "-u" | "-i" | "--ignore-environment")),
        "Cannot resolve Codex configuration with an environment-clearing command prefix safely"
    );
    ensure!(
        !args
            .iter()
            .any(|arg| arg == "--remote" || arg.starts_with("--remote=")),
        "Scoped networking must be configured on the remote Codex server"
    );
    ensure!(
        !args
            .windows(2)
            .any(|pair| matches!(pair[0].as_str(), "--enable" | "--disable")
                && pair[1] == "network_proxy"),
        "Use a network_proxy configuration table instead of a feature toggle to preserve destination rules"
    );
    let mut config = Table::new();
    let mut denies = Denies::default();
    if !cfg!(test) {
        let mut home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|p| p.join(".codex")));
        for word in &words[..program] {
            if let Some(value) = word.strip_prefix("CODEX_HOME=") {
                ensure!(
                    !value.contains(['$', '%', '~']),
                    "Cannot resolve dynamic CODEX_HOME safely"
                );
                home = Some(PathBuf::from(value));
            }
        }
        read(
            &PathBuf::from("/etc/codex/config.toml"),
            &mut config,
            &mut denies,
        )?;
        if let Some(home) = &home {
            read(&home.join("config.toml"), &mut config, &mut denies)?;
        }
        let mut cwd = cwd.to_path_buf();
        if let Some(path) = option(args, "-C", "--cd") {
            ensure!(
                !path.contains(['$', '%', '~']),
                "Cannot resolve dynamic Codex working directory safely"
            );
            cwd = cwd.join(path);
        }
        let ancestors = cwd.ancestors().collect::<Vec<_>>();
        for path in ancestors.into_iter().rev() {
            read(&path.join(".codex/config.toml"), &mut config, &mut denies)?;
        }
        if let Some(profile) = option(args, "-p", "--profile").or_else(|| {
            config
                .get("profile")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }) {
            ensure!(
                !profile.contains(['/', '\\', '$', '%']),
                "Cannot resolve Codex profile safely"
            );
            if let Some(legacy) = config
                .get("profiles")
                .and_then(|v| v.get(&profile))
                .and_then(Value::as_table)
                .cloned()
            {
                collect_denies(&legacy, &mut denies);
                merge(&mut config, legacy);
            }
            if let Some(home) = &home {
                read(
                    &home.join(format!("{profile}.config.toml")),
                    &mut config,
                    &mut denies,
                )?;
            }
        }
    }
    for raw in overrides(args) {
        let (key, raw) = raw
            .split_once('=')
            .context("Invalid Codex configuration override")?;
        if [
            "features",
            "permissions",
            "default_permissions",
            "sandbox_mode",
            "sandbox_workspace_write",
        ]
        .iter()
        .any(|prefix| key.trim().starts_with(prefix))
        {
            ensure!(
                !raw.contains(['$', '%']),
                "Cannot resolve dynamic Codex network configuration safely"
            );
        }
        let value = toml::from_str::<Table>(&format!("v={raw}"))
            .ok()
            .and_then(|mut table| table.remove("v"))
            .unwrap_or_else(|| Value::String(raw.into()));
        let layer: Table = toml::from_str(&format!("{key}={}", inline(&value)))
            .map_err(|_| anyhow!("Cannot resolve Codex configuration override safely"))?;
        collect_denies(&layer, &mut denies);
        merge(&mut config, layer);
    }
    if let Some(mode) = option(args, "-s", "--sandbox") {
        config.insert("sandbox_mode".into(), Value::String(mode));
    }
    network_options(&config, denies)
}

fn option(args: &[String], short: &str, long: &str) -> Option<String> {
    let mut found = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == short || arg == long {
            found = args.next().cloned();
        } else if let Some(value) = arg.strip_prefix(&format!("{long}=")) {
            found = Some(value.into());
        } else if let Some(value) = arg.strip_prefix(short).filter(|value| !value.is_empty()) {
            found = Some(value.into());
        }
    }
    found
}

fn overrides(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "-c" | "--config") {
            if let Some(value) = args.next() {
                out.push(value.clone());
            }
        } else if let Some(value) = arg.strip_prefix("--config=") {
            out.push(value.into());
        } else if let Some(value) = arg.strip_prefix("-c").filter(|value| !value.is_empty()) {
            out.push(value.into());
        }
    }
    out
}

fn read(path: &Path, config: &mut Table, denies: &mut Denies) -> Result<()> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let layer = toml::from_str::<Table>(&text)
                .map_err(|_| anyhow!("Cannot parse Codex network policy in {}", path.display()))?;
            collect_denies(&layer, denies);
            merge(config, layer);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("Cannot read Codex network policy in {}", path.display())),
    }
}

fn merge(target: &mut Table, layer: Table) {
    for (key, value) in layer {
        if let (Some(Value::Table(target)), Value::Table(source)) = (target.get_mut(&key), &value) {
            merge(target, source.clone());
        } else {
            target.insert(key, value);
        }
    }
}

fn collect_denies(config: &Table, denies: &mut Denies) {
    if let Some(domains) = config
        .get("features")
        .and_then(|v| v.get("network_proxy"))
        .and_then(|v| v.get("domains"))
        .and_then(Value::as_table)
    {
        for (host, rule) in domains {
            if rule.as_str() == Some("deny") {
                denies.features.insert(host.clone(), rule.clone());
            }
        }
    }
    if let Some(profiles) = config.get("permissions").and_then(Value::as_table) {
        for (name, profile) in profiles {
            if let Some(domains) = profile
                .get("network")
                .and_then(|v| v.get("domains"))
                .and_then(Value::as_table)
            {
                for (host, rule) in domains {
                    if rule.as_str() == Some("deny") {
                        denies
                            .profiles
                            .entry(name.clone())
                            .or_default()
                            .insert(host.clone(), rule.clone());
                    }
                }
            }
        }
    }
}

fn profile_network(
    config: &Table,
    name: &str,
    selected: &mut std::collections::HashSet<String>,
) -> Result<Table> {
    if name.starts_with(':') {
        return Ok(Table::new());
    }
    ensure!(
        selected.insert(name.into()),
        "Cyclic Codex permission profiles"
    );
    let profile = config
        .get("permissions")
        .and_then(|v| v.get(name))
        .context("Missing Codex permission profile")?;
    let mut network = if let Some(parent) = profile.get("extends").and_then(Value::as_str) {
        profile_network(config, parent, selected)?
    } else {
        Table::new()
    };
    if let Some(current) = profile.get("network") {
        merge(
            &mut network,
            current
                .as_table()
                .context("Invalid Codex profile network configuration")?
                .clone(),
        );
    }
    Ok(network)
}

fn network_options(config: &Table, mut denies: Denies) -> Result<Vec<String>> {
    if let Some(value) = config.get("features").and_then(|v| v.get("network_proxy")) {
        ensure!(
            value.is_bool() || value.is_table(),
            "Invalid Codex network proxy configuration"
        );
    }
    let mut proxy = config
        .get("features")
        .and_then(|v| v.get("network_proxy"))
        .and_then(Value::as_table)
        .cloned()
        .unwrap_or_default();
    proxy.insert("enabled".into(), Value::Boolean(true));
    proxy.insert("enable_socks5".into(), Value::Boolean(true));
    proxy.insert("allow_local_binding".into(), Value::Boolean(false));
    let domains = proxy
        .entry("domains")
        .or_insert_with(|| Value::Table(Table::new()))
        .as_table_mut()
        .context("Invalid Codex network domains")?;
    // Codex's feature-level map can replace the profile's destination map.
    // Carry the selected inheritance chain into it, with deny winning on every
    // conflict, so adding loopback cannot erase a profile's existing policy.
    if let Some(name) = config.get("default_permissions").and_then(Value::as_str) {
        let mut selected = std::collections::HashSet::new();
        let network = profile_network(config, name, &mut selected)?;
        if let Some(inherited) = network.get("domains").and_then(Value::as_table) {
            for (host, rule) in inherited {
                if domains.get(host).and_then(Value::as_str) != Some("deny") {
                    domains.insert(host.clone(), rule.clone());
                }
            }
        }
        for name in selected {
            if let Some(profile_denies) = denies.profiles.remove(&name) {
                denies.features.extend(profile_denies);
            }
        }
    }
    domains
        .entry("127.0.0.1")
        .or_insert_with(|| Value::String("allow".into()));
    domains.extend(denies.features);
    let mut out = vec![format!(
        "features.network_proxy={}",
        inline(&Value::Table(proxy))
    )];
    match config.get("default_permissions").and_then(Value::as_str) {
        Some(name) if name.starts_with(':') => {
            // A derived profile changes networking only; its filesystem is inherited.
            ensure!(
                matches!(name, ":workspace" | ":read-only"),
                "Codex full-access permissions cannot enforce scoped command networking"
            );
            ensure!(
                config
                    .get("permissions")
                    .and_then(|v| v.get("patchbay_loopback"))
                    .is_none(),
                "Codex permission profile patchbay_loopback already exists"
            );
            out.push(format!(
                "permissions.patchbay_loopback.extends={}",
                inline(&Value::String(name.into()))
            ));
            out.push("permissions.patchbay_loopback.network={enabled=true,enable_socks5=true,allow_local_binding=false}".into());
            out.push("default_permissions=\"patchbay_loopback\"".into());
        }
        Some(name) => {
            ensure!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "Cannot safely override this Codex permission profile name"
            );
            let network = config
                .get("permissions")
                .and_then(|v| v.get(name))
                .and_then(|v| v.get("network"));
            ensure!(
                network.is_none_or(Value::is_table),
                "Invalid Codex permission profile network configuration"
            );
            let mut network = network
                .and_then(Value::as_table)
                .cloned()
                .unwrap_or_default();
            network.insert("enabled".into(), Value::Boolean(true));
            network.insert("enable_socks5".into(), Value::Boolean(true));
            network.insert("allow_local_binding".into(), Value::Boolean(false));
            // Override networking only. Never copy or replace filesystem rules.
            ensure!(
                config
                    .get("permissions")
                    .and_then(|v| v.get(name))
                    .is_some(),
                "Missing Codex permission profile"
            );
            out.push(format!(
                "permissions.{name}.network={}",
                inline(&Value::Table(network))
            ));
        }
        None => {
            ensure!(
                config
                    .get("sandbox_mode")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace-write")
                    == "workspace-write",
                "Scoped Codex networking requires workspace-write or a named permission profile; filesystem sandbox was preserved"
            );
            out.push("sandbox_workspace_write.network_access=true".into());
        }
    }
    Ok(out)
}

// TOML inline tables preserve quoted IP keys through Codex's -c parser.
fn inline(value: &Value) -> String {
    match value {
        Value::Table(table) => format!(
            "{{{}}}",
            table
                .iter()
                .map(|(key, value)| format!(
                    "{}={}",
                    crate::context::toml_inert(key),
                    inline(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(inline).collect::<Vec<_>>().join(",")
        ),
        Value::String(value) => crate::context::toml_inert(value),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(config: &str) -> Table {
        let mut config: Table = toml::from_str(config).unwrap();
        let mut denies = Denies::default();
        collect_denies(&config, &mut denies);
        for option in network_options(&config, denies).unwrap() {
            merge(&mut config, toml::from_str(&option).unwrap());
        }
        config
    }

    #[test]
    fn legacy_networking_keeps_filesystem_approvals_and_destination_rules() {
        let original: Table = toml::from_str(
            r#"
sandbox_mode = "workspace-write"
approval_policy = "on-request"
approvals_reviewer = "auto_review"
[sandbox_workspace_write]
writable_roots = ["/one"]
exclude_slash_tmp = true
[features.network_proxy.domains]
"example.com" = "allow"
"blocked.example" = "deny"
"127.0.0.1" = "deny"
"*" = "deny"
"#,
        )
        .unwrap();
        let updated = apply(&toml::to_string(&original).unwrap());
        for key in ["sandbox_mode", "approval_policy", "approvals_reviewer"] {
            assert_eq!(original[key], updated[key]);
        }
        let workspace = updated["sandbox_workspace_write"].as_table().unwrap();
        assert_eq!(
            workspace["writable_roots"],
            original["sandbox_workspace_write"]["writable_roots"]
        );
        assert_eq!(workspace["exclude_slash_tmp"], Value::Boolean(true));
        assert_eq!(workspace["network_access"], Value::Boolean(true));
        let proxy = &updated["features"]["network_proxy"];
        assert_eq!(
            proxy["domains"],
            original["features"]["network_proxy"]["domains"]
        );
        assert_eq!(proxy["enabled"], Value::Boolean(true));
        assert_eq!(proxy["enable_socks5"], Value::Boolean(true));
        assert_eq!(proxy["allow_local_binding"], Value::Boolean(false));
    }

    #[test]
    fn named_profiles_keep_inheritance_and_filesystem_denies() {
        let original = r#"
default_permissions = "locked"
approval_policy = "never"
[permissions.parent]
extends = ":workspace"
[permissions.parent.network.domains]
"blocked.example" = "deny"
[permissions.locked]
extends = "parent"
[permissions.locked.filesystem]
"/secrets" = "deny"
[permissions.locked.network.domains]
"127.0.0.1" = "deny"
"example.com" = "allow"
[permissions.unselected.network.domains]
"*" = "deny"
"#;
        let updated = apply(original);
        let original: Table = toml::from_str(original).unwrap();
        assert_eq!(
            original["permissions"]["parent"],
            updated["permissions"]["parent"]
        );
        assert_eq!(
            original["permissions"]["locked"]["filesystem"],
            updated["permissions"]["locked"]["filesystem"]
        );
        assert_eq!(
            original["permissions"]["locked"]["extends"],
            updated["permissions"]["locked"]["extends"]
        );
        assert_eq!(
            original["permissions"]["locked"]["network"]["domains"],
            updated["permissions"]["locked"]["network"]["domains"]
        );
        assert_eq!(
            updated["permissions"]["locked"]["network"]["allow_local_binding"],
            Value::Boolean(false)
        );
        assert_eq!(
            updated["default_permissions"],
            original["default_permissions"]
        );
        assert_eq!(updated["approval_policy"], original["approval_policy"]);
        let domains = updated["features"]["network_proxy"]["domains"]
            .as_table()
            .unwrap();
        assert_eq!(domains["127.0.0.1"].as_str(), Some("deny"));
        assert_eq!(domains["blocked.example"].as_str(), Some("deny"));
        assert_eq!(domains["example.com"].as_str(), Some("allow"));
        assert!(!domains.contains_key("*"));
    }

    #[test]
    fn builtin_profiles_inherit_their_filesystem_without_legacy_settings() {
        for name in [":workspace", ":read-only"] {
            let updated = apply(&format!("default_permissions={name:?}"));
            assert_eq!(
                updated["permissions"]["patchbay_loopback"]["extends"].as_str(),
                Some(name)
            );
            assert!(!updated.contains_key("sandbox_workspace_write"));
            assert!(
                !updated["permissions"]["patchbay_loopback"]
                    .as_table()
                    .unwrap()
                    .contains_key("filesystem")
            );
        }
    }

    #[test]
    fn settings_add_only_loopback_and_preserve_deny_from_an_earlier_layer() {
        let mut config = Table::new();
        let mut denies = Denies::default();
        let path =
            std::env::temp_dir().join(format!("patchbay-codex-{}.toml", uuid::Uuid::new_v4()));
        std::fs::write(&path, "[features.network_proxy.domains]\n\"127.0.0.1\"=\"deny\"\n\"blocked.example\"=\"deny\"\n").unwrap();
        read(&path, &mut config, &mut denies).unwrap();
        std::fs::remove_file(path).unwrap();
        merge(
            &mut config,
            toml::from_str("[features]\nnetwork_proxy=false").unwrap(),
        );
        let options = network_options(&config, denies).unwrap();
        let proxy: Table = toml::from_str(&options[0]).unwrap();
        assert_eq!(
            proxy["features"]["network_proxy"]["domains"]["127.0.0.1"].as_str(),
            Some("deny")
        );
        assert_eq!(
            proxy["features"]["network_proxy"]["domains"]["blocked.example"].as_str(),
            Some("deny")
        );
        let updated = apply("");
        let domains = updated["features"]["network_proxy"]["domains"]
            .as_table()
            .unwrap();
        assert_eq!(domains.len(), 1);
        assert_eq!(domains["127.0.0.1"].as_str(), Some("allow"));
    }

    #[test]
    fn cli_overrides_support_raw_values_and_compact_config_options() {
        for command in [
            "codex -p fast -m model -c model_reasoning_effort=high",
            "codex --profile=fast --config=model_reasoning_effort=high",
            "codex -cmodel_reasoning_effort=high",
        ] {
            assert!(
                launch_options(command, Path::new("/repo")).is_ok(),
                "{command}"
            );
        }
        assert!(launch_options("codex --sandbox read-only", Path::new("/repo")).is_err());
        assert!(launch_options("codex --disable network_proxy", Path::new("/repo")).is_err());
    }
}
