//! A local stack a detection agent proposes: which terminals start the project's
//! servers, what each prints once ready, and whether dependencies start first. Like
//! link proposals it is an artifact the user reviews, never an edit to `patchbay.json`.
use crate::context;
use crate::model::{MAP_SCOPE, Project, TerminalAction, TerminalKind, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

static SUBMISSIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The stack detection terminal, beside dependency detection at `MAP_SCOPE`.
pub const STACK_TERMINAL: &str = "stack";
pub const MAX_TERMINALS: usize = 50;
pub const NAME_LIMIT: usize = 60;
pub const COMMAND_LIMIT: usize = 1000;
pub const READY_LIMIT: usize = 200;
pub const REASON_LIMIT: usize = 1000;
const PROMPT: &str = "Work out the local stack described in your Patchbay briefing and submit it with propose-stack.";

/// One terminal of the stack: an existing one by `terminal`, or a new one with
/// `name` and `command`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedTerminal {
    pub component: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub ready_when: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StackProposal {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub ordered_startup: bool,
    pub terminals: Vec<ProposedTerminal>,
}

/// A submission awaiting review. `id` is unique per submission, so clearing one
/// never removes a newer one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub session_id: String,
    pub submitted_ms: u64,
    pub name: String,
    pub ordered_startup: bool,
    pub terminals: Vec<ProposedTerminal>,
}

fn one_line(text: &str, limit: usize) -> bool {
    !text.contains(['\n', '\r']) && text.trim().chars().count() <= limit
}

impl StackProposal {
    /// Check against the readable map: known components and task terminals (never
    /// Validation ones, which applying would turn into Development), new
    /// terminals with a name and command, no repeats, and bounded single-line text
    /// with a reason. Errors name the entry.
    ///
    /// # Errors
    /// Fails for another version, no terminals or too many, or an invalid entry.
    pub fn validate(&self, project: &Project) -> Result<()> {
        ensure!(self.version == 1, "Unsupported proposal version");
        ensure!(
            !self.name.trim().is_empty() && one_line(&self.name, NAME_LIMIT),
            "Name the stack in one line of at most {NAME_LIMIT} characters"
        );
        ensure!(!self.terminals.is_empty(), "The proposal needs terminals");
        ensure!(
            self.terminals.len() <= MAX_TERMINALS,
            "Propose at most {MAX_TERMINALS} terminals"
        );
        let mut seen = HashSet::new();
        for (n, t) in self.terminals.iter().enumerate() {
            let label = t.terminal.as_deref().or(t.name.as_deref()).unwrap_or("?");
            let at = format!("Terminal {} ({} › {label})", n + 1, t.component);
            let Some(component) = project.component(&t.component) else {
                anyhow::bail!("{at}: unknown component {}", t.component);
            };
            match (&t.terminal, &t.name, &t.command) {
                (Some(id), None, None) => {
                    let existing = component.terminals.iter().find(|x| &x.id == id);
                    ensure!(existing.is_some(), "{at}: unknown terminal {id}");
                    ensure!(
                        existing.is_some_and(|x| x.kind == TerminalKind::Task),
                        "{at}: only task terminals can join a stack"
                    );
                    // Applying makes it Development, which would silently drop its validator role.
                    ensure!(
                        existing.is_some_and(|x| x.action != Some(TerminalAction::Validation)),
                        "{at}: {id} is a Validation terminal; propose a new terminal instead"
                    );
                }
                (None, Some(name), Some(command)) => {
                    ensure!(
                        !name.trim().is_empty() && one_line(name, NAME_LIMIT),
                        "{at}: names are one line of at most {NAME_LIMIT} characters"
                    );
                    ensure!(
                        !command.trim().is_empty() && one_line(command, COMMAND_LIMIT),
                        "{at}: commands are one line of at most {COMMAND_LIMIT} characters"
                    );
                }
                _ => anyhow::bail!(
                    "{at}: give either an existing terminal id, or a name and command for a new one"
                ),
            }
            ensure!(
                seen.insert((&t.component, label.trim().to_lowercase())),
                "{at}: repeated terminal"
            );
            ensure!(
                one_line(&t.ready_when, READY_LIMIT),
                "{at}: ready text is one line of at most {READY_LIMIT} characters"
            );
            ensure!(!t.reason.trim().is_empty(), "{at}: give a reason");
            ensure!(
                t.reason.chars().count() <= REASON_LIMIT,
                "{at}: the reason is longer than {REASON_LIMIT} characters"
            );
        }
        Ok(())
    }
}

fn store() -> Result<PathBuf> {
    Ok(crate::workspace::home()?.join("stack-proposals"))
}

/// One file per project root, kept with Patchbay's state so it works outside Git
/// and is never committed.
fn file(store: &Path, root: &str) -> PathBuf {
    store.join(format!(
        "{}.json",
        crate::workspace::session_id("stack-proposals", "", root)
    ))
}

fn trimmed(text: Option<String>) -> Option<String> {
    text.map(|s| s.trim().to_string())
}

fn submit_in(
    store: &Path,
    project: &Project,
    session: &str,
    proposal: &StackProposal,
    now_ms: u64,
) -> Result<Pending> {
    let _guard = SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    proposal.validate(project)?;
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session.into(),
        submitted_ms: now_ms,
        name: proposal.name.trim().into(),
        ordered_startup: proposal.ordered_startup,
        terminals: proposal
            .terminals
            .iter()
            .cloned()
            .map(|t| ProposedTerminal {
                terminal: trimmed(t.terminal),
                name: trimmed(t.name),
                command: trimmed(t.command),
                ready_when: t.ready_when.trim().into(),
                reason: t.reason.trim().into(),
                ..t
            })
            .collect(),
    };
    crate::workspace::atomic_write(
        &file(store, &project.root),
        &serde_json::to_vec_pretty(&pending)?,
    )?;
    Ok(pending)
}

fn read_in(store: &Path, root: &str) -> Result<Option<Pending>> {
    match std::fs::read(file(store, root)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn clear_in(store: &Path, root: &str, id: &str) -> Result<bool> {
    let _guard = SUBMISSIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A newer submission arrived while the user reviewed this one; keep it.
    if read_in(store, root)?.is_none_or(|p| p.id != id) {
        return Ok(false);
    }
    std::fs::remove_file(file(store, root))?;
    Ok(true)
}

/// Save an agent's proposal for review, replacing any earlier one.
///
/// # Errors
/// Fails if the proposal is invalid for `project` or can't be saved.
pub fn submit(project: &Project, session: &str, proposal: &StackProposal) -> Result<Pending> {
    submit_in(&store()?, project, session, proposal, crate::pty::now_ms())
}

/// The proposal awaiting review for the project at `root`.
///
/// # Errors
/// Fails if the file can't be read or parsed.
pub fn read(root: &str) -> Result<Option<Pending>> {
    read_in(&store()?, root)
}

/// Forget the reviewed proposal `id`, unless a newer one has replaced it.
///
/// # Errors
/// Fails if the file can't be read or removed.
pub fn clear(root: &str, id: &str) -> Result<bool> {
    clear_in(&store()?, root, id)
}

fn describe(t: &TerminalSpec) -> String {
    let kind = match t.kind {
        TerminalKind::Shell => "shell",
        TerminalKind::Task => "task",
        TerminalKind::Agent => "agent",
    };
    let role = match t.action {
        Some(TerminalAction::Development) => ", Development",
        Some(TerminalAction::Validation) => ", Validation",
        None => "",
    };
    let ready = if t.ready_when.is_empty() {
        String::new()
    } else {
        format!(", ready when `{}`", t.ready_when)
    };
    format!(
        "  - `{}`: {} ({kind}{role}{ready}){}",
        t.id,
        t.name,
        if t.command.is_empty() {
            String::new()
        } else {
            format!(": `{}`", t.command)
        }
    )
}

/// The detection agent's briefing: components with their terminals, the
/// dependencies and stacks already on the map, and how to submit.
#[must_use]
pub fn stack_context(project: &Project) -> String {
    let mut out = format!(
        "# Patchbay stack detection\n\nProject: {}\nRoot: {}\n\n## Components and their terminals\n\n",
        project.name, project.root
    );
    for c in &project.components {
        let _ = writeln!(
            out,
            "- `{}`: {} ({:?}) at `{}`",
            c.id, c.name, c.kind, c.path
        );
        if c.terminals.is_empty() {
            out.push_str("  - no terminals\n");
        }
        for t in &c.terminals {
            let _ = writeln!(out, "{}", describe(t));
        }
    }
    out.push_str("\n## Dependencies (`source → target`: source depends on target)\n\n");
    if project.links.is_empty() {
        out.push_str("None.\n");
    }
    for l in &project.links {
        let _ = writeln!(out, "- `{}` → `{}`", l.source, l.target);
    }
    out.push_str("\n## Stacks already on the map\n\n");
    if project.groups.is_empty() {
        out.push_str("None.\n");
    }
    for g in &project.groups {
        let _ = writeln!(out, "- {}: {}", g.name, g.component_ids.join(", "));
    }
    let _ = write!(
        out,
        "\n## Task\n\nWork out how a developer runs this project locally: the long-running \
         processes that must be up together, such as databases and queues (often in \
         docker-compose files), API servers, workers and web or mobile dev servers. Read \
         README files, package scripts, Makefiles, Procfiles, docker-compose files and \
         framework configuration. Prefer an existing task terminal that isn't a Validation \
         one; propose a new one (with a name and a one-line command run from the component's \
         folder) only when none fits. \
         Leave out tests, builds, linters and one-off scripts.\n\n\
         For each terminal give `readyWhen`: text the process prints once it accepts \
         connections (matched case-insensitively, such as `ready to accept connections` or \
         `Listening on`), or an empty string when you can't tell. Set `orderedStartup` when \
         some members depend on others, so dependencies start first and each waits until \
         ready.\n\n\
         Only read; don't edit project files, install anything or start servers. Use only the \
         component and terminal ids above. Give each terminal a reason with file:line evidence.\n\n\
         Submit JSON {{\"version\":1,\"name\":\"Local stack\",\"orderedStartup\":true,\
         \"terminals\":[{{\"component\":\"api\",\"terminal\":\"dev\",\"readyWhen\":\"Listening on\",\
         \"reason\":\"api/package.json:7 runs the server\"}},{{\"component\":\"api\",\"name\":\"Postgres\",\
         \"command\":\"docker compose up db\",\"readyWhen\":\"ready to accept connections\",\
         \"reason\":\"docker-compose.yml:3 defines the database\"}}]}} by piping it to {} on \
         standard input; don't write it to a file. Submitting again replaces the earlier \
         proposal. The user reviews the stack before anything changes on the map.\n",
        context::agent_command("propose-stack --file -")
    );
    out
}

/// The stack detection terminal and its launch for `preset`, at the project root.
///
/// # Errors
/// Fails for a preset that isn't an agent, briefing I/O, or a rejected policy check.
pub fn prepare(
    project: &Project,
    preset: &TerminalSpec,
    policy: &dyn Policy,
) -> Result<(TerminalSpec, SessionSpec)> {
    let mut terminal = preset.clone();
    terminal.id = STACK_TERMINAL.into();
    terminal.name = format!("Detect stack · {}", preset.name);
    let spec = context::job_agent_spec(
        project,
        &terminal,
        &stack_context(project),
        project.external_dirs(),
        MAP_SCOPE,
        PROMPT,
        BTreeMap::new(),
        policy,
    )?;
    Ok((terminal, spec))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> Project {
        serde_json::from_value(json!({
            "schemaVersion": 4, "name": "shop", "root": "/tmp/shop",
            "components": [
                {"id":"api","name":"API","kind":"backend","path":"api","terminals":[
                    {"id":"dev","name":"Dev","kind":"task","command":"npm run dev"},
                    {"id":"test","name":"Test","kind":"task","command":"npm test","action":"validation"},
                    {"id":"agent","name":"Claude","kind":"agent","command":"claude"}
                ]},
                {"id":"web","name":"Web","kind":"frontend","path":"web","terminals":[]}
            ],
            "links": [{"id":"web->api","source":"web","target":"api"}],
            "groups": [{"id":"g","name":"Old","componentIds":["api"]}]
        }))
        .unwrap()
    }
    fn proposal(terminals: serde_json::Value) -> StackProposal {
        serde_json::from_value(
            json!({"version":1,"name":"Local stack","orderedStartup":true,"terminals":terminals}),
        )
        .unwrap()
    }

    #[test]
    fn validation_names_the_offending_entry() {
        let p = project();
        let existing = json!({"component":"api","terminal":"dev","readyWhen":"Listening","reason":"api/package.json:3"});
        let new = json!({"component":"web","name":"Vite","command":"npx vite","reason":"web/vite.config.ts:1"});
        assert!(proposal(json!([existing, new])).validate(&p).is_ok());
        for (terminals, error) in [
            (json!([]), "needs terminals"),
            (
                json!([{"component":"db","terminal":"dev","reason":"x"}]),
                "unknown component db",
            ),
            (
                json!([{"component":"api","terminal":"nope","reason":"x"}]),
                "unknown terminal nope",
            ),
            (
                json!([{"component":"api","terminal":"agent","reason":"x"}]),
                "only task terminals",
            ),
            (
                json!([{"component":"api","terminal":"test","reason":"x"}]),
                "test is a Validation terminal",
            ),
            (
                json!([{"component":"web","name":"Vite","reason":"x"}]),
                "either an existing terminal id",
            ),
            (
                json!([{"component":"api","terminal":"dev","name":"Dev","command":"x","reason":"x"}]),
                "either an existing terminal id",
            ),
            (
                json!([{"component":"web","name":"Vite","command":"a\nb","reason":"x"}]),
                "commands are one line",
            ),
            (
                json!([existing, existing]),
                "Terminal 2 (api › dev): repeated",
            ),
            (
                json!([{"component":"api","terminal":"dev","readyWhen":"a\nb","reason":"x"}]),
                "ready text",
            ),
            (
                json!([{"component":"api","terminal":"dev","reason":" "}]),
                "give a reason",
            ),
        ] {
            let err = proposal(terminals).validate(&p).unwrap_err().to_string();
            assert!(err.contains(error), "{err}");
        }
        let mut unnamed = proposal(json!([existing]));
        unnamed.name = " ".into();
        assert!(unnamed.validate(&p).is_err());
        let mut v2 = proposal(json!([existing]));
        v2.version = 2;
        assert!(v2.validate(&p).is_err());
        assert!(
            serde_json::from_value::<StackProposal>(
                json!({"version":1,"name":"x","terminals":[],"extra":1})
            )
            .is_err()
        );
    }

    #[test]
    fn submissions_are_trimmed_and_clear_only_themselves() {
        let store = std::env::temp_dir().join(format!("patchbay-stack-{}", uuid::Uuid::new_v4()));
        let p = project();
        let terminals = json!([
            {"component":"web","name":" Vite ","command":" npx vite ","readyWhen":" ready in ","reason":" web/vite.config.ts:1 "}
        ]);
        let first = submit_in(&store, &p, "s-1", &proposal(terminals.clone()), 10).unwrap();
        assert_eq!(first.terminals[0].name.as_deref(), Some("Vite"));
        assert_eq!(first.terminals[0].command.as_deref(), Some("npx vite"));
        assert_eq!(first.terminals[0].ready_when, "ready in");
        assert!(first.ordered_startup);
        assert_eq!(read_in(&store, &p.root).unwrap().as_ref(), Some(&first));
        let second = submit_in(&store, &p, "s-1", &proposal(terminals), 10).unwrap();
        assert_ne!(first.id, second.id);
        assert!(
            !clear_in(&store, &p.root, &first.id).unwrap(),
            "a newer submission stays"
        );
        assert!(clear_in(&store, &p.root, &second.id).unwrap());
        assert_eq!(read_in(&store, &p.root).unwrap(), None);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn briefing_lists_terminals_stacks_and_the_submit_command() {
        let text = stack_context(&project());
        assert!(text.contains("- `dev`: Dev (task): `npm run dev`"));
        assert!(text.contains("- `web` → `api`"));
        assert!(text.contains("- Old: api"));
        assert!(text.contains("agent propose-stack --file -"));
    }
}
