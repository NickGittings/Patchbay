//! Turns a component's terminal into a launchable session, giving agent
//! terminals the component's neighbours as context.

use crate::model::{
    Component, PLAN_SCOPE, Project, Relation, TASK_ROOT_SCOPE, TerminalKind, TerminalSpec,
    task_session_id,
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

/// Backend-owned instructions for an Auto launch.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoBrief {
    pub goal: String,
    pub fix_floor: Option<crate::reviews::Severity>,
    pub effort_note: String,
    pub commit: bool,
}

impl AutoBrief {
    #[must_use]
    pub fn section(&self, stage: &str) -> ContextSection {
        let mut body = format!(
            "Goal: {}\n\nStage: {stage}\n\n{}\n",
            self.goal, self.effort_note
        );
        if let Some(floor) = self.fix_floor {
            let _ = writeln!(
                body,
                "Fix findings tagged ≥ {}; leave lower ones listed.",
                floor.label()
            );
        }
        if self.commit {
            body.push_str("Commit your work with a descriptive message when done.\n");
        }
        body.push_str("Don't ask for confirmation unless blocked.\n");
        ContextSection {
            title: "Auto mode".into(),
            body,
        }
    }

    /// The section for an Auto planner.
    #[must_use]
    pub fn plan_section(&self) -> ContextSection {
        self.section("plan")
    }

    /// The section for a root agent launched with `kickoff` (as [`root_handoff`]
    /// settled it): a fix agent fixes, any other implements.
    #[must_use]
    pub fn root_section(&self, kickoff: Option<Kickoff>) -> ContextSection {
        self.section(if kickoff == Some(Kickoff::FixFindings) {
            "fix"
        } else {
            "implement"
        })
    }

    #[must_use]
    pub fn markdown(&self, stage: &str) -> String {
        let mut out = String::new();
        append_sections(&mut out, &[self.section(stage)]);
        out
    }
}

/// The first task of a fresh agent: a root agent implements the plan or fixes
/// review findings; an Auto planner plans.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kickoff {
    ImplementPlan,
    FixFindings,
    Plan,
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
    out.push_str(&implementation_actions(Shell::current()));
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
    /// An agent command for briefings, run through the CLI named by `PATCHBAY_CLI`.
    /// Windows agents may run PowerShell or cmd, so both spellings are given.
    fn agent_command(self, args: &str) -> String {
        match self {
            Self::Unix => format!("`\"$PATCHBAY_CLI\" agent {args}`"),
            Self::Windows => format!(
                "`& $env:PATCHBAY_CLI agent {args}` (in cmd, `\"%PATCHBAY_CLI%\" agent {args}`)"
            ),
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

/// Resolve status integration using the same command parser as agent briefings.
#[must_use]
pub fn agent_provider(terminal: &TerminalSpec) -> Option<crate::adapters::Adapter> {
    terminal.adapter.or_else(|| {
        let tokens = command_tokens(&terminal.command, Shell::current())?;
        match agent_named(&tokens[program_index(&tokens)?])? {
            Agent::Claude => Some(crate::adapters::Adapter::Claude),
            Agent::Codex => Some(crate::adapters::Adapter::Codex),
        }
    })
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
         don't edit project files unless asked. Implementation begins through Patchbay's \
         Implement action, not by switching this planner to auto mode.",
    );
    // Only a repo has somewhere to keep the plan (`plan_session_spec_for` sets the variable).
    if crate::plans::plan_file(Path::new(&project.root), None).is_ok() {
        out.push_str(
            " Whenever you produce or revise a complete plan, save it as Markdown to \
             `$PATCHBAY_PLAN_FILE` before replying; this plan artifact is an exception to \
             the no-edit rule. Do not wait for the user to request a save. Implementation \
             agents receive it automatically. When Claude's native plan mode prevents \
             writing this file, its ExitPlanMode hook can hand the native plan to Patchbay \
             through the enabled Claude integration. Present the plan for review without \
             starting implementation in this planner.",
        );
    }
    let _ = writeln!(
        out,
        "\nTo propose scope and assignments, write JSON {{\"version\":1,\"plan\":\"agreed Markdown\",\"assignments\":[{{\"componentId\":\"stable ID above\",\"assignment\":\"specific work\"}}]}} and run {}. Submit one with every complete plan, including a plan presented through Claude's plan mode, so the user sees which components it touches. Order assignments deliberately. Submission waits for the user to Apply selection; it never changes scope or starts agents.",
        Shell::current().agent_command("propose --file <json>")
    );
    append_sections(&mut out, sections);
    out
}

/// How implementation agents run checks and environments, in the syntax of the shell they use.
fn implementation_actions(shell: Shell) -> String {
    format!(
        "\nAfter changing a component, run its configured affected-component checks with {}. Report missing validators explicitly. Start configured environments when needed with {}, and stop them with {}. Use {}, {} and {} for configured IDs, sessions and preview URLs. These commands stay bound to your launch project and task. Do not install dependencies or copy environment files automatically.\n",
        shell.agent_command("validate <componentId>"),
        shell.agent_command("environment start <groupId>"),
        shell.agent_command("environment stop <groupId>"),
        shell.agent_command("context"),
        shell.agent_command("status"),
        shell.agent_command("logs <sessionId>"),
    )
}

/// Implementation instructions for one agent coordinating the complete selected scope.
#[must_use]
pub fn implementation_context(
    project: &Project,
    ids: &[String],
    sections: &[ContextSection],
    kickoff: Option<Kickoff>,
) -> String {
    let mut out = format!(
        "# Patchbay implementation context\n\nImplement the task in **{}** at `{}`.\n\n## Selected components\n\n",
        project.name, project.root
    );
    for component in plan_components(project, ids) {
        describe_component(&mut out, project, component);
    }
    let instructions = match kickoff {
        Some(Kickoff::FixFindings) => "addressing the review findings below",
        _ => "using the saved plan and applied assignments below",
    };
    let _ = writeln!(
        out,
        "\nCoordinate and implement the complete selected scope, {instructions}."
    );
    out.push_str(&implementation_actions(Shell::current()));
    append_sections(&mut out, sections);
    out
}

/// Briefing section naming the other components changed alongside `component_id`
/// (the peers being implemented together), with the links between them.
/// `None` when no other known peer remains.
#[must_use]
pub fn peers_section(
    project: &Project,
    component_id: &str,
    peers: &[String],
) -> Option<ContextSection> {
    let mut body = String::new();
    let mut seen = HashSet::from([component_id]);
    for id in peers {
        let Some(peer) = project.component(id) else {
            continue;
        };
        if !seen.insert(peer.id.as_str()) {
            continue;
        }
        describe_component(&mut body, project, peer);
        for link in &project.links {
            let relation = if link.source == component_id && link.target == peer.id {
                "this component depends on it"
            } else if link.source == peer.id && link.target == component_id {
                "it depends on this component"
            } else {
                continue;
            };
            let _ = write!(body, "  - {relation}");
            if let Some(label) = &link.label {
                let _ = write!(body, " — {label}");
            }
            body.push('\n');
        }
    }
    (!body.is_empty()).then(|| ContextSection {
        title: "Working alongside".into(),
        body: format!(
            "This change also covers these components:\n\n{body}\nCoordinate interface \
             changes with them; another agent may be editing them."
        ),
    })
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
        "- **{}** (ID: `{}`, {:?}) at `{}`",
        c.name,
        c.id,
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

/// An agent briefing: its file, its text, the folders the agent may also read, and
/// an optional first prompt, given only to a command the briefing was injected into.
struct Briefing<'a> {
    file: &'a Path,
    text: &'a str,
    dirs: &'a [PathBuf],
    prompt: Option<&'a str>,
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
    // The prompt goes last, but counts against the budget alongside the instructions.
    let prompt = briefing
        .prompt
        .map(|prompt| format!(" {}", shell.quote(prompt)))
        .unwrap_or_default();
    let inlined = match agent {
        Agent::Claude => {
            // Interactive sessions honour the file flag (checked with Claude Code 2.1.289).
            let _ = write!(
                command,
                " --append-system-prompt-file {}",
                quote_path(shell, briefing.file, env)
            );
            // Status integration is opt-in in the effective user hook source.
            // Preserve all launch settings, including disabled-hook policy.
            true
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
                Shell::Windows => {
                    cmd_expanded_len(&format!("{command}{inline}{prompt}"), env) > CMD_BUDGET
                }
                Shell::Unix => command.len() + inline.len() + prompt.len() > SHELL_ARG_BUDGET,
            };
            if too_long {
                command.push_str(&argument(&format!(
                    "Your Patchbay briefing is in {}; read it before starting.",
                    briefing.file.display()
                )));
                false
            } else {
                command.push_str(&inline);
                true
            }
        }
    };
    command.push_str(&prompt);
    inlined
}

const MERGE_PROMPT: &str = "Complete the local merge described in your Patchbay briefing. Verify the worktrees, resolve conflicts, run relevant checks, and report the result.";

pub(crate) const REVIEW_PROMPT: &str = "Review the whole branch described in your Patchbay briefing. Report findings to PATCHBAY_REVIEW_FILE and do not modify the worktree.";

/// Drop only the exact trailing kickoff Patchbay appended, preserving all provider options.
fn job_resume_command(command: &str, prompt: &str) -> String {
    let suffix = format!(" {}", Shell::current().quote(prompt));
    command.strip_suffix(&suffix).unwrap_or(command).to_owned()
}

/// Build a dedicated agent job without planner or implementation instructions.
///
/// # Errors
/// Fails for a non-agent terminal, briefing I/O, or a rejected policy check.
pub fn merge_agent_spec(
    project: &Project,
    terminal: &TerminalSpec,
    text: &str,
    dirs: Vec<PathBuf>,
    policy: &dyn Policy,
) -> Result<SessionSpec> {
    let mut spec = job_agent_spec(
        project,
        terminal,
        text,
        dirs,
        crate::model::MERGE_SCOPE,
        MERGE_PROMPT,
        BTreeMap::new(),
        policy,
    )?;
    spec.exclusive_cwd = true;
    Ok(spec)
}

/// Build an owned briefing and launch command for a review or merge job.
///
/// # Errors
/// Fails for an invalid scope or terminal, briefing I/O, or a rejected policy check.
#[allow(clippy::too_many_arguments)]
pub fn job_agent_spec(
    project: &Project,
    terminal: &TerminalSpec,
    text: &str,
    dirs: Vec<PathBuf>,
    scope: &str,
    prompt: &str,
    extra_env: BTreeMap<String, String>,
    policy: &dyn Policy,
) -> Result<SessionSpec> {
    anyhow::ensure!(
        matches!(
            scope,
            crate::model::MERGE_SCOPE | crate::model::REVIEW_SCOPE
        ),
        "Invalid job scope"
    );
    anyhow::ensure!(
        terminal.kind == TerminalKind::Agent,
        "Choose an agent preset"
    );
    anyhow::ensure!(
        !terminal.command.trim().is_empty(),
        "Choose an agent command"
    );
    // Each pending launch is immutable. Core transport removes it after dispatch;
    // the service retains an independent copy for conversation recovery.
    let file = context_file(
        &format!("{}-{}", scope.trim_start_matches('@'), uuid::Uuid::new_v4()),
        text,
    )?;
    let mut env = BTreeMap::from([
        (COMPONENT_ENV.into(), scope.into()),
        (CONTEXT_ENV.into(), file.display().to_string()),
    ]);
    env.extend(extra_env);
    let mut command = terminal.command.trim().to_string();
    let notice = brief_agent(
        &mut command,
        &Briefing {
            file: &file,
            text,
            dirs: &dirs,
            prompt: Some(prompt),
        },
        Shell::current(),
        &mut env,
    );
    let resume_command = job_resume_command(&command, prompt);
    let components = project.components.iter().collect::<Vec<_>>();
    if let Err(reason) = policy.check(Scope::Plan(&components), &command) {
        remove_owned_briefing_file(&file);
        return Err(anyhow!("blocked by policy: {reason}"));
    }
    Ok(SessionSpec {
        resume_command: Some(resume_command),
        owns_briefing: true,
        exclusive_cwd: false,
        merge_source: None,
        // Session service derives the identity from its project metadata.
        id: String::new(),
        command,
        cwd: PathBuf::from(&project.root),
        env,
        ready_when: String::new(),
        service: false,
        notice,
        dirs,
    })
}

/// Return the temporary briefing whose lifetime this session owns.
#[must_use]
pub fn owned_briefing(spec: &SessionSpec) -> Option<PathBuf> {
    spec.owns_briefing
        .then(|| spec.env.get(CONTEXT_ENV).map(PathBuf::from))
        .flatten()
}

/// Retain an independent briefing for an accepted session. Only the UUID filename changes,
/// preserving directory quoting and encoded shell arguments on every platform.
pub(crate) fn retain_owned_briefing(spec: &mut SessionSpec) -> Result<()> {
    let Some(pending) = owned_briefing(spec) else {
        return Ok(());
    };
    anyhow::ensure!(
        is_owned_briefing_file(&pending),
        "Invalid owned briefing path"
    );
    let text = std::fs::read_to_string(&pending)?;
    let prefix = pending
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .split('-')
        .next()
        .unwrap();
    let retained = context_file(&format!("{prefix}-{}", uuid::Uuid::new_v4()), &text)?;
    let old = pending.file_name().unwrap().to_str().unwrap();
    let new = retained.file_name().unwrap().to_str().unwrap();
    spec.command = spec.command.replace(old, new);
    if let Some(command) = &mut spec.resume_command {
        *command = command.replace(old, new);
    }
    for value in spec.env.values_mut() {
        *value = value.replace(old, new);
    }
    if let Some(notice) = &mut spec.notice {
        *notice = notice.replace(old, new);
    }
    Ok(())
}

/// Delete only files in the dedicated briefing namespace, never arbitrary env paths.
pub fn remove_owned_briefing_file(file: &Path) {
    if is_owned_briefing_file(file) {
        let _ = std::fs::remove_file(file);
    }
}

fn is_owned_briefing_file(file: &Path) -> bool {
    let dir = std::env::temp_dir().join("patchbay");
    file.parent() == Some(dir.as_path())
        && file
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| {
                s.strip_prefix("merge-")
                    .or_else(|| s.strip_prefix("review-"))
            })
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        && file.extension().is_some_and(|s| s == "md")
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
    root_session_spec(
        project,
        component_ids,
        terminal,
        task,
        policy,
        sections,
        true,
        None,
    )
}

/// [`plan_session_spec`] for an Auto planner, prompted to plan its goal at once.
/// The session id is the manual planner's, so either can be resumed.
///
/// # Errors
/// As [`plan_session_spec`], or if the terminal is not an agent.
pub fn plan_kickoff_spec(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    policy: &dyn Policy,
    sections: &[ContextSection],
) -> Result<SessionSpec> {
    anyhow::ensure!(
        terminal.kind == TerminalKind::Agent,
        "Choose an agent preset"
    );
    root_session_spec(
        project,
        component_ids,
        terminal,
        None,
        policy,
        sections,
        true,
        Some(Kickoff::Plan),
    )
}

/// A planner session: [`plan_kickoff_spec`] for a [`Kickoff::Plan`], else
/// [`plan_session_spec`].
///
/// # Errors
/// As those, or for a kickoff other than [`Kickoff::Plan`].
pub fn planner_spec(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    policy: &dyn Policy,
    sections: &[ContextSection],
    kickoff: Option<Kickoff>,
) -> Result<SessionSpec> {
    match kickoff {
        Some(Kickoff::Plan) => {
            plan_kickoff_spec(project, component_ids, terminal, policy, sections)
        }
        Some(_) => Err(anyhow!("Start implementation agents in Implementation")),
        None => plan_session_spec(project, component_ids, terminal, policy, sections),
    }
}

/// Root implementation and shell sessions, separate from all planner sessions.
/// A `kickoff` shapes an agent's briefing and gives it a first prompt. A fix
/// keeps its kickoff on every later start, so it resumes without that prompt
/// (`resume_command`), while a fresh start still gets it.
///
/// # Errors
/// As [`plan_session_spec`], or if a `kickoff` terminal is not an agent.
#[allow(clippy::too_many_arguments)]
pub fn task_root_session_spec(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    task: Option<&str>,
    policy: &dyn Policy,
    sections: &[ContextSection],
    kickoff: Option<Kickoff>,
) -> Result<SessionSpec> {
    anyhow::ensure!(
        kickoff.is_none() || terminal.kind == TerminalKind::Agent,
        "Choose an agent for implementation"
    );
    anyhow::ensure!(kickoff != Some(Kickoff::Plan), "Start planners in Plan");
    root_session_spec(
        project,
        component_ids,
        terminal,
        task,
        policy,
        sections,
        false,
        kickoff,
    )
}

/// Which review a root agent fixes.
pub enum Fix {
    /// The review the user chose to fix.
    Review(crate::reviews::Session),
    /// A former fix terminal started again, from the branch its record keeps, if
    /// the service still has that record.
    Again(Option<crate::reviews::Session>),
}

/// The kickoff and handoff sections a root agent of `task` starts with besides
/// its own task section: a fix's findings alone, else the shared plan and the
/// proposal for `selected`. A former fix terminal that can no longer fix (its
/// branch moved, or its findings are gone) starts plainly, with neither.
///
/// # Errors
/// As [`crate::reviews::handoff`] for [`Fix::Review`].
pub fn root_handoff(
    project: &Project,
    task: Option<&str>,
    selected: &[String],
    kickoff: Option<Kickoff>,
    fix: Option<&Fix>,
) -> Result<(Option<Kickoff>, Vec<ContextSection>)> {
    let root = Path::new(&project.root);
    let findings = match fix {
        Some(Fix::Review(review)) => Some(crate::reviews::handoff(root, review)?),
        Some(Fix::Again(review)) => review
            .as_ref()
            .and_then(|r| crate::reviews::handoff(root, r).ok()),
        None => {
            let plan = crate::plans::section(root, task);
            let proposal = crate::proposals::section(project, task, selected);
            return Ok((kickoff, plan.into_iter().chain(proposal).collect()));
        }
    };
    Ok(match findings {
        Some(section) => (Some(Kickoff::FixFindings), vec![section]),
        None => (None, Vec::new()),
    })
}

/// The first prompt of an Auto planner.
const PLAN_PROMPT: &str = "Plan the goal in the Auto mode section of your briefing. Write a nonempty plan to PATCHBAY_PLAN_FILE and propose component assignments using Patchbay. Finish the plan without implementing it.";

/// The first prompt of an agent started by Implement.
const IMPLEMENT_PROMPT: &str = "Implement the shared plan in your Patchbay briefing. Follow its requirements and applied assignments, run the relevant checks, and report the results.";
const FIX_FINDINGS_PROMPT: &str = "Address the review findings in your Patchbay briefing. Fix the ones that still apply; for any already resolved or that you disagree with, say why instead of changing code. Run the relevant checks and report each finding's outcome.";

#[allow(clippy::too_many_arguments)]
fn root_session_spec(
    project: &Project,
    component_ids: &[String],
    terminal: &TerminalSpec,
    task: Option<&str>,
    policy: &dyn Policy,
    sections: &[ContextSection],
    planning: bool,
    kickoff: Option<Kickoff>,
) -> Result<SessionSpec> {
    let scope = if planning {
        PLAN_SCOPE
    } else {
        TASK_ROOT_SCOPE
    };
    for id in component_ids {
        if project.component(id).is_none() {
            return Err(anyhow!("unknown component {id}"));
        }
    }
    let components = plan_components(project, component_ids);
    let mut env = BTreeMap::from([(
        COMPONENT_ENV.to_string(),
        if planning {
            "plan".into()
        } else {
            scope.into()
        },
    )]);
    let mut command = terminal.command.trim().to_string();
    let mut notice = None;
    let mut resume_command = None;
    let mut context_dirs: Vec<PathBuf> = Vec::new();
    if terminal.kind == TerminalKind::Agent {
        let briefing = if planning {
            plan_context(project, component_ids, sections)
        } else {
            implementation_context(project, component_ids, sections, kickoff)
        };
        let file = context_file(
            &briefing_name(project, &format!("{scope}-{}", terminal.id), task),
            &briefing,
        )?;
        env.insert(CONTEXT_ENV.into(), file.display().to_string());
        let dirs = &mut context_dirs;
        // Without a repo there is nowhere to keep the plan; the briefing still works.
        // The folder is always added: it sits under `.git`, which agents' sandboxes
        // (Codex's workspace-write) keep read-only unless it is a writable root itself.
        if planning
            && let Ok(plan) = crate::plans::prepared_file(&PathBuf::from(&project.root), task)
        {
            if let Some(dir) = plan.parent() {
                dirs.push(dir.to_path_buf());
            }
            env.insert(
                crate::plans::PLAN_FILE_ENV.into(),
                plan.display().to_string(),
            );
        }
        if !planning {
            dirs.extend(crate::plans::existing_dir(Path::new(&project.root)));
        }
        // cwd is the root; components in other repos must be added explicitly.
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
            prompt: kickoff.map(|k| match k {
                Kickoff::ImplementPlan => IMPLEMENT_PROMPT,
                Kickoff::FixFindings => FIX_FINDINGS_PROMPT,
                Kickoff::Plan => PLAN_PROMPT,
            }),
        };
        notice = brief_agent(&mut command, &briefing, Shell::current(), &mut env);
        // A fix and an Auto planner pass their kickoff again on Restart, so their resume
        // command stays the same across starts and a resumed conversation isn't prompted
        // again; an implement restart keeps resuming as before.
        match kickoff {
            Some(Kickoff::FixFindings) => {
                resume_command = Some(job_resume_command(&command, FIX_FINDINGS_PROMPT));
            }
            Some(Kickoff::Plan) => {
                resume_command = Some(job_resume_command(&command, PLAN_PROMPT));
            }
            _ => {}
        }
    }
    policy
        .check(Scope::Plan(&components), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;
    Ok(SessionSpec {
        resume_command,
        owns_briefing: false,
        exclusive_cwd: false,
        merge_source: None,
        id: task_session_id(&project.root, scope, &terminal.id, task),
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
    session_spec_with(
        project,
        component_id,
        terminal_id,
        task,
        policy,
        sections,
        &[],
    )
}

/// [`session_spec_for`], also handing an agent `extra_dirs` beside its
/// neighbours' folders (the folders its briefing names, such as peers being
/// changed alongside it or the plans folder). Other terminals ignore them.
///
/// # Errors
/// As [`session_spec`].
pub fn session_spec_with(
    project: &Project,
    component_id: &str,
    terminal_id: &str,
    task: Option<&str>,
    policy: &dyn Policy,
    sections: &[ContextSection],
    extra_dirs: &[PathBuf],
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
        for dir in extra_dirs {
            if !context_dirs.contains(dir) {
                context_dirs.push(dir.clone());
            }
        }
        let briefing = Briefing {
            file: &file,
            text: &briefing,
            dirs: &context_dirs,
            prompt: None,
        };
        notice = brief_agent(&mut command, &briefing, Shell::current(), &mut env);
    }

    policy
        .check(Scope::Component(component), &command)
        .map_err(|reason| anyhow!("blocked by policy: {reason}"))?;

    Ok(SessionSpec {
        resume_command: None,
        owns_briefing: false,
        exclusive_cwd: false,
        merge_source: None,
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
    #[test]
    fn auto_brief_contains_goal_scope_effort_and_optional_commit() {
        let auto = super::AutoBrief {
            goal: "Make widgets work".into(),
            fix_floor: Some(crate::reviews::Severity::High),
            effort_note: "Targeted changes".into(),
            commit: true,
        };
        let text = auto.markdown("fix");
        for expected in [
            "## Auto mode",
            "Make widgets work",
            "Stage: fix",
            "≥ high",
            "leave lower ones listed",
            "Targeted changes",
            "Commit your work",
            "unless blocked",
        ] {
            assert!(text.contains(expected), "{expected}");
        }
        let auto = super::AutoBrief {
            commit: false,
            fix_floor: None,
            ..auto
        };
        assert!(!auto.markdown("review").contains("Commit your work"));
        assert!(!auto.markdown("review").contains("Fix findings"));
        // A root agent's stage follows its settled kickoff; a planner plans.
        let stage = |s: super::ContextSection| s.body.lines().nth(2).unwrap_or_default().to_owned();
        assert_eq!(
            stage(auto.root_section(Some(super::Kickoff::FixFindings))),
            "Stage: fix"
        );
        assert_eq!(
            stage(auto.root_section(Some(super::Kickoff::ImplementPlan))),
            "Stage: implement"
        );
        assert_eq!(stage(auto.root_section(None)), "Stage: implement");
        assert_eq!(stage(auto.plan_section()), "Stage: plan");
    }

    use super::*;

    #[test]
    fn agent_commands_are_spelled_for_the_agents_shell() {
        let unix = implementation_actions(Shell::Unix);
        assert!(unix.contains("`\"$PATCHBAY_CLI\" agent validate <componentId>`"));
        let windows = implementation_actions(Shell::Windows);
        assert!(windows.contains("`& $env:PATCHBAY_CLI agent validate <componentId>`"));
        assert!(windows.contains("`\"%PATCHBAY_CLI%\" agent validate <componentId>`"));
        assert!(!windows.contains("\"$PATCHBAY_CLI\""));
        // No bare `agent …` invocation: there is no `agent` program on PATH.
        for args in [
            "environment start <groupId>",
            "environment stop <groupId>",
            "context`",
            "status`",
            "logs <sessionId>",
        ] {
            assert!(
                unix.contains(&format!("\"$PATCHBAY_CLI\" agent {args}")),
                "{args}"
            );
        }
        assert!(!unix.contains(" with agent "));
    }
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
            detection: None,
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
                detection: None,
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
        assert!(!spec.command.contains("--settings"));
    }

    #[test]
    fn claude_keeps_the_users_own_settings() {
        let briefing = Briefing {
            file: Path::new("/tmp/ctx.md"),
            text: "",
            dirs: &[],
            prompt: None,
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
            detection: None,
            id: "l2".into(),
            source: "web".into(),
            target: "api".into(),
            label: Some("calls".into()),
        });
        p.links.push(Link {
            detection: None,
            id: "l3".into(),
            source: "web".into(),
            target: "db".into(),
            label: None,
        });
        let text = plan_context(&p, &["web".into(), "api".into(), "api".into()], &[]);
        let (scope, nearby) = text.split_once("## Nearby components").unwrap();
        assert!(scope.contains("**API** (ID: `api`, Backend) at `/repo/services/api` — api notes"));
        assert!(scope.contains("**WEB** depends on **API** — calls"));
        assert!(!scope.contains("**DB**"));
        assert!(!text.contains("UNRELATED"));
        assert_eq!(nearby.matches("**DB**").count(), 1);
        assert!(text.contains("don't edit project files unless asked"));
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
    fn both_root_providers_receive_selected_scope_without_planner_instructions() {
        let p = project();
        for provider in ["claude", "codex"] {
            let mut terminal = planner();
            terminal.id = provider.into();
            terminal.command = provider.into();
            let spec = task_root_session_spec(
                &p,
                &["api".into()],
                &terminal,
                Some("t1"),
                &AllowAll,
                &[ContextSection {
                    title: "Applied assignments".into(),
                    body: "api: Fix login".into(),
                }],
                None,
            )
            .unwrap();
            assert_eq!(
                spec.id,
                crate::model::task_session_id(&p.root, TASK_ROOT_SCOPE, provider, Some("t1"))
            );
            assert_eq!(spec.cwd, PathBuf::from(&p.root));
            let text = std::fs::read_to_string(&spec.env[CONTEXT_ENV]).unwrap();
            assert!(text.contains("ID: `api`") && text.contains("Fix login"));
            assert!(text.contains("agent validate <componentId>"));
            assert!(!text.contains("You are planning") && !text.contains("agent propose"));
            assert!(!spec.env.contains_key(crate::plans::PLAN_FILE_ENV));
            assert!(spec.command.contains(if provider == "claude" {
                "--append-system-prompt-file"
            } else {
                "developer_instructions="
            }));
        }
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
    fn peers_section_lists_other_peers_and_their_links() {
        let p = project();
        let section = peers_section(&p, "api", &["api".into(), "db".into(), "x".into()]).unwrap();
        assert_eq!(section.title, "Working alongside");
        assert!(section.body.contains("**DB**"));
        assert!(!section.body.contains("**API**"));
        assert!(section.body.contains("this component depends on it"));
        let reverse = peers_section(&p, "db", &["api".into()]).unwrap();
        assert!(reverse.body.contains("it depends on this component"));
        assert!(peers_section(&p, "api", &["api".into()]).is_none());
        assert!(peers_section(&p, "api", &[]).is_none());
    }

    #[test]
    fn agents_get_extra_dirs_once() {
        let p = project();
        let peer = PathBuf::from("/shared/peer");
        let extra = [peer.clone(), peer.clone()];
        let spec = session_spec_with(&p, "api", "agent", None, &AllowAll, &[], &extra).unwrap();
        assert_eq!(spec.dirs.iter().filter(|d| **d == peer).count(), 1);
        let plain = session_spec_for(&p, "api", "agent", None, &AllowAll, &[]).unwrap();
        assert!(!plain.dirs.contains(&peer));
    }

    #[test]
    fn planner_is_told_where_to_write_the_plan() {
        let root = std::env::temp_dir().join(format!("patchbay-plan-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let git = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-q"])
            .output();
        if !git.is_ok_and(|o| o.status.success()) {
            return;
        }
        let mut p = project();
        p.root = root.canonicalize().unwrap().display().to_string();
        let spec = plan_session_spec(&p, &[], &planner(), &AllowAll, &[]).unwrap();
        let plans = crate::plans::dir(Path::new(&p.root)).unwrap();
        assert_eq!(
            spec.env[crate::plans::PLAN_FILE_ENV],
            plans.join("main.md").display().to_string()
        );
        // The folder exists before the first plan and is handed to the agent.
        assert!(spec.dirs.contains(&plans));
        let task = plan_session_spec_for(&p, &[], &planner(), Some("t1"), &AllowAll, &[]).unwrap();
        assert!(task.env[crate::plans::PLAN_FILE_ENV].ends_with("t1.md"));
        let context = plan_context(&p, &[], &[]);
        assert!(context.contains("$PATCHBAY_PLAN_FILE"));
        assert!(context.contains("Do not wait for the user to request a save"));
        // Outside a repo nothing names the file, so the briefing doesn't ask for it.
        assert!(!plan_context(&project(), &[], &[]).contains("$PATCHBAY_PLAN_FILE"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn implementation_starts_with_a_task_prompt_without_changing_planner_launches() {
        for provider in ["claude", "codex"] {
            let mut terminal = planner();
            terminal.command = provider.into();
            let sections = [ContextSection {
                title: "Shared plan".into(),
                body: "Fix login".into(),
            }];
            let spec = task_root_session_spec(
                &project(),
                &[],
                &terminal,
                None,
                &AllowAll,
                &sections,
                Some(Kickoff::ImplementPlan),
            )
            .unwrap();
            assert!(spec.command.contains("Implement the shared plan"));
            let briefing = std::fs::read_to_string(&spec.env[CONTEXT_ENV]).unwrap();
            assert!(briefing.contains("Fix login"));
            assert!(!briefing.contains("You are planning, not implementing"));
            let planner = plan_session_spec(&project(), &[], &terminal, &AllowAll, &[]).unwrap();
            assert!(!planner.command.contains("Implement the shared plan"));
        }
        // The prompt follows the briefing: an env-prefixed agent gets it, a command left
        // unchanged doesn't.
        for (command, prompted) in [("env FOO=1 claude", true), ("codex exec inspect", false)] {
            let mut terminal = planner();
            terminal.command = command.into();
            let spec = task_root_session_spec(
                &project(),
                &[],
                &terminal,
                None,
                &AllowAll,
                &[],
                Some(Kickoff::ImplementPlan),
            )
            .unwrap();
            assert_eq!(
                spec.command.contains("Implement the shared plan"),
                prompted,
                "{command}"
            );
        }
    }

    #[test]
    fn auto_planner_kickoff_has_its_prompt_and_keeps_the_manual_id() {
        for command in ["claude", "codex"] {
            let mut terminal = planner();
            terminal.command = command.into();
            let sections = [AutoBrief {
                goal: "Plan a change".into(),
                fix_floor: None,
                effort_note: "Add tests".into(),
                commit: false,
            }
            .section("plan")];
            let manual = plan_session_spec(&project(), &[], &terminal, &AllowAll, &[]).unwrap();
            let auto = plan_kickoff_spec(&project(), &[], &terminal, &AllowAll, &sections).unwrap();
            assert_eq!(auto.id, manual.id);
            let words = command_tokens(&auto.command, Shell::current()).unwrap();
            assert_eq!(words.last().unwrap(), PLAN_PROMPT);
            assert!(!manual.command.contains(PLAN_PROMPT));
            // A resumed planner isn't prompted to plan again.
            let resume = auto.resume_command.as_deref().unwrap();
            assert!(!resume.contains(PLAN_PROMPT), "{resume}");
            assert!(manual.resume_command.is_none());
            let root = task_root_session_spec(
                &project(),
                &[],
                &terminal,
                None,
                &AllowAll,
                &[],
                Some(Kickoff::Plan),
            );
            assert!(root.is_err());
        }
    }

    #[test]
    fn fix_findings_starts_with_its_prompt_and_review_instructions() {
        for provider in ["claude", "codex"] {
            let mut terminal = planner();
            terminal.command = provider.into();
            let sections = [ContextSection {
                title: "Review findings".into(),
                body: "Fix login".into(),
            }];
            let spec = task_root_session_spec(
                &project(),
                &[],
                &terminal,
                None,
                &AllowAll,
                &sections,
                Some(Kickoff::FixFindings),
            )
            .unwrap();
            let words = command_tokens(&spec.command, Shell::current()).unwrap();
            assert_eq!(words.last().unwrap(), FIX_FINDINGS_PROMPT);
            assert!(!words.iter().any(|word| word == IMPLEMENT_PROMPT));
            let briefing = std::fs::read_to_string(&spec.env[CONTEXT_ENV]).unwrap();
            assert!(briefing.contains("addressing the review findings below"));
            assert!(briefing.contains("## Review findings\n\nFix login"));
            assert!(!briefing.contains("using the saved plan"));
            // A resumed fix isn't prompted to start over; a fresh start is.
            let resume = spec.resume_command.as_deref().unwrap();
            assert!(!resume.contains(FIX_FINDINGS_PROMPT));
            assert!(spec.command.starts_with(resume));
        }
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
        Briefing {
            file,
            text,
            dirs,
            prompt: None,
        }
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
    fn status_provider_uses_briefing_detection_and_explicit_adapters() {
        let mut terminal = planner();
        for (command, expected) in [
            (
                "/opt/homebrew/bin/claude",
                Some(crate::adapters::Adapter::Claude),
            ),
            ("env FOO=1 codex", Some(crate::adapters::Adapter::Codex)),
            ("FOO=1 claude", Some(crate::adapters::Adapter::Claude)),
            ("echo codex", None),
            ("codex && echo done", None),
        ] {
            terminal.command = command.into();
            terminal.adapter = None;
            assert_eq!(agent_provider(&terminal), expected, "{command}");
        }
        terminal.adapter = Some(crate::adapters::Adapter::Claude);
        assert_eq!(
            agent_provider(&terminal),
            Some(crate::adapters::Adapter::Claude)
        );
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
    fn retained_merge_briefings_rewrite_launch_resume_and_shell_paths() {
        for command in ["claude", "codex", "custom-agent"] {
            let text = "a".repeat(130 * 1024); // Also exercise Codex's file-pointer fallback.
            let mut terminal = project().components[0].terminals[0].clone();
            terminal.command = command.into();
            let mut spec =
                merge_agent_spec(&project(), &terminal, &text, vec![], &AllowAll).unwrap();
            let pending = owned_briefing(&spec).unwrap();
            let old = pending.file_name().unwrap().to_str().unwrap();
            // Windows may store a quoted path in a private argument variable.
            spec.env
                .insert("PATCHBAY_ARGUMENT_TEST".into(), format!("quoted-{old}"));
            retain_owned_briefing(&mut spec).unwrap();
            let retained = owned_briefing(&spec).unwrap();
            assert_ne!(pending, retained);
            assert!(pending.exists());
            assert_eq!(std::fs::read_to_string(&retained).unwrap(), text);
            assert!(!spec.command.contains(old));
            assert!(!spec.resume_command.as_ref().unwrap().contains(old));
            assert!(spec.env.values().all(|v| !v.contains(old)));
            assert!(spec.notice.as_ref().is_none_or(|n| !n.contains(old)));
            if command == "claude" {
                assert!(
                    spec.command
                        .contains(retained.file_name().unwrap().to_str().unwrap())
                );
            }
            remove_owned_briefing_file(&pending);
            remove_owned_briefing_file(&retained);
        }
    }

    #[test]
    fn merge_briefing_cleanup_never_deletes_arbitrary_files() {
        let mut spec = merge_agent_spec(
            &project(),
            &project().components[0].terminals[0],
            "merge",
            vec![],
            &AllowAll,
        )
        .unwrap();
        let file = PathBuf::from(&spec.env[CONTEXT_ENV]);
        spec.owns_briefing = false;
        assert!(owned_briefing(&spec).is_none());
        assert!(file.exists());
        spec.owns_briefing = true;
        remove_owned_briefing_file(&owned_briefing(&spec).unwrap());
        assert!(!file.exists());
        let unrelated = std::env::temp_dir().join(format!("unrelated-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&unrelated, "keep").unwrap();
        spec.env
            .insert(CONTEXT_ENV.into(), unrelated.to_string_lossy().into());
        remove_owned_briefing_file(&owned_briefing(&spec).unwrap());
        assert!(unrelated.exists());
        std::fs::remove_file(unrelated).unwrap();
    }

    #[test]
    fn codex_counts_the_initial_prompt_before_selecting_inline_instructions() {
        for (shell, budget, file) in [
            (
                Shell::Windows,
                CMD_BUDGET,
                Path::new(r"C:\Temp\briefing.md"),
            ),
            (Shell::Unix, SHELL_ARG_BUDGET, Path::new("/tmp/briefing.md")),
        ] {
            let text = "x".repeat(budget - 200);
            let mut without_prompt = "codex".to_owned();
            assert!(decorate_agent(
                &mut without_prompt,
                Agent::Codex,
                &briefing(file, &text, &[]),
                None,
                shell,
                &mut BTreeMap::new()
            ));
            let prompt = "p".repeat(250);
            let with_prompt = Briefing {
                file,
                text: &text,
                dirs: &[],
                prompt: Some(&prompt),
            };
            let mut command = "codex".to_owned();
            assert!(!decorate_agent(
                &mut command,
                Agent::Codex,
                &with_prompt,
                None,
                shell,
                &mut BTreeMap::new()
            ));
            assert!(command.contains("read it before starting"));
            assert!(command.contains(&prompt));
            assert!(command.len() < budget);
        }
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
                resume_command: None,
                owns_briefing: false,
                exclusive_cwd: false,
                merge_source: None,
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
