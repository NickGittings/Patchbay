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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Agent {
    Claude,
    Codex,
}

/// Enough shell lexing to identify simple invocations without rewriting them.
/// Quoted operators are literal arguments; compound or dynamic commands fall back.
fn command_tokens(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != Some('\'') {
            if let Some(&next) = chars.peek()
                && (next == '"'
                    || (quote.is_none() && (next.is_whitespace() || "'&|;<>`$\\".contains(next))))
            {
                token.push(chars.next()?);
            } else {
                token.push(c);
            }
            started = true;
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
            started = true;
        } else if quote != Some('\'') && (c == '`' || (c == '$' && chars.peek() == Some(&'('))) {
            return None;
        } else if quote.is_none() {
            if "&|;<>\n\r()".contains(c) || (c == '#' && !started) {
                return None;
            }
            if c.is_whitespace() {
                if started {
                    tokens.push(std::mem::take(&mut token));
                    started = false;
                }
            } else {
                token.push(c);
                started = true;
            }
        } else {
            token.push(c);
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(token);
    }
    // Appended flags after an option terminator would become prompt text.
    if tokens.iter().any(|t| t == "--") {
        return None;
    }
    Some(tokens)
}

fn program_token(command: &str) -> Option<String> {
    let mut tokens = command_tokens(command)?.into_iter().peekable();
    if tokens.peek().is_some_and(|token| token == "env") {
        tokens.next();
    }
    tokens.find(|token| {
        let Some((name, _)) = token.split_once('=') else {
            return true;
        };
        let mut chars = name.chars();
        !(chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'))
    })
}

fn agent_program(command: &str) -> Option<Agent> {
    let token = program_token(command)?;
    let program = token.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let program = [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|ext| program.strip_suffix(ext))
        .unwrap_or(&program);
    match program {
        "claude" => Some(Agent::Claude),
        "codex" => Some(Agent::Codex),
        _ => None,
    }
}

fn unsupported_codex_subcommand(command: &str, program: &str) -> bool {
    let tokens = command_tokens(command).unwrap_or_default();
    let Some(index) = tokens.iter().position(|token| token == program) else {
        return true;
    };
    let mut args = tokens[index + 1..].iter();
    while let Some(arg) = args.next() {
        if arg.starts_with('-') {
            if !arg.contains('=')
                && matches!(
                    arg.as_str(),
                    "-c" | "--config"
                        | "--enable"
                        | "--disable"
                        | "--remote"
                        | "--remote-auth-token-env"
                        | "-i"
                        | "--image"
                        | "-m"
                        | "--model"
                        | "--local-provider"
                        | "-p"
                        | "--profile"
                        | "-s"
                        | "--sandbox"
                        | "-a"
                        | "--ask-for-approval"
                        | "-C"
                        | "--cd"
                        | "--add-dir"
                )
            {
                args.next();
            }
            continue;
        }
        // `resume` and `fork` have interactive options, including --add-dir.
        // Non-interactive subcommands do not share that option surface.
        return matches!(
            arg.as_str(),
            "agents"
                | "exec"
                | "e"
                | "review"
                | "login"
                | "logout"
                | "mcp"
                | "plugin"
                | "app-server"
                | "remote-control"
                | "app"
                | "completion"
                | "update"
                | "doctor"
                | "sandbox"
                | "debug"
                | "apply"
                | "a"
                | "queue"
                | "archive"
                | "delete"
                | "migrate-rollouts"
                | "unarchive"
                | "cloud"
                | "exec-server"
                | "features"
                | "help"
        );
    }
    false
}

#[derive(Clone, Copy)]
enum Shell {
    Unix,
    Windows,
}

impl Shell {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    fn quote(self, s: &str) -> String {
        match self {
            Self::Unix => sh_quote(s),
            Self::Windows => cmd_quote(s),
        }
    }
}

/// Quote a Windows argument using MSVC argv rules, including trailing slashes.
fn cmd_quote(s: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in s.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            '\\',
            slashes * if c == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

fn quote_path(shell: Shell, path: &Path, env: &mut BTreeMap<String, String>) -> String {
    let path = path.display().to_string();
    if matches!(shell, Shell::Windows) && path.contains('%') {
        // cmd expands percent variables even inside quotes. Expansion is not
        // recursive: insert generated paths from a private variable instead.
        // Keep MSVC's escaping inside the outer quotes (notably trailing slashes).
        let quoted = cmd_quote(&path);
        let mut index = 0;
        let key = loop {
            let key = format!("PATCHBAY_ARGUMENT_{index}");
            if !env.contains_key(&key) {
                break key;
            }
            index += 1;
        };
        env.insert(key.clone(), quoted[1..quoted.len() - 1].into());
        cmd_quote(&format!("%{key}%"))
    } else {
        shell.quote(&path)
    }
}

/// A TOML basic string whose content is inert even through npm's cmd shims.
/// Quotes and backslashes occur only as TOML delimiters and Unicode escapes.
fn toml_inert(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || " .,:_/()-".contains(c) {
            out.push(c);
        } else if u32::from(c) <= 0xffff {
            let _ = write!(out, "\\u{:04X}", u32::from(c));
        } else {
            let _ = write!(out, "\\U{:08X}", u32::from(c));
        }
    }
    out.push('"');
    out
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
    // Write then rename, so a starting agent never
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

/// Returns false when Codex receives a file pointer instead of the full text.
fn decorate_agent(
    command: &mut String,
    agent: Agent,
    file: &Path,
    briefing: &str,
    dirs: &[PathBuf],
    shell: Shell,
    env: &mut BTreeMap<String, String>,
) -> bool {
    for dir in dirs {
        let _ = write!(command, " --add-dir {}", quote_path(shell, dir, env));
    }
    match agent {
        Agent::Claude => {
            let _ = write!(
                command,
                " --append-system-prompt-file {}",
                quote_path(shell, file, env)
            );
        }
        Agent::Codex => {
            let argument = |text: &str| {
                format!(
                    " -c {}",
                    shell.quote(&format!("developer_instructions={}", toml_inert(text)))
                )
            };
            let inline = argument(briefing);
            // Leave room below cmd.exe's 8191 UTF-16 units and Linux's usual
            // 128 KiB per-argument limit (the shell receives the entire command).
            let too_long = match shell {
                Shell::Windows => {
                    command.encode_utf16().count() + inline.encode_utf16().count() > 8000
                }
                Shell::Unix => command.len() + inline.len() > 120 * 1024,
            };
            if too_long {
                command.push_str(&argument(&format!(
                    "Your Patchbay briefing is in {}; read it before starting.",
                    file.display()
                )));
                return false;
            }
            command.push_str(&inline);
        }
    }
    true
}

fn brief_agent(
    command: &mut String,
    file: &Path,
    briefing: &str,
    dirs: &[PathBuf],
    shell: Shell,
    env: &mut BTreeMap<String, String>,
) -> Option<String> {
    let Some(agent) = agent_program(command) else {
        let program = program_token(command).unwrap_or_else(|| {
            command
                .split_whitespace()
                .next()
                .unwrap_or("this command")
                .into()
        });
        return Some(format!(
            "Briefing not injected automatically for {program} — it's at $PATCHBAY_CONTEXT_FILE."
        ));
    };
    if agent == Agent::Codex
        && unsupported_codex_subcommand(command, &program_token(command).unwrap_or_default())
    {
        return Some("Briefing not injected automatically for this Codex subcommand — it's at $PATCHBAY_CONTEXT_FILE.".into());
    }
    if decorate_agent(command, agent, file, briefing, dirs, shell, env) {
        None
    } else {
        let launcher = match shell {
            Shell::Windows => "cmd.exe",
            Shell::Unix => "the login shell",
        };
        Some(format!(
            "Briefing too long for {launcher}; Codex was told to read $PATCHBAY_CONTEXT_FILE."
        ))
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
    let mut notice = None;
    if terminal.kind == TerminalKind::Agent {
        let briefing = plan_context(project, component_ids, sections);
        let file = context_file(
            &format!("{}-{PLAN_SCOPE}-{}", project.name, terminal.id),
            &briefing,
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
        notice = brief_agent(
            &mut command,
            &file,
            &briefing,
            &dirs,
            Shell::current(),
            &mut env,
        );
    }
    policy
        .check(Scope::Plan(&components), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;
    Ok(SessionSpec {
        id: session_id(PLAN_SCOPE, &terminal.id),
        command,
        cwd: PathBuf::from(&project.root),
        env,
        notice,
    })
}

/// Build the session for one of a component's terminals.
///
/// Agent terminals get `PATCHBAY_CONTEXT_FILE`; Claude and Codex additionally get
/// native instructions and neighbour folders via `--add-dir` on every platform.
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
    let mut notice = None;

    if terminal.kind == TerminalKind::Agent {
        let briefing = component_context(project, component_id, sections);
        let file = context_file(&format!("{}-{component_id}", project.name), &briefing)?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        let dirs: Vec<_> = project
            .neighbours(component_id)
            .iter()
            .map(|(n, _)| project.component_dir(n))
            .collect();
        notice = brief_agent(
            &mut command,
            &file,
            &briefing,
            &dirs,
            Shell::current(),
            &mut env,
        );
    }

    policy
        .check(Scope::Component(component), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;

    Ok(SessionSpec {
        id: session_id(component_id, terminal_id),
        command,
        cwd: project.component_dir(component),
        env,
        notice,
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

    #[test]
    fn claude_gets_neighbour_dirs_and_context() {
        let p = project();
        let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
        assert_eq!(spec.id, "api/agent");
        assert_eq!(spec.cwd, PathBuf::from("/repo/services/api"));
        let neighbour = p.component_dir(&p.components[1]);
        assert!(spec.command.starts_with(&format!(
            "claude --add-dir {}",
            Shell::current().quote(&neighbour.display().to_string())
        )));
        assert!(spec.command.contains(&format!(
            "--append-system-prompt-file {}",
            Shell::current().quote(&spec.env[CONTEXT_ENV])
        )));
        assert!(!spec.command.contains("$(cat"));
        assert!(spec.env.contains_key(CONTEXT_ENV));
        assert!(spec.notice.is_none());
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
        assert!(spec.command.contains("--append-system-prompt-file"));
        assert!(!spec.command.contains("--add-dir"));
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

    #[test]
    fn detects_agent_programs_and_leaves_compound_commands_alone() {
        for (command, expected) in [
            ("claude", Some(Agent::Claude)),
            ("  claude --model sonnet", Some(Agent::Claude)),
            ("/usr/local/bin/codex", Some(Agent::Codex)),
            ("env A=1 codex --model x", Some(Agent::Codex)),
            ("A=1 B=two claude", Some(Agent::Claude)),
            ("codex.cmd", Some(Agent::Codex)),
            (r"C:\tools\CLAUDE.EXE", Some(Agent::Claude)),
            ("codex.bat", Some(Agent::Codex)),
            (
                r#""C:\Program Files\tools\codex.exe" --model x"#,
                Some(Agent::Codex),
            ),
            ("claude -p 'explain A & B'", Some(Agent::Claude)),
            (r#"codex "explain A | B; C""#, Some(Agent::Codex)),
            ("env A='one two' codex", Some(Agent::Codex)),
            ("codex 'literal $(example)'", Some(Agent::Codex)),
            ("codex # comment", None),
            ("codex -- prompt", None),
            ("codex 'unterminated", None),
            (r#"codex "$(echo hi)""#, None),
            ("npx foo", None),
            ("codex && echo", None),
            ("claude | cat", None),
            ("claude; echo hi", None),
            ("codex > log", None),
            ("codex\necho hi", None),
            ("", None),
        ] {
            assert_eq!(agent_program(command), expected, "{command}");
        }
    }

    fn decode_instructions(config: &str) -> String {
        let config: toml::Table = toml::from_str(config).unwrap();
        config["developer_instructions"].as_str().unwrap().into()
    }

    #[test]
    fn inert_toml_round_trips_shell_characters_and_unicode() {
        let text = "quotes \"' and \\ % ^ & | < > ! ` $\n\r\t café 世界 🦀\0";
        let encoded = toml_inert(text);
        // TOML requires delimiter quotes and escape backslashes. Everything else
        // must be an allowed literal or a Unicode escape, never raw shell syntax.
        assert!(!encoded.contains([
            '\'', '%', '^', '&', '|', '<', '>', '!', '`', '$', '\n', '\r'
        ]));
        assert_eq!(encoded.matches('"').count(), 2);
        let content = &encoded[1..encoded.len() - 1];
        for literal in content.split('\\').skip(1) {
            let (prefix, digits) = literal.split_at(1);
            let width = match prefix {
                "u" => 4,
                "U" => 8,
                _ => panic!("non-Unicode escape"),
            };
            assert!(digits[..width].chars().all(|c| c.is_ascii_hexdigit()));
        }
        assert_eq!(
            decode_instructions(&format!("developer_instructions={encoded}")),
            text
        );
    }

    #[test]
    fn codex_receives_exact_component_briefing() {
        let mut p = project();
        p.components[0].terminals[0].command = "env A=1 codex --model x".into();
        let sections = [ContextSection {
            title: "Extra".into(),
            body: "'quotes', \"quotes\", $HOME & café 🦀".into(),
        }];
        let spec = session_spec(&p, "api", "agent", &AllowAll, &sections).unwrap();
        assert!(
            spec.command
                .starts_with("env A=1 codex --model x --add-dir ")
        );
        let config = format!(
            "developer_instructions={}",
            toml_inert(&component_context(&p, "api", &sections))
        );
        assert!(
            spec.command
                .ends_with(&format!(" -c {}", Shell::current().quote(&config)))
        );
        assert_eq!(
            decode_instructions(&config),
            component_context(&p, "api", &sections)
        );
        assert!(spec.notice.is_none());
    }

    #[test]
    fn unknown_agent_and_compound_commands_keep_command_and_get_a_notice() {
        for command in ["aider", "codex && echo done"] {
            let mut p = project();
            p.components[0].terminals[0].command = command.into();
            let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
            assert_eq!(spec.command, command);
            assert!(spec.env.contains_key(CONTEXT_ENV));
            assert!(
                spec.notice
                    .unwrap()
                    .contains("Briefing not injected automatically")
            );
        }
        let mut p = project();
        p.components[0].terminals[0].kind = TerminalKind::Task;
        let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
        assert!(spec.notice.is_none());
        assert_eq!(spec.command, "claude");
        assert!(!spec.env.contains_key(CONTEXT_ENV));
    }

    #[test]
    fn unsupported_codex_subcommands_launch_unchanged_with_a_notice() {
        for command in [
            "codex review --uncommitted",
            "codex exec resume --last",
            "env A=1 codex -m test exec 'inspect the repo'",
        ] {
            let mut p = project();
            p.components[0].terminals[0].command = command.into();
            let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
            assert_eq!(spec.command, command);
            assert!(spec.env.contains_key(CONTEXT_ENV));
            assert!(spec.notice.unwrap().contains("Codex subcommand"));
        }
        for command in [
            "codex --model review",
            "codex resume --last",
            "codex fork --last",
            "codex 'review my code'",
        ] {
            let mut p = project();
            p.components[0].terminals[0].command = command.into();
            let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
            assert!(spec.command.contains("--add-dir"));
            assert!(spec.notice.is_none());
        }
    }

    #[test]
    fn windows_paths_with_percent_signs_use_literal_environment_values() {
        let dir = PathBuf::from(r"C:\repos\%USERNAME%\db\");
        let file = Path::new(r"C:\Temp\%USERPROFILE%\briefing.md");
        let mut env = BTreeMap::from([("PATCHBAY_ARGUMENT_0".into(), "existing".into())]);
        let mut command = "claude".into();
        assert!(decorate_agent(
            &mut command,
            Agent::Claude,
            file,
            "briefing",
            std::slice::from_ref(&dir),
            Shell::Windows,
            &mut env
        ));
        assert_eq!(
            command,
            r#"claude --add-dir "%PATCHBAY_ARGUMENT_1%" --append-system-prompt-file "%PATCHBAY_ARGUMENT_2%""#
        );
        assert_eq!(env["PATCHBAY_ARGUMENT_0"], "existing");
        let quoted = cmd_quote(&dir.display().to_string());
        assert_eq!(env["PATCHBAY_ARGUMENT_1"], quoted[1..quoted.len() - 1]);
        assert_eq!(env["PATCHBAY_ARGUMENT_2"], file.display().to_string());
    }

    #[test]
    fn windows_quotes_arguments_and_claude_file_paths() {
        assert_eq!(
            cmd_quote(r"C:\Program Files\db"),
            r#""C:\Program Files\db""#
        );
        assert_eq!(cmd_quote("a\"b"), r#""a\"b""#);
        assert_eq!(cmd_quote("C:\\db\\"), "\"C:\\db\\\\\"");
        assert_eq!(cmd_quote("a\\\"b"), "\"a\\\\\\\"b\"");
        let mut command = "CLAUDE.EXE".into();
        assert!(decorate_agent(
            &mut command,
            Agent::Claude,
            Path::new(r"C:\Temp\briefing.md"),
            "briefing",
            &[PathBuf::from(r"C:\Program Files\db")],
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        assert_eq!(
            command,
            r#"CLAUDE.EXE --add-dir "C:\Program Files\db" --append-system-prompt-file "C:\Temp\briefing.md""#
        );
    }

    #[test]
    fn windows_codex_uses_a_pointer_when_the_complete_command_is_too_long() {
        let file = Path::new(r"C:\Temp\briefing.md");
        let briefing = "🦀".repeat(1000);
        let mut command = "codex.cmd".into();
        assert!(!decorate_agent(
            &mut command,
            Agent::Codex,
            file,
            &briefing,
            &[],
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        let pointer = format!(
            "Your Patchbay briefing is in {}; read it before starting.",
            file.display()
        );
        assert_eq!(
            command,
            format!(
                "codex.cmd -c {}",
                cmd_quote(&format!("developer_instructions={}", toml_inert(&pointer)))
            )
        );
        assert!(command.encode_utf16().count() < 8000);
        let mut noticed = "codex.cmd".into();
        assert_eq!(
            brief_agent(
                &mut noticed,
                file,
                &briefing,
                &[],
                Shell::Windows,
                &mut BTreeMap::new()
            )
            .as_deref(),
            Some("Briefing too long for cmd.exe; Codex was told to read $PATCHBAY_CONTEXT_FILE.")
        );
        assert_eq!(noticed, command);

        let mut unix = "codex".into();
        assert!(decorate_agent(
            &mut unix,
            Agent::Codex,
            file,
            &briefing,
            &[],
            Shell::Unix,
            &mut BTreeMap::new(),
        ));
        assert!(unix.len() > 8000);
        let mut short = "codex".into();
        assert!(decorate_agent(
            &mut short,
            Agent::Codex,
            file,
            "short briefing",
            &[],
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        assert!(short.contains(r#"developer_instructions=\"short briefing\""#));
        // Existing flags also count against the limit.
        let mut long_command = format!("codex --model {}", "x".repeat(7950));
        assert!(!decorate_agent(
            &mut long_command,
            Agent::Codex,
            file,
            "x".repeat(100).as_str(),
            &[],
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
    }

    #[test]
    fn unix_codex_uses_a_pointer_before_exceeding_the_shell_argument_limit() {
        let file = Path::new("/tmp/briefing.md");
        let mut command = "codex".into();
        let notice = brief_agent(
            &mut command,
            file,
            &"🦀".repeat(16 * 1024),
            &[],
            Shell::Unix,
            &mut BTreeMap::new(),
        );
        assert_eq!(
            notice.as_deref(),
            Some(
                "Briefing too long for the login shell; Codex was told to read $PATCHBAY_CONTEXT_FILE."
            )
        );
        let config = command
            .strip_prefix("codex -c '")
            .unwrap()
            .strip_suffix('\'')
            .unwrap();
        assert_eq!(
            decode_instructions(config),
            "Your Patchbay briefing is in /tmp/briefing.md; read it before starting."
        );
        assert!(command.len() < 120 * 1024);
    }

    #[test]
    fn codex_planner_inlines_the_scoped_briefing() {
        let mut p = project();
        p.components[1].path = if cfg!(windows) {
            "C:/shared/db"
        } else {
            "/shared/db"
        }
        .into();
        let mut terminal = planner();
        terminal.command = "codex".into();
        let scope = ["api".into()];
        let spec = plan_session_spec(&p, &scope, &terminal, &AllowAll, &[]).unwrap();
        assert!(spec.command.contains(&format!(
            "--add-dir {}",
            Shell::current().quote(&p.component_dir(&p.components[1]).display().to_string())
        )));
        assert_eq!(spec.command.matches("--add-dir").count(), 1);
        let config = format!(
            "developer_instructions={}",
            toml_inert(&plan_context(&p, &scope, &[]))
        );
        assert!(
            spec.command
                .ends_with(&format!(" -c {}", Shell::current().quote(&config)))
        );
        assert!(spec.notice.is_none());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn codex_briefing_and_large_file_pointer_reach_argv_through_the_pty() {
        use crate::events::{EventSink, TerminalEvent};
        use crate::pty::PtyManager;
        use std::sync::{Arc, mpsc};
        use std::time::Duration;

        struct Sink(mpsc::Sender<TerminalEvent>);
        impl EventSink for Sink {
            fn emit(&self, event: TerminalEvent) {
                let _ = self.0.send(event);
            }
        }
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        fn launch(spec: SessionSpec) -> String {
            let pty = Arc::new(PtyManager::new());
            let (tx, rx) = mpsc::channel();
            pty.spawn(spec, Arc::new(Sink(tx))).unwrap();
            let mut output = Vec::new();
            loop {
                match rx.recv_timeout(Duration::from_secs(20)).unwrap() {
                    TerminalEvent::Output { data, .. } => output.extend(data),
                    TerminalEvent::Exited { exit_code, .. } => {
                        assert_eq!(exit_code, 0);
                        break;
                    }
                    TerminalEvent::Started { .. } => {}
                }
            }
            String::from_utf8(output).unwrap()
        }
        fn instructions(output: &str) -> String {
            let config = output
                .lines()
                .find_map(|line| line.strip_prefix("ARG:developer_instructions="))
                .unwrap();
            decode_instructions(&format!("developer_instructions={config}"))
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "patchbay-codex-argv-{} with spaces",
            std::process::id()
        )));
        std::fs::create_dir_all(&fixture.0).unwrap();
        let mut p = project();
        p.name = "codex-argv-demo".into();
        p.root = fixture.0.display().to_string();
        std::fs::create_dir_all(fixture.0.join("services/api")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = fixture.0.join("codex");
            std::fs::write(&script, "#!/bin/sh\nprintf 'ARG:%s\\n' \"$@\"\n").unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            // Set PATH after login-shell startup; avoid mutating the global
            // environment or accidentally launching an installed Codex.
            p.components[0].terminals[0].command = format!(
                "env PATH={} codex --model test",
                sh_quote(&fixture.0.display().to_string())
            );
        }
        #[cfg(windows)]
        {
            let script = fixture.0.join("codex.cmd");
            // Re-parse %* like an npm shim, then print the actual received argv.
            std::fs::write(&script, "@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0argv.ps1\" %*\r\n").unwrap();
            std::fs::write(
                fixture.0.join("argv.ps1"),
                "foreach ($arg in $args) { Write-Output ('ARG:' + $arg) }\r\n",
            )
            .unwrap();
            p.components[0].terminals[0].command = format!(
                "{} --model %PB_MODEL%",
                cmd_quote(&script.display().to_string())
            );
            p.components[1].path = fixture.0.join("db-%USERNAME%").display().to_string();
        }
        let sections = [ContextSection {
            title: "Shell test".into(),
            body: "quotes '\" & % ! $HOME `echo bad` café 🦀".into(),
        }];
        let mut spec = session_spec(&p, "api", "agent", &AllowAll, &sections).unwrap();
        spec.env.insert("PB_MODEL".into(), "test".into());
        assert!(spec.notice.is_none());
        let expected = component_context(&p, "api", &sections);
        let output = launch(spec);
        assert_eq!(instructions(&output), expected);
        assert!(output.contains("ARG:--add-dir"));
        assert!(
            output
                .lines()
                .any(|line| line == format!("ARG:{}", p.component_dir(&p.components[1]).display()))
        );
        assert!(output.lines().any(|line| line == "ARG:test"));

        let sections = [ContextSection {
            title: "Large".into(),
            body: "🦀".repeat(16 * 1024),
        }];
        let mut spec = session_spec(&p, "api", "agent", &AllowAll, &sections).unwrap();
        spec.env.insert("PB_MODEL".into(), "test".into());
        assert!(spec.notice.is_some());
        let file = spec.env[CONTEXT_ENV].clone();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            component_context(&p, "api", &sections)
        );
        let output = launch(spec);
        assert_eq!(
            instructions(&output),
            format!("Your Patchbay briefing is in {file}; read it before starting.")
        );
        assert!(output.starts_with("\x1b[2m[patchbay] Briefing too long"));

        #[cfg(windows)]
        {
            let script = fixture.0.join("claude.cmd");
            std::fs::copy(fixture.0.join("codex.cmd"), &script).unwrap();
            let file = fixture.0.join("briefing-%USERNAME%.md");
            std::fs::write(&file, "briefing").unwrap();
            let mut command = cmd_quote(&script.display().to_string());
            let mut env = BTreeMap::new();
            assert!(decorate_agent(
                &mut command,
                Agent::Claude,
                &file,
                "briefing",
                &[],
                Shell::Windows,
                &mut env
            ));
            let output = launch(SessionSpec {
                id: "claude/argv".into(),
                command,
                cwd: fixture.0.clone(),
                env,
                notice: None,
            });
            assert!(
                output
                    .lines()
                    .any(|line| line == "ARG:--append-system-prompt-file")
            );
            assert!(
                output
                    .lines()
                    .any(|line| line == format!("ARG:{}", file.display()))
            );
        }
    }
}
