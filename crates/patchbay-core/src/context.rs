//! Turns a component's terminal into a launchable session, giving agent
//! terminals the component's neighbours as context.

use crate::model::{Project, Relation, TerminalKind, session_id};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Result, anyhow};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::PathBuf;

pub const CONTEXT_ENV: &str = "PATCHBAY_CONTEXT_FILE";
pub const COMPONENT_ENV: &str = "PATCHBAY_COMPONENT";

/// Markdown briefing for an agent working on one component.
#[must_use]
pub fn component_context(project: &Project, component_id: &str) -> String {
    let Some(c) = project.component(component_id) else {
        return String::new();
    };
    let mut out = String::new();
    let _ = writeln!(
        out,
        "# Patchbay context\n\nYou are working on the **{}** component ({:?}) of the \
         **{}** project, located at `{}`.",
        c.name,
        c.kind,
        project.name,
        project.component_dir(c).display()
    );
    if !c.notes.trim().is_empty() {
        let _ = writeln!(out, "\n## About this component\n\n{}", c.notes.trim());
    }
    let neighbours = project.neighbours(component_id);
    if !neighbours.is_empty() {
        let _ = writeln!(out, "\n## Related components\n");
        for (n, rel) in neighbours {
            let verb = match rel {
                Relation::DependsOn => "This component depends on",
                Relation::UsedBy => "This component is used by",
            };
            let _ = write!(
                out,
                "- {verb} **{}** ({:?}) at `{}`",
                n.name,
                n.kind,
                project.component_dir(n).display()
            );
            if !n.notes.trim().is_empty() {
                let _ = write!(out, " — {}", n.notes.trim().replace('\n', " "));
            }
            out.push('\n');
        }
    }
    out.push_str(
        "\nStay focused on this component. Read related components for context, but only \
         change them when asked.\n",
    );
    out
}

/// Single-quote a string for POSIX shells.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn context_file(project: &Project, component_id: &str) -> Result<PathBuf> {
    let slug: String = format!("{}-{component_id}", project.name)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = std::env::temp_dir().join("patchbay");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{slug}.md"));
    std::fs::write(&file, component_context(project, component_id))?;
    Ok(file)
}

/// Build the session for one of a component's terminals.
///
/// Agent terminals get `PATCHBAY_CONTEXT_FILE`; `claude` additionally gets the
/// context appended to its system prompt and neighbour folders via `--add-dir`.
///
/// # Errors
/// Fails if the component or terminal does not exist, or the policy rejects it.
pub fn session_spec(
    project: &Project,
    component_id: &str,
    terminal_id: &str,
    policy: &dyn Policy,
) -> Result<SessionSpec> {
    let component = project
        .component(component_id)
        .ok_or_else(|| anyhow!("unknown component {component_id}"))?;
    let terminal = component
        .terminals
        .iter()
        .find(|t| t.id == terminal_id)
        .ok_or_else(|| anyhow!("unknown terminal {terminal_id}"))?;

    let mut env = BTreeMap::from([(COMPONENT_ENV.to_string(), component.name.clone())]);
    let mut command = terminal.command.trim().to_string();

    if terminal.kind == TerminalKind::Agent {
        let file = context_file(project, component_id)?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        let is_claude = command == "claude" || command.starts_with("claude ");
        if is_claude && cfg!(unix) {
            for (n, _) in project.neighbours(component_id) {
                let dir = project.component_dir(n).display().to_string();
                let _ = write!(command, " --add-dir {}", sh_quote(&dir));
            }
            let _ = write!(
                command,
                " --append-system-prompt \"$(cat {})\"",
                sh_quote(&file.display().to_string())
            );
        }
    }

    policy
        .check(component, &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;

    Ok(SessionSpec {
        id: session_id(component_id, terminal_id),
        command,
        cwd: project.component_dir(component),
        env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Component, ComponentKind, Link, TerminalSpec};
    use crate::policy::AllowAll;

    fn component(id: &str, path: &str, terminals: Vec<TerminalSpec>) -> Component {
        Component {
            id: id.into(),
            name: id.to_uppercase(),
            kind: ComponentKind::Backend,
            path: path.into(),
            notes: format!("{id} notes"),
            terminals,
            position: Default::default(),
        }
    }

    fn project() -> Project {
        Project {
            schema_version: 2,
            name: "demo".into(),
            root: "/repo".into(),
            components: vec![
                component(
                    "api",
                    "services/api",
                    vec![TerminalSpec {
                        id: "agent".into(),
                        name: "Claude".into(),
                        command: "claude".into(),
                        kind: TerminalKind::Agent,
                    }],
                ),
                component("db", "db", vec![]),
            ],
            links: vec![Link {
                id: "l1".into(),
                source: "api".into(),
                target: "db".into(),
                label: None,
            }],
        }
    }

    #[test]
    fn context_lists_neighbours() {
        let text = component_context(&project(), "api");
        assert!(text.contains("**API**"));
        assert!(text.contains("depends on **DB**"));
        assert!(text.contains("db notes"));
    }

    #[cfg(unix)]
    #[test]
    fn claude_gets_neighbour_dirs_and_context() {
        let spec = session_spec(&project(), "api", "agent", &AllowAll).unwrap();
        assert_eq!(spec.id, "api/agent");
        assert_eq!(spec.cwd, PathBuf::from("/repo/services/api"));
        assert!(spec.command.starts_with("claude --add-dir '/repo/db'"));
        assert!(spec.command.contains("--append-system-prompt"));
        assert!(spec.env.contains_key(CONTEXT_ENV));
    }

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }
}
