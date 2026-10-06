//! Turns a component's terminal into a launchable session, giving agent
//! terminals the component's neighbours as context.

use crate::model::{
    Component, PLAN_SCOPE, Project, Relation, TerminalKind, TerminalSpec, task_session_id,
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

/// The shell that runs a terminal's command: the login shell, or `cmd.exe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

    /// How this shell spells the context file variable, for notices.
    fn context_var(self) -> &'static str {
        match self {
            Self::Unix => "$PATCHBAY_CONTEXT_FILE",
            Self::Windows => "%PATCHBAY_CONTEXT_FILE%",
        }
    }
}

/// Enough lexing, in the syntax of the shell that runs the command, to identify
/// simple invocations without rewriting them. Quoted operators are literal
/// arguments; compound or dynamic commands fall back.
fn command_tokens(command: &str, shell: Shell) -> Option<Vec<String>> {
    let tokens = match shell {
        Shell::Unix => sh_tokens(command)?,
        Shell::Windows => cmd_tokens(command)?,
    };
    // Appended flags after an option terminator would become prompt text.
    if tokens.iter().any(|t| t == "--") {
        return None;
    }
    Some(tokens)
}

fn sh_tokens(command: &str) -> Option<Vec<String>> {
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
    Some(tokens)
}

/// cmd.exe knows only double quotes, which a backslash never escapes, and
/// escapes operators with `^`. Single quotes are literal, so `'a & b'` is
/// compound. `%VAR%` arguments are kept, like `$VAR` on Unix.
fn cmd_tokens(command: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut started = false;
    for c in command.chars() {
        if c == '\n' || c == '\r' {
            return None;
        } else if c == '"' {
            quoted = !quoted;
            started = true;
        } else if quoted {
            token.push(c);
        } else if "&|<>()^".contains(c) {
            return None;
        } else if c.is_whitespace() {
            if started {
                tokens.push(std::mem::take(&mut token));
                started = false;
            }
        } else {
            token.push(c);
            started = true;
        }
    }
    if quoted {
        return None;
    }
    if started {
        tokens.push(token);
    }
    Some(tokens)
}

/// The program's position, after a leading `env` and `NAME=value` assignments.
fn program_index(tokens: &[String]) -> Option<usize> {
    let skip = usize::from(tokens.first().is_some_and(|token| token == "env"));
    (skip..tokens.len()).find(|&i| {
        let Some((name, _)) = tokens[i].split_once('=') else {
            return true;
        };
        let mut chars = name.chars();
        !(chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'))
    })
}

fn agent_named(program: &str) -> Option<Agent> {
    let program = program.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
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

/// `args` are the arguments after the `codex` program.
fn unsupported_codex_subcommand(args: &[String]) -> bool {
    let mut args = args.iter();
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
/// Quotes and backslashes occur only as TOML delimiters and Unicode escapes;
/// parentheses are escaped too, since shims expand `%*` inside `IF (...)` blocks.
fn toml_inert(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || " .,:_/-".contains(c) {
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

/// A plain TOML basic string. On Unix the whole argument is single-quoted, so
/// only TOML itself needs escaping.
fn toml_basic(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push('\t'),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_string(shell: Shell, s: &str) -> String {
    match shell {
        Shell::Unix => toml_basic(s),
        Shell::Windows => toml_inert(s),
    }
}

/// cmd.exe rejects lines over 8191 UTF-16 units after expanding variables. npm,
/// pnpm and yarn shims re-run `%*` inside a longer line that repeats their own
/// folder, so leave room for that.
const CMD_BUDGET: usize = 8191 - 1024;

/// Linux limits a single argument to 128 KiB, and the login shell receives the
/// whole command as one.
const SHELL_ARG_BUDGET: usize = 120 * 1024;

/// UTF-16 length of `command` once cmd.exe expands `%VAR%`, looking variables up
/// in the session's environment and then Patchbay's own. Undefined ones stay literal.
fn cmd_expanded_len(command: &str, env: &BTreeMap<String, String>) -> usize {
    let lookup = |name: &str| {
        // `%VAR:~0,5%` is at most the variable's length; `%VAR:a=b%` at most
        // that many copies of `b`.
        let (name, edit) = name.split_once(':').unwrap_or((name, ""));
        let growth = edit
            .split_once('=')
            .map_or(1, |(_, to)| to.encode_utf16().count().max(1));
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var(name).ok())
            .map(|value| value.encode_utf16().count() * growth)
    };
    let units = |s: &str| s.encode_utf16().count();
    let mut len = 0;
    let mut rest = command;
    while let Some(start) = rest.find('%') {
        len += units(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                if let Some(value) = lookup(&after[..end]) {
                    len += value;
                    rest = &after[end + 1..];
                } else {
                    // The closing `%` may open the next variable.
                    len += 1 + units(&after[..end]);
                    rest = &after[end..];
                }
            }
            _ => {
                len += 1;
                rest = after;
            }
        }
    }
    len + units(rest)
}

/// Codex reads a `-c` value as TOML, or as a raw string when that fails.
fn codex_value(raw: &str) -> Option<String> {
    let raw = raw.trim();
    match toml::from_str::<toml::Table>(&format!("v = {raw}")) {
        Ok(table) => table.get("v")?.as_str().map(Into::into),
        Err(_) => Some(raw.into()),
    }
}

/// The `developer_instructions` Codex would use without Patchbay's override, so
/// they can be kept: a `-c` override in the command, else the selected profile's,
/// else the top-level setting.
fn codex_instructions(args: &[String], config: Option<&toml::Table>) -> Option<String> {
    let mut cli = None;
    let mut profile = None;
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        match flag {
            "-c" | "--config" => {
                if let Some(value) = inline.or_else(|| args.next().cloned())
                    && let Some((key, value)) = value.split_once('=')
                    && key.trim() == "developer_instructions"
                {
                    cli = codex_value(value);
                }
            }
            "-p" | "--profile" => profile = inline.or_else(|| args.next().cloned()),
            _ => {}
        }
    }
    if cli.is_some() {
        return cli;
    }
    let config = config?;
    let instructions = |table: &toml::Value| {
        table
            .get("developer_instructions")?
            .as_str()
            .map(String::from)
    };
    profile
        .or_else(|| config.get("profile")?.as_str().map(Into::into))
        .and_then(|name| instructions(config.get("profiles")?.get(&name)?))
        .or_else(|| {
            config
                .get("developer_instructions")?
                .as_str()
                .map(Into::into)
        })
}

/// The user's Codex configuration, `$CODEX_HOME/config.toml` (`~/.codex` by default).
fn codex_config() -> Option<toml::Table> {
    // Unit tests must not depend on the developer's own Codex configuration.
    if cfg!(test) {
        return None;
    }
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    toml::from_str(&std::fs::read_to_string(home.join("config.toml")).ok()?).ok()
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

/// A briefing file name unique to the project's root, so two open projects (or
/// worktrees of one repo, which share a map and name) never overwrite each other's.
fn briefing_name(project: &Project, scope: &str, task: Option<&str>) -> String {
    let root = crate::workspace::session_id(&project.root, "", "");
    let task = task.map(|t| format!("{}{t}", crate::model::TASK_SEPARATOR));
    format!(
        "{}-{}-{scope}{}",
        project.name,
        &root[2..10],
        task.unwrap_or_default()
    )
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

/// An agent briefing: its file, its text, and the folders the agent may also read.
struct Briefing<'a> {
    file: &'a Path,
    text: &'a str,
    dirs: &'a [PathBuf],
}

/// Returns false when Codex receives a file pointer instead of the full text.
/// `existing` holds the user's own Codex instructions, which the override keeps.
fn decorate_agent(
    command: &mut String,
    agent: Agent,
    briefing: &Briefing<'_>,
    existing: Option<&str>,
    shell: Shell,
    env: &mut BTreeMap<String, String>,
) -> bool {
    for dir in briefing.dirs {
        let _ = write!(command, " --add-dir {}", quote_path(shell, dir, env));
    }
    match agent {
        Agent::Claude => {
            // Interactive sessions honour the file flag (checked with Claude Code 2.1.289).
            let _ = write!(
                command,
                " --append-system-prompt-file {}",
                quote_path(shell, briefing.file, env)
            );
            // Hooks that report working / needs input / done to Patchbay. They
            // are POSIX shell, and claude takes one `--settings`, so never
            // replace one the user passes.
            let own_settings = command_tokens(command, shell).is_none_or(|tokens| {
                tokens
                    .iter()
                    .any(|a| a == "--settings" || a.starts_with("--settings="))
            });
            if shell == Shell::Unix && !own_settings {
                let _ = write!(
                    command,
                    " --settings {}",
                    shell.quote(&crate::status::claude_hooks_settings())
                );
            }
        }
        Agent::Codex => {
            let argument = |text: &str| {
                let text = match existing {
                    Some(existing) => format!("{existing}\n\n{text}"),
                    None => text.into(),
                };
                format!(
                    " -c {}",
                    shell.quote(&format!(
                        "developer_instructions={}",
                        toml_string(shell, &text)
                    ))
                )
            };
            let inline = argument(briefing.text);
            let too_long = match shell {
                Shell::Windows => cmd_expanded_len(&format!("{command}{inline}"), env) > CMD_BUDGET,
                Shell::Unix => command.len() + inline.len() > SHELL_ARG_BUDGET,
            };
            if too_long {
                command.push_str(&argument(&format!(
                    "Your Patchbay briefing is in {}; read it before starting.",
                    briefing.file.display()
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
    briefing: &Briefing<'_>,
    shell: Shell,
    env: &mut BTreeMap<String, String>,
) -> Option<String> {
    let var = shell.context_var();
    let Some(tokens) = command_tokens(command, shell) else {
        return Some(format!(
            "Briefing not injected automatically: Patchbay only adds it to a plain claude or \
             codex command, without shell operators, substitutions or --. It's at {var}."
        ));
    };
    let invocation = program_index(&tokens).map(|i| (tokens[i].as_str(), &tokens[i + 1..]));
    let Some((agent, args)) =
        invocation.and_then(|(program, args)| Some((agent_named(program)?, args)))
    else {
        let program = invocation.map_or("this command", |(program, _)| program);
        return Some(format!(
            "Briefing not injected automatically for {program} — it's at {var}."
        ));
    };
    let existing = match agent {
        Agent::Claude => None,
        Agent::Codex if unsupported_codex_subcommand(args) => {
            return Some(format!(
                "Briefing not injected automatically for this Codex subcommand — it's at {var}."
            ));
        }
        Agent::Codex => codex_instructions(args, codex_config().as_ref()),
    };
    if decorate_agent(command, agent, briefing, existing.as_deref(), shell, env) {
        None
    } else {
        let launcher = match shell {
            Shell::Windows => "cmd.exe",
            Shell::Unix => "the login shell",
        };
        Some(format!(
            "Briefing too long for {launcher}; Codex was told to read {var}."
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
    plan_session_spec_for(project, component_ids, terminal, None, policy, sections)
}

/// [`plan_session_spec`] for a task's planner: the session id and briefing
/// file carry the task id, so planners of different tasks run side by side.
/// `project` should already be the task's ([`crate::tasks::project_in`]).
///
/// # Errors
/// As [`plan_session_spec`].
pub fn plan_session_spec_for(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    task: Option<&str>,
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
    let mut context_dirs: Vec<PathBuf> = Vec::new();
    if terminal.kind == TerminalKind::Agent {
        let briefing = plan_context(project, component_ids, sections);
        let file = context_file(
            &briefing_name(project, &format!("{PLAN_SCOPE}-{}", terminal.id), task),
            &briefing,
        )?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        // cwd is the root; components in other repos must be added explicitly.
        let dirs = &mut context_dirs;
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
        let briefing = Briefing {
            file: &file,
            text: &briefing,
            dirs,
        };
        notice = brief_agent(&mut command, &briefing, Shell::current(), &mut env);
    }
    policy
        .check(Scope::Plan(&components), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;
    Ok(SessionSpec {
        id: task_session_id(&project.root, PLAN_SCOPE, &terminal.id, task),
        command,
        cwd: PathBuf::from(&project.root),
        env,
        ready_when: terminal.ready_when.clone(),
        service: terminal.kind == TerminalKind::Task,
        notice,
        dirs: context_dirs,
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
    session_spec_for(project, component_id, terminal_id, None, policy, sections)
}

/// [`session_spec`] for a task: the session id and briefing file carry the
/// task id. `project` should already be the task's
/// ([`crate::tasks::project_in`]), so the terminal runs in its worktree.
///
/// # Errors
/// As [`session_spec`].
pub fn session_spec_for(
    project: &Project,
    component_id: &str,
    terminal_id: &str,
    task: Option<&str>,
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
    let mut context_dirs = Vec::new();

    if terminal.kind == TerminalKind::Agent {
        let briefing = component_context(project, component_id, sections);
        let file = context_file(&briefing_name(project, component_id, task), &briefing)?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        context_dirs = project
            .neighbours(component_id)
            .iter()
            .map(|(n, _)| project.component_dir(n))
            .collect();
        let briefing = Briefing {
            file: &file,
            text: &briefing,
            dirs: &context_dirs,
        };
        notice = brief_agent(&mut command, &briefing, Shell::current(), &mut env);
    }

    policy
        .check(Scope::Component(component), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;

    Ok(SessionSpec {
        id: task_session_id(&project.root, component_id, terminal_id, task),
        command,
        cwd: project.component_dir(component),
        env,
        ready_when: terminal.ready_when.clone(),
        service: terminal.kind == TerminalKind::Task,
        notice,
        dirs: context_dirs,
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

pub(crate) fn launch_words(command: &str) -> Option<Vec<String>> {
    command_tokens(command, Shell::current())
}
pub(crate) fn quote_argument(value: &str) -> String {
    Shell::current().quote(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Component, ComponentKind, Link, TerminalSpec};
    use crate::policy::AllowAll;

    #[test]
    fn extra_terminals_launch_in_the_component_and_replace_same_ids() {
        let terminal = TerminalSpec {
            adapter: None,
            id: "agent".into(),
            name: "Ad hoc".into(),
            command: "echo hi".into(),
            kind: TerminalKind::Task,
            ready_when: String::new(),
            action: None,
        };
        let spec = extra_session_spec(project(), "api", terminal, &AllowAll, &[]).unwrap();
        assert_eq!(
            spec.id,
            crate::workspace::session_id("/repo", "api", "agent")
        );
        assert_eq!(spec.command, "echo hi");
        assert_eq!(spec.cwd, PathBuf::from("/repo/services/api"));
        assert!(!spec.env.contains_key(CONTEXT_ENV));
        let missing = TerminalSpec {
            adapter: None,
            id: "x".into(),
            name: "X".into(),
            command: "true".into(),
            kind: TerminalKind::Task,
            ready_when: String::new(),
            action: None,
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
                        adapter: None,
                        id: "agent".into(),
                        name: "Claude".into(),
                        command: "claude".into(),
                        kind: TerminalKind::Agent,
                        ready_when: String::new(),
                        action: None,
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
            groups: vec![],
        }
    }

    #[test]
    fn task_sessions_carry_the_task_in_their_id_and_briefing_file() {
        let p = project();
        let main = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
        let task = session_spec_for(&p, "api", "agent", Some("t1"), &AllowAll, &[]).unwrap();
        assert_eq!(main.id, task_session_id(&p.root, "api", "agent", None));
        assert_eq!(
            task.id,
            task_session_id(&p.root, "api", "agent", Some("t1"))
        );
        assert_ne!(main.id, task.id);
        assert_ne!(main.env[CONTEXT_ENV], task.env[CONTEXT_ENV]);
        let plan = plan_session_spec_for(&p, &[], &planner(), Some("t1"), &AllowAll, &[]).unwrap();
        assert_eq!(
            plan.id,
            task_session_id(&p.root, PLAN_SCOPE, &planner().id, Some("t1"))
        );
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
        assert_eq!(
            spec.id,
            crate::workspace::session_id(&p.root, "api", "agent")
        );
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
        assert!(!spec.service);
        if cfg!(unix) {
            assert!(spec.command.contains(" --settings '{\"hooks\""));
        }
    }

    #[test]
    fn claude_keeps_the_users_own_settings() {
        let briefing = Briefing {
            file: Path::new("/tmp/ctx.md"),
            text: "",
            dirs: &[],
        };
        for command in [
            "claude --settings ./team.json",
            "claude --settings=./team.json",
        ] {
            let mut command = command.to_string();
            decorate_agent(
                &mut command,
                Agent::Claude,
                &briefing,
                None,
                Shell::Unix,
                &mut BTreeMap::new(),
            );
            assert_eq!(command.matches("--settings").count(), 1, "{command}");
            assert!(command.contains("--append-system-prompt-file"));
        }
    }

    fn planner() -> TerminalSpec {
        TerminalSpec {
            adapter: None,
            id: "claude".into(),
            name: "Claude".into(),
            command: "claude".into(),
            kind: TerminalKind::Agent,
            ready_when: String::new(),
            action: None,
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
        assert_eq!(
            spec.id,
            crate::workspace::session_id(&p.root, PLAN_SCOPE, "claude")
        );
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

    fn agent_program(command: &str, shell: Shell) -> Option<Agent> {
        let tokens = command_tokens(command, shell)?;
        agent_named(&tokens[program_index(&tokens)?])
    }

    fn briefing<'a>(file: &'a Path, text: &'a str, dirs: &'a [PathBuf]) -> Briefing<'a> {
        Briefing { file, text, dirs }
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
            assert_eq!(agent_program(command, Shell::Unix), expected, "{command}");
        }
    }

    #[test]
    fn windows_detection_follows_cmd_syntax() {
        for (command, expected) in [
            ("codex.cmd --model x", Some(Agent::Codex)),
            (
                r#""C:\Program Files\tools\codex.exe" --model x"#,
                Some(Agent::Codex),
            ),
            (r#"codex "explain A | B & C""#, Some(Agent::Codex)),
            ("claude --model %MODEL%", Some(Agent::Claude)),
            ("codex it's", Some(Agent::Codex)),
            // Single quotes don't quote in cmd, and a backslash doesn't escape a quote.
            ("codex 'explain A & B'", None),
            (r#"codex "a \" & b""#, None),
            ("codex ^& echo", None),
            ("codex (x)", None),
            ("codex -- prompt", None),
            (r#"codex "unterminated"#, None),
            ("codex\r\necho hi", None),
        ] {
            assert_eq!(
                agent_program(command, Shell::Windows),
                expected,
                "{command}"
            );
        }
    }

    fn decode_instructions(config: &str) -> String {
        let config: toml::Table = toml::from_str(config).unwrap();
        config["developer_instructions"].as_str().unwrap().into()
    }

    #[test]
    fn inert_toml_round_trips_shell_characters_and_unicode() {
        let text = "quotes \"' and \\ % ^ & | < > ! ` $ (a) \n\r\t café 世界 🦀\0";
        let encoded = toml_inert(text);
        // TOML requires delimiter quotes and escape backslashes. Everything else
        // must be an allowed literal or a Unicode escape, never raw shell syntax.
        assert!(!encoded.contains([
            '\'', '%', '^', '&', '|', '<', '>', '!', '`', '$', '(', ')', '\n', '\r'
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
    fn unix_toml_escapes_only_what_toml_needs() {
        let text = "quotes \"' and \\ % & $ (a) # * `x`\n\r\t café 世界 🦀\0";
        let encoded = toml_basic(text);
        assert!(encoded.contains("café 世界 🦀"));
        assert!(encoded.contains("(a) # * `x`"));
        assert_eq!(
            decode_instructions(&format!("developer_instructions={encoded}")),
            text
        );
        // Markdown stays close to its own size instead of growing several times over.
        let markdown = "## Heading\n\n- **item** `code`\n".repeat(100);
        assert!(toml_basic(&markdown).len() < markdown.len() * 5 / 4);
        assert!(toml_inert(&markdown).len() > markdown.len() * 2);
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
            toml_string(Shell::current(), &component_context(&p, "api", &sections))
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
    fn codex_keeps_the_users_own_instructions() {
        let args = |command: &str| -> Vec<String> {
            command_tokens(command, Shell::Unix).unwrap()[1..].to_vec()
        };
        let config: toml::Table = toml::from_str(
            r#"
            developer_instructions = "top level"
            [profiles.fast]
            developer_instructions = "fast profile"
            "#,
        )
        .unwrap();
        for (command, expected) in [
            ("codex", Some("top level")),
            ("codex -p fast", Some("fast profile")),
            ("codex --profile=fast", Some("fast profile")),
            ("codex -p missing", Some("top level")),
            (
                r#"codex -c 'developer_instructions="Run fmt"' -p fast"#,
                Some("Run fmt"),
            ),
            ("codex --config developer_instructions=raw", Some("raw")),
            ("codex -c model=x", Some("top level")),
        ] {
            assert_eq!(
                codex_instructions(&args(command), Some(&config)).as_deref(),
                expected,
                "{command}"
            );
        }
        let selected: toml::Table = toml::from_str(
            "profile = \"fast\"\n[profiles.fast]\ndeveloper_instructions = \"default profile\"",
        )
        .unwrap();
        assert_eq!(
            codex_instructions(&args("codex"), Some(&selected)).as_deref(),
            Some("default profile")
        );
        assert_eq!(codex_instructions(&args("codex"), None), None);

        let file = Path::new("/tmp/briefing.md");
        let mut command = "codex".into();
        assert!(decorate_agent(
            &mut command,
            Agent::Codex,
            &briefing(file, "the briefing", &[]),
            Some("Run fmt"),
            Shell::Unix,
            &mut BTreeMap::new(),
        ));
        let config = command
            .strip_prefix("codex -c '")
            .unwrap()
            .strip_suffix('\'')
            .unwrap();
        assert_eq!(decode_instructions(config), "Run fmt\n\nthe briefing");
    }

    #[test]
    fn unknown_agent_and_compound_commands_keep_command_and_get_a_notice() {
        for (command, notice) in [
            ("aider", "for aider"),
            ("codex && echo done", "plain claude or codex command"),
        ] {
            let mut p = project();
            p.components[0].terminals[0].command = command.into();
            let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
            assert_eq!(spec.command, command);
            assert!(spec.env.contains_key(CONTEXT_ENV));
            let text = spec.notice.unwrap();
            assert!(text.starts_with("Briefing not injected automatically"));
            assert!(text.contains(notice), "{text}");
            assert!(text.contains(Shell::current().context_var()));
        }
        let mut p = project();
        p.components[0].terminals[0].kind = TerminalKind::Task;
        let spec = session_spec(&p, "api", "agent", &AllowAll, &[]).unwrap();
        assert!(spec.notice.is_none());
        assert_eq!(spec.command, "claude");
        assert!(!spec.env.contains_key(CONTEXT_ENV));
    }

    #[test]
    fn windows_notices_use_cmd_variable_syntax() {
        let file = Path::new(r"C:\Temp\briefing.md");
        for command in ["aider", "codex 'a & b'", "codex exec x"] {
            let notice = brief_agent(
                &mut command.into(),
                &briefing(file, "briefing", &[]),
                Shell::Windows,
                &mut BTreeMap::new(),
            )
            .unwrap();
            assert!(notice.contains("%PATCHBAY_CONTEXT_FILE%"), "{notice}");
            assert!(!notice.contains('$'), "{notice}");
        }
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
            &briefing(file, "briefing", std::slice::from_ref(&dir)),
            None,
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
            &briefing(
                Path::new(r"C:\Temp\briefing.md"),
                "briefing",
                &[PathBuf::from(r"C:\Program Files\db")]
            ),
            None,
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        assert_eq!(
            command,
            r#"CLAUDE.EXE --add-dir "C:\Program Files\db" --append-system-prompt-file "C:\Temp\briefing.md""#
        );
    }

    #[test]
    fn cmd_length_counts_expanded_variables() {
        let env = BTreeMap::from([("Long".to_string(), "x".repeat(100))]);
        assert_eq!(cmd_expanded_len("a %LONG% b", &env), 104);
        assert_eq!(cmd_expanded_len("a %LONG:~0,5% b", &env), 104);
        assert_eq!(cmd_expanded_len("a %LONG:x=yy% b", &env), 204);
        // Undefined variables and stray percent signs stay literal.
        assert_eq!(
            cmd_expanded_len("%PATCHBAY_TEST_UNDEFINED% 5%", &env),
            "%PATCHBAY_TEST_UNDEFINED% 5%".len()
        );
        assert_eq!(cmd_expanded_len("100% %LONG%", &env), "100% ".len() + 100);
    }

    #[test]
    fn windows_codex_uses_a_pointer_when_the_complete_command_is_too_long() {
        let file = Path::new(r"C:\Temp\briefing.md");
        let text = "🦀".repeat(1000);
        let mut command = "codex.cmd".into();
        assert!(!decorate_agent(
            &mut command,
            Agent::Codex,
            &briefing(file, &text, &[]),
            None,
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
        assert!(command.encode_utf16().count() < CMD_BUDGET);
        let mut noticed = "codex.cmd".into();
        assert_eq!(
            brief_agent(
                &mut noticed,
                &briefing(file, &text, &[]),
                Shell::Windows,
                &mut BTreeMap::new()
            )
            .as_deref(),
            Some("Briefing too long for cmd.exe; Codex was told to read %PATCHBAY_CONTEXT_FILE%.")
        );
        assert_eq!(noticed, command);

        let mut unix = "codex".into();
        assert!(decorate_agent(
            &mut unix,
            Agent::Codex,
            &briefing(file, &text, &[]),
            None,
            Shell::Unix,
            &mut BTreeMap::new(),
        ));
        assert!(unix.contains(&text));
        let mut short = "codex".into();
        assert!(decorate_agent(
            &mut short,
            Agent::Codex,
            &briefing(file, "short briefing", &[]),
            None,
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        assert!(short.contains(r#"developer_instructions=\"short briefing\""#));
        // Existing flags also count against the limit, and leave room for a shim.
        let mut long_command = format!("codex --model {}", "x".repeat(7100));
        assert!(!decorate_agent(
            &mut long_command,
            Agent::Codex,
            &briefing(file, &"x".repeat(100), &[]),
            None,
            Shell::Windows,
            &mut BTreeMap::new(),
        ));
        // Paths moved into variables count at their expanded length.
        let dirs = [
            PathBuf::from(format!(r"C:\%X%\{}", "a".repeat(3000))),
            PathBuf::from(format!(r"C:\%X%\{}", "b".repeat(3000))),
        ];
        let mut expanded = "codex".into();
        let mut env = BTreeMap::new();
        assert!(!decorate_agent(
            &mut expanded,
            Agent::Codex,
            &briefing(file, &"x".repeat(1500), &dirs),
            None,
            Shell::Windows,
            &mut env,
        ));
        assert!(expanded.encode_utf16().count() < 1000);
    }

    #[test]
    fn unix_codex_uses_a_pointer_before_exceeding_the_shell_argument_limit() {
        let file = Path::new("/tmp/briefing.md");
        let mut command = "codex".into();
        let notice = brief_agent(
            &mut command,
            &briefing(file, &"🦀".repeat(32 * 1024), &[]),
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
        assert!(command.len() < SHELL_ARG_BUDGET);
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
            toml_string(Shell::current(), &plan_context(&p, &scope, &[]))
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
                    TerminalEvent::Started { .. } | TerminalEvent::Status { .. } => {}
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
            body: "🦀".repeat(32 * 1024),
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
                &briefing(&file, "briefing", &[]),
                None,
                Shell::Windows,
                &mut env
            ));
            let output = launch(SessionSpec {
                id: "claude/argv".into(),
                command,
                cwd: fixture.0.clone(),
                env,
                notice: None,
                dirs: Vec::new(),
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
