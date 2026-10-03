use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 2;
/// Saved at the repo root so the map can be committed alongside the code.
pub const PROJECT_FILE: &str = "patchbay.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub name: String,
    /// Absolute repo root. Not written to disk so the file stays portable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub root: String,
    #[serde(default)]
    pub components: Vec<Component>,
    #[serde(default)]
    pub links: Vec<Link>,
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    Frontend,
    Backend,
    Service,
    Library,
    Database,
    App,
    #[default]
    Other,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: ComponentKind,
    /// Folder relative to the project root; "." is the root itself.
    pub path: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub terminals: Vec<TerminalSpec>,
    #[serde(default)]
    pub position: Position,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    /// Interactive login shell.
    #[default]
    Shell,
    /// A command such as a dev server or test run.
    Task,
    /// An AI agent CLI; launched with the component's context.
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpec {
    pub id: String,
    pub name: String,
    /// Empty for an interactive shell.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub kind: TerminalKind,
}

/// `source` depends on `target`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    DependsOn,
    UsedBy,
}

impl Project {
    pub fn component(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }

    pub fn component_dir(&self, component: &Component) -> PathBuf {
        Path::new(&self.root).join(&component.path)
    }

    /// Components linked to `id`, with the direction of the relationship.
    pub fn neighbours(&self, id: &str) -> Vec<(&Component, Relation)> {
        self.links
            .iter()
            .filter_map(|l| {
                if l.source == id {
                    self.component(&l.target).map(|c| (c, Relation::DependsOn))
                } else if l.target == id {
                    self.component(&l.source).map(|c| (c, Relation::UsedBy))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Load `patchbay.json` from `root`, if present.
    pub fn load(root: &Path) -> Result<Option<Self>> {
        let file = root.join(PROJECT_FILE);
        if !file.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&file)?;
        let mut project: Self =
            serde_json::from_str(&text).with_context(|| format!("parsing {}", file.display()))?;
        project.root = root.display().to_string();
        Ok(Some(project))
    }

    pub fn save(&self) -> Result<PathBuf> {
        let file = Path::new(&self.root).join(PROJECT_FILE);
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        std::fs::write(&file, text)?;
        Ok(file)
    }
}

/// Session ids identify one terminal of one component.
pub fn session_id(component_id: &str, terminal_id: &str) -> String {
    format!("{component_id}/{terminal_id}")
}
