use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// Count uncommitted changes per component folder. Each changed file is
/// attributed to the most specific component containing it.
/// Returns an empty map when `root` is not a git repository.
#[must_use]
pub fn changes_by_component(
    root: &Path,
    components: &[(String, String)],
) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> =
        components.iter().map(|(id, _)| (id.clone(), 0)).collect();
    let Ok(output) = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .output()
    else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }

    let prefixes: Vec<(&str, String)> = components
        .iter()
        .map(|(id, path)| {
            let p = path.trim_start_matches("./").trim_end_matches('/');
            let prefix = if p.is_empty() || p == "." {
                String::new()
            } else {
                format!("{p}/")
            };
            (id.as_str(), prefix)
        })
        .collect();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        // "XY path" or "XY old -> new"
        let Some(path) = line.get(3..) else { continue };
        let path = path.rsplit(" -> ").next().unwrap_or(path).trim_matches('"');
        let owner = prefixes
            .iter()
            .filter(|(_, prefix)| path.starts_with(prefix.as_str()))
            .max_by_key(|(_, prefix)| prefix.len());
        if let Some((id, _)) = owner {
            *counts.entry((*id).to_string()).or_default() += 1;
        }
    }
    counts
}
