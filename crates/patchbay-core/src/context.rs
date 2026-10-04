//! Turns a component's terminal into a launchable session, giving agent
//! terminals the component's neighbours as context.

use crate::model::{
    Component, PLAN_SCOPE, Project, Relation, TerminalKind, TerminalSpec, session_id,
};
use crate::policy::{Policy, Scope};
use crate::pty::SessionSpec;
use anyhow::{Result, anyhow};
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSection {
    pub title: String,
    pub body: String,
}
fn append_sections(out: &mut String, sections: &[ContextSection]) {
    for section in sections {
        let _ = writeln!(
            out,
            "\n## {}\n\n{}",
            section.title.replace(['\n', '\r'], " "),
            section.body
        );
    }
}

pub const CONTEXT_ENV: &str = "PATCHBAY_CONTEXT_FILE";
pub const COMPONENT_ENV: &str = "PATCHBAY_COMPONENT";

/// Markdown briefing for an agent working on one component.
#[must_use]
pub fn component_context(
    project: &Project,
    component_id: &str,
    sections: &[ContextSection],
) -> String {
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
    append_sections(&mut out, sections);
    out
}

/// Single-quote a string for POSIX shells.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Markdown briefing for planning across a highlighted set, or the whole project.
#[must_use]
pub fn plan_context(
    project: &Project,
    component_ids: &[String],
    sections: &[ContextSection],
) -> String {
    let components = plan_components(project, component_ids);
    let ids: HashSet<&str> = components.iter().map(|c| c.id.as_str()).collect();
    let mut out = format!(
        "# Patchbay planner context\n\nProject: **{}**\nRoot: `{}`\n\n## In scope\n\n",
        project.name, project.root
    );
    for c in &components {
        describe_component(&mut out, project, c);
    }
    let mut links = String::new();
    for link in &project.links {
        if ids.contains(link.source.as_str())
            && ids.contains(link.target.as_str())
            && let (Some(source), Some(target)) = (
                project.component(&link.source),
                project.component(&link.target),
            )
        {
            let _ = write!(
                links,
                "- **{}** depends on **{}**",
                source.name, target.name
            );
            if let Some(label) = &link.label {
                let _ = write!(links, " — {label}");
            }
            links.push('\n');
        }
    }
    if !links.is_empty() {
        let _ = write!(out, "\n## Links between them\n\n{links}");
    }

    let mut nearby = String::new();
    let mut seen = ids;
    for c in components {
        for (neighbour, _) in project.neighbours(&c.id) {
            if seen.insert(neighbour.id.as_str()) {
                describe_component(&mut nearby, project, neighbour);
            }
        }
    }
    if !nearby.is_empty() {
        let _ = write!(out, "\n## Nearby components\n\n{nearby}");
    }
    out.push_str(
        "\nYou are planning, not implementing: explore, ask questions and produce a plan; \
         don't edit files unless asked.\n",
    );
    append_sections(&mut out, sections);
    out
}

fn plan_components<'a>(project: &'a Project, component_ids: &[String]) -> Vec<&'a Component> {
    project
        .components
        .iter()
        .filter(|c| component_ids.is_empty() || component_ids.contains(&c.id))
        .collect()
}

fn describe_component(out: &mut String, project: &Project, c: &Component) {
    let _ = write!(
        out,
        "- **{}** ({:?}) at `{}`",
        c.name,
        c.kind,
        project.component_dir(c).display()
    );
    if !c.notes.trim().is_empty() {
        let _ = write!(out, " — {}", c.notes.trim().replace('\n', " "));
    }
    out.push('\n');
}

fn context_file(slug: &str, contents: &str) -> Result<PathBuf> {
    let slug: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '@' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let dir = std::env::temp_dir().join("patchbay");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{slug}.md"));
    // Write then rename, so a reader (e.g. `cat` in a starting agent) never
    // sees a half-written file while another launch rewrites it.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{slug}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, contents)?;
    if let Err(e) = std::fs::rename(&tmp, &file) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(file)
}

fn decorate_agent(command: &mut String, file: &Path, neighbour_dirs: &[PathBuf]) {
    let is_claude = command == "claude" || command.starts_with("claude ");
    if is_claude && cfg!(unix) {
        for dir in neighbour_dirs {
            let _ = write!(
                command,
                " --add-dir {}",
                sh_quote(&dir.display().to_string())
            );
        }
        let _ = write!(
            command,
            " --append-system-prompt \"$(cat {})\"",
            sh_quote(&file.display().to_string())
        );
    }
}

/// Build a planner terminal session at the project root.
///
/// An empty scope plans over all components. Agent commands receive the context file.
///
/// # Errors
/// Fails for unknown component ids, context file I/O, or a rejected policy check.
pub fn plan_session_spec(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    policy: &dyn Policy,
    sections: &[ContextSection],
) -> Result<SessionSpec> {
    for id in component_ids {
        if project.component(id).is_none() {
            return Err(anyhow!("unknown component {id}"));
        }
    }
    let components = plan_components(project, component_ids);
    let mut env = BTreeMap::from([(COMPONENT_ENV.to_string(), "plan".into())]);
    let mut command = terminal.command.trim().to_string();
    if terminal.kind == TerminalKind::Agent {
        let file = context_file(
            &format!("{}-{PLAN_SCOPE}-{}", project.name, terminal.id),
            &plan_context(project, component_ids, sections),
        )?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        // cwd is the root; components in other repos must be added explicitly.
        let mut dirs: Vec<PathBuf> = Vec::new();
        for c in &components {
            let reach =
                std::iter::once(*c).chain(project.neighbours(&c.id).into_iter().map(|(n, _)| n));
            for n in reach {
                let dir = project.component_dir(n);
                if !dir.starts_with(&project.root) && !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
        decorate_agent(&mut command, &file, &dirs);
    }
    policy
        .check(Scope::Plan(&components), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;
    Ok(SessionSpec {
        id: session_id(PLAN_SCOPE, &terminal.id),
        command,
        cwd: PathBuf::from(&project.root),
        env,
    })
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
    sections: &[ContextSection],
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
        let file = context_file(
            &format!("{}-{component_id}", project.name),
            &component_context(project, component_id, sections),
        )?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        let dirs: Vec<_> = project
            .neighbours(component_id)
            .iter()
            .map(|(n, _)| project.component_dir(n))
            .collect();
        decorate_agent(&mut command, &file, &dirs);
    }

    policy
        .check(Scope::Component(component), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;

    Ok(SessionSpec {
        id: session_id(component_id, terminal_id),
        command,
        cwd: project.component_dir(component),
        env,
    })
}

/// Build the session for a terminal that isn't on the map (an extension command
/// or `terminals.run`), as if `component_id` had it. The map itself is not saved.
///
/// # Errors
/// Fails if the component does not exist, or the policy rejects it.
pub fn extra_session_spec(
    mut project: Project,
    component_id: &str,
    terminal: TerminalSpec,
    policy: &dyn Policy,
    sections: &[ContextSection],
) -> Result<SessionSpec> {
    let component = project
        .components
        .iter_mut()
        .find(|c| c.id == component_id)
        .ok_or_else(|| anyhow!("unknown component {component_id}"))?;
    let terminal_id = terminal.id.clone();
    component.terminals.retain(|t| t.id != terminal_id);
    component.terminals.push(terminal);
    session_spec(&project, component_id, &terminal_id, policy, sections)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Component, ComponentKind, Link, TerminalSpec};
    use crate::policy::AllowAll;

    #[test]
    fn extra_terminals_launch_in_the_component_and_replace_same_ids() {
        let terminal = TerminalSpec {
            id: "agent".into(),
            name: "Ad hoc".into(),
            command: "echo hi".into(),
            kind: TerminalKind::Task,
        };
        let spec = extra_session_spec(project(), "api", terminal, &AllowAll, &[]).unwrap();
        assert_eq!(spec.id, "api/agent");
        assert_eq!(spec.command, "echo hi");
        assert_eq!(spec.cwd, PathBuf::from("/repo/services/api"));
        assert!(!spec.env.contains_key(CONTEXT_ENV));
        let missing = TerminalSpec {
            id: "x".into(),
            name: "X".into(),
            command: "true".into(),
            kind: TerminalKind::Task,
        };
        assert!(extra_session_spec(project(), "nope", missing, &AllowAll, &[]).is_err());
    }

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
    fn contributed_sections_reach_component_planner_and_agent_session() {
        let sections = vec![ContextSection {
            title: "Services".into(),
            body: "api: port 8080".into(),
        }];
        assert!(
            component_context(&project(), "api", &sections)
                .contains("## Services\n\napi: port 8080")
        );
        assert!(plan_context(&project(), &[], &sections).contains("## Services\n\napi: port 8080"));
        let mut p = project();
        p.name = "extension-context-demo".into();
        let spec = session_spec(&p, "api", "agent", &AllowAll, &sections).unwrap();
        assert!(
            std::fs::read_to_string(&spec.env[CONTEXT_ENV])
                .unwrap()
                .contains("api: port 8080")
        );
    }

    #[test]
    fn context_lists_neighbours() {
        let text = component_context(&project(), "api", &[]);
        assert!(text.contains("**API**"));
        assert!(text.contains("depends on **DB**"));
        assert!(text.contains("db notes"));
    }

    #[cfg(unix)]
    #[test]
    fn claude_gets_neighbour_dirs_and_context() {
        let spec = session_spec(&project(), "api", "agent", &AllowAll, &[]).unwrap();
        assert_eq!(spec.id, "api/agent");
        assert_eq!(spec.cwd, PathBuf::from("/repo/services/api"));
        assert!(spec.command.starts_with("claude --add-dir '/repo/db'"));
        assert!(spec.command.contains("--append-system-prompt"));
        assert!(spec.env.contains_key(CONTEXT_ENV));
    }

    fn planner() -> TerminalSpec {
        TerminalSpec {
            id: "claude".into(),
            name: "Claude".into(),
            command: "claude".into(),
            kind: TerminalKind::Agent,
        }
    }

    #[test]
    fn plan_lists_scope_links_and_deduplicated_neighbours() {
        let mut p = project();
        p.components.push(component("web", "web", vec![]));
        p.components
            .push(component("unrelated", "elsewhere", vec![]));
        p.links[0].label = Some("queries".into());
        p.links.push(Link {
            id: "l2".into(),
            source: "web".into(),
            target: "api".into(),
            label: Some("calls".into()),
        });
        p.links.push(Link {
            id: "l3".into(),
            source: "web".into(),
            target: "db".into(),
            label: None,
        });
        let text = plan_context(&p, &["web".into(), "api".into(), "api".into()], &[]);
        let (scope, nearby) = text.split_once("## Nearby components").unwrap();
        assert!(scope.contains("**API** (Backend) at `/repo/services/api` — api notes"));
        assert!(scope.contains("**WEB** depends on **API** — calls"));
        assert!(!scope.contains("**DB**"));
        assert!(!text.contains("UNRELATED"));
        assert_eq!(nearby.matches("**DB**").count(), 1);
        assert!(text.contains("don't edit files unless asked"));
    }

    #[test]
    fn empty_plan_scope_lists_the_whole_project() {
        let text = plan_context(&project(), &[], &[]);
        assert!(text.contains("**API**"));
        assert!(text.contains("**DB**"));
        assert!(text.contains("**API** depends on **DB**"));
        assert!(!text.contains("## Nearby components"));
    }

    #[test]
    fn plan_omits_empty_sections() {
        let text = plan_context(&project(), &["db".into()], &[]);
        assert!(!text.contains("## Links between them"));
        assert!(text.contains("## Nearby components"));
        let mut p = project();
        p.links.clear();
        let text = plan_context(&p, &["api".into()], &[]);
        assert!(!text.contains("## Links between them"));
        assert!(!text.contains("## Nearby components"));
    }

    #[test]
    fn planner_session_uses_root_scope_and_context() {
        let mut p = project();
        p.name = "root-scope-demo".into();
        let spec = plan_session_spec(&p, &["api".into()], &planner(), &AllowAll, &[]).unwrap();
        assert_eq!(spec.id, "@plan/claude");
        assert_eq!(spec.cwd, PathBuf::from("/repo"));
        assert_eq!(spec.env[COMPONENT_ENV], "plan");
        assert!(spec.env.contains_key(CONTEXT_ENV));
        if cfg!(unix) {
            assert!(spec.command.contains("--append-system-prompt"));
            assert!(!spec.command.contains("--add-dir"));
        }
        let text = std::fs::read_to_string(&spec.env[CONTEXT_ENV]).unwrap();
        assert!(text.contains("## In scope"));
        assert!(text.contains("**API**"));
    }

    #[cfg(unix)]
    #[test]
    fn planner_adds_dirs_for_components_outside_the_root() {
        let mut p = project();
        p.components[1].path = "../shared/db".into();
        let spec = plan_session_spec(&p, &["api".into()], &planner(), &AllowAll, &[]).unwrap();
        assert_eq!(spec.command.matches("--add-dir").count(), 1);
        assert!(spec.command.contains("--add-dir '/shared/db'"));
    }

    #[test]
    fn planner_rejects_unknown_components() {
        let result = plan_session_spec(&project(), &["missing".into()], &planner(), &AllowAll, &[]);
        assert_eq!(
            result.err().unwrap().to_string(),
            "unknown component missing"
        );
    }

    #[test]
    fn planner_context_file_cannot_overwrite_a_component_context() {
        let mut p = project();
        p.name = "context-scope-demo".into();
        p.components[0].id = "plan-claude".into();
        let component = session_spec(&p, "plan-claude", "agent", &AllowAll, &[]).unwrap();
        let planner = plan_session_spec(&p, &[], &planner(), &AllowAll, &[]).unwrap();
        assert_ne!(component.env[CONTEXT_ENV], planner.env[CONTEXT_ENV]);
        assert_eq!(
            std::fs::read_to_string(&component.env[CONTEXT_ENV]).unwrap(),
            component_context(&p, "plan-claude", &[])
        );
    }

    #[test]
    fn planner_policy_receives_the_real_scope_and_can_deny_it() {
        struct Deny;
        impl Policy for Deny {
            fn check(&self, scope: Scope<'_>, _command: &str) -> Result<(), String> {
                let Scope::Plan(components) = scope else {
                    panic!("expected planner scope")
                };
                assert_eq!(components.len(), 2);
                assert_eq!(components[0].id, "api");
                Err("planning disabled".into())
            }
        }
        let mut p = project();
        p.name = "policy-demo".into();
        let result = plan_session_spec(&p, &[], &planner(), &Deny, &[]);
        assert_eq!(
            result.err().unwrap().to_string(),
            "blocked by policy: planning disabled"
        );
    }

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
    }
}
