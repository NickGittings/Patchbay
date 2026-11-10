//! A local stack a detection agent proposes: which terminals start the project's
//! servers, what each prints once ready, and whether dependencies start first. Like
//! link proposals it is an artifact the user reviews, never an edit to `patchbay.json`.
use crate::context;
use crate::model::{MAP_SCOPE, Project, TerminalAction, TerminalKind, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use crate::submissions::{Store, Submission};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

/// Submissions awaiting review, one per project root under `~/.patchbay/stack-proposals/`.
static SUBMISSIONS: Store = Store::new("stack-proposals");

/// The stack detection terminal, beside dependency detection at `MAP_SCOPE`.
pub const STACK_TERMINAL: &str = "stack";
/// The replacement target retained privately with the detection session.
pub const TARGET_ENV: &str = "PATCHBAY_STACK_TARGET";
pub const MAX_TERMINALS: usize = 50;
pub const NAME_LIMIT: usize = 60;
pub const COMMAND_LIMIT: usize = 1000;
pub const READY_LIMIT: usize = 200;
pub const REASON_LIMIT: usize = 1000;
const PROMPT: &str = "Work out the local stack described in your Patchbay briefing and submit it with propose-stack.";

/// One terminal of the stack: an existing one by `terminal`, optionally replacing
/// its `command`, or a new one with `name` and `command`.
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

/// One-time preparation at each new worktree root, separate from service startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedSetup {
    pub command: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StackProposal {
    pub version: u32,
    pub name: String,
    /// Stable id of the stack to replace; omitted by older, additive proposals.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_id: Option<String>,
    #[serde(default)]
    pub ordered_startup: bool,
    pub terminals: Vec<ProposedTerminal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<ProposedSetup>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_id: Option<String>,
    pub ordered_startup: bool,
    pub terminals: Vec<ProposedTerminal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<ProposedSetup>,
}

impl Submission for Pending {
    fn id(&self) -> &str {
        &self.id
    }
}

/// A terminal name compared ignoring case and spacing, as the frontend's `sameName` does, so
/// `Dev  Server` is `dev server`.
fn name_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn one_line(text: &str, limit: usize) -> bool {
    !text.contains(['\n', '\r']) && text.trim().chars().count() <= limit
}

impl StackProposal {
    /// Check against the readable map: known components and task terminals (never
    /// Validation ones, which applying would turn into Development), new
    /// terminals with a name and command that no terminal of the component already
    /// has, no repeats, and bounded single-line text with a reason. Errors name the
    /// entry.
    ///
    /// # Errors
    /// Fails for another version, no terminals or too many, or an invalid entry.
    pub fn validate(&self, project: &Project) -> Result<()> {
        ensure!(self.version == 1, "Unsupported proposal version");
        ensure!(
            !self.name.trim().is_empty() && one_line(&self.name, NAME_LIMIT),
            "Name the stack in one line of at most {NAME_LIMIT} characters"
        );
        if let Some(id) = &self.stack_id {
            ensure!(
                project.groups.iter().any(|g| &g.id == id),
                "Unknown stack {id}"
            );
        }
        ensure!(
            !self.terminals.is_empty() || self.worktree_setup.is_some() || self.stack_id.is_some(),
            "The proposal needs terminals or worktree preparation"
        );
        if let Some(setup) = &self.worktree_setup {
            ensure!(
                !setup.command.trim().is_empty() && one_line(&setup.command, COMMAND_LIMIT),
                "Preparation commands are one line of at most {COMMAND_LIMIT} characters"
            );
            ensure!(
                !setup.reason.trim().is_empty() && setup.reason.chars().count() <= REASON_LIMIT,
                "Preparation needs a reason of at most {REASON_LIMIT} characters"
            );
        }
        ensure!(
            self.terminals.len() <= MAX_TERMINALS,
            "Propose at most {MAX_TERMINALS} terminals"
        );
        // Existing terminals by id, new ones by name: an id never stands for a name.
        let mut existing_seen = HashSet::new();
        let mut new_seen = HashSet::new();
        for (n, t) in self.terminals.iter().enumerate() {
            let label = t.terminal.as_deref().or(t.name.as_deref()).unwrap_or("?");
            let at = format!("Terminal {} ({} › {label})", n + 1, t.component);
            let Some(component) = project.component(&t.component) else {
                anyhow::bail!("{at}: unknown component {}", t.component);
            };
            match (&t.terminal, &t.name, &t.command) {
                (Some(id), None, command) => {
                    if let Some(command) = command {
                        ensure!(
                            !command.trim().is_empty() && one_line(command, COMMAND_LIMIT),
                            "{at}: commands are one line of at most {COMMAND_LIMIT} characters"
                        );
                    }
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
                    ensure!(
                        existing_seen.insert((&t.component, id.as_str())),
                        "{at}: repeated terminal"
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
                    let key = name_key(name);
                    let slug = crate::detect::slug(name.trim());
                    if let Some(same) = component
                        .terminals
                        .iter()
                        .find(|x| name_key(&x.name) == key || x.id == slug)
                    {
                        anyhow::bail!(
                            "{at}: {} already has terminal {} ({}); propose it by id instead",
                            t.component,
                            same.id,
                            same.name
                        );
                    }
                    ensure!(
                        new_seen.insert((&t.component, key)),
                        "{at}: repeated terminal"
                    );
                }
                _ => anyhow::bail!(
                    "{at}: give either an existing terminal id, or a name and command for a new one"
                ),
            }
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
    let _guard = SUBMISSIONS.lock();
    proposal.validate(project)?;
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session.into(),
        submitted_ms: now_ms,
        name: proposal.name.trim().into(),
        stack_id: proposal.stack_id.clone(),
        ordered_startup: proposal.ordered_startup,
        worktree_setup: proposal.worktree_setup.as_ref().map(|setup| ProposedSetup {
            command: setup.command.trim().into(),
            reason: setup.reason.trim().into(),
        }),
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
    SUBMISSIONS.write_in(store, &project.root, &pending)?;
    Ok(pending)
}

fn read_in(store: &Path, root: &str) -> Result<Option<Pending>> {
    SUBMISSIONS.read_in(store, root)
}

fn clear_in(store: &Path, root: &str, id: &str) -> Result<bool> {
    SUBMISSIONS.clear_in::<Pending>(store, root, id)
}

/// Save an agent's proposal for review, replacing any earlier one.
///
/// # Errors
/// Fails if the proposal is invalid for `project` or can't be saved.
pub fn submit(project: &Project, session: &str, proposal: &StackProposal) -> Result<Pending> {
    submit_in(
        &SUBMISSIONS.dir()?,
        project,
        session,
        proposal,
        crate::pty::now_ms(),
    )
}

/// The proposal awaiting review for the project at `root`.
///
/// # Errors
/// Fails if the file can't be read or parsed.
pub fn read(root: &str) -> Result<Option<Pending>> {
    read_in(&SUBMISSIONS.dir()?, root)
}

/// Forget the reviewed proposal `id`, unless a newer one has replaced it.
///
/// # Errors
/// Fails if the file can't be read or removed.
pub fn clear(root: &str, id: &str) -> Result<bool> {
    clear_in(&SUBMISSIONS.dir()?, root, id)
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
    stack_context_for(project, None)
}

/// Briefing for a new stack or a replacement of the stack with `stack_id`.
#[must_use]
pub fn stack_context_for(project: &Project, stack_id: Option<&str>) -> String {
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
        let _ = writeln!(
            out,
            "- {}: {} (id `{}`, orderedStartup: {}, readiness timeout: {}s)",
            g.name,
            g.component_ids.join(", "),
            g.id,
            g.ordered_startup,
            g.readiness_timeout_seconds
        );
    }
    if let Some(id) = stack_id {
        let _ = writeln!(
            out,
            "\n## Replace stack `{id}`\n\nInclude \"stackId\":\"{id}\" in your proposal. Correct or replace its commands, readiness conditions and component membership. Submit the complete resulting set of terminals, omitting obsolete ones; do not append duplicates. Reuse existing task terminal ids wherever possible. An empty set removes all members. The current configuration is listed above."
        );
    }
    let _ = writeln!(
        out,
        "\n## Current worktree preparation\n\n{}",
        project
            .worktree_setup
            .as_ref()
            .map_or("None.", |s| s.command.as_str())
    );
    out.push_str(
        "\nAlso inspect dependency installation, ignored environment files and generated assets needed \
         in a fresh worktree. Optionally propose worktreeSetup: {command, reason}, with file:line \
         evidence. The command runs once from the worktree root before implementation; use \
         PATCHBAY_PROJECT_ROOT and PATCHBAY_WORKTREE_ROOT for paths when needed. This is not a \
         stack-start hook: starting a stack does not rerun worktreeSetup. Keep services and native \
         app launchers in terminals. Omit worktreeSetup when no preparation change is needed. \
         Preparation-only proposals may use an empty terminals array. Never read or include secret \
         values. The user reviews preparation separately; applying never enables or runs it.\n"
    );
    let _ = write!(
        out,
        "\n## Task\n\nWork out how a developer runs this project locally: the long-running \
         processes that must be up together, such as databases and queues (often in \
         docker-compose files), API servers, workers, web or mobile dev servers, and native \
         development apps and simulators. Read \
         README files, package scripts, Makefiles, Procfiles, docker-compose files and \
         framework configuration, including native project files and shared run schemes. \
         Check whether local development requires Xcode, Simulator, Android Studio, or an emulator, \
         even when the project has no backend or dev server. Verify installed native app bundle \
         paths and executable availability using read-only checks before proposing commands. Names \
         and locations vary by tool version (for example, DeviceHub.app versus Simulator.app); do \
         not assume an app name from documentation is installed or registered with the OS launcher. \
         Prefer verified bundle paths when name lookup may fail. Propose documented native app launchers \
         as Development terminals so Start stack opens them; do not put them in worktreeSetup. \
         When a GUI launch command hands off to another process, keep its terminal attached to the \
         app (for example, use open -W on macOS); stack startup expects Development terminals to \
         stay running. Leave readyWhen empty for GUI launchers without readiness output. \
         Explain any manual destination selection or Run action still needed; opening an IDE or \
         simulator does not build, install, or launch the project app. \
         Prefer an existing task terminal that isn't a Validation \
         one, supplying command to replace its faulty command when needed; propose a new one \
         (with a name and a one-line command run from the component's \
         folder) only when none fits. \
         Include repeatable dependency installation, generated assets, required builds and actual app \
         launch in the Development command, chained with && so a failed preparation or build prevents launch. \
         Commands run relative to the component in the selected worktree; never hard-code another checkout. \
         Opening an IDE alone is not app launch. Report missing system tools, credentials and unavoidable \
         manual steps in the reasons without reading secrets. Leave tests and linters out of service terminals.\n\n\
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
    prepare_for(project, preset, None, policy)
}

/// Prepare detection targeting a stable stack id, failing if it no longer exists.
///
/// # Errors
/// Fails for an unknown stack, invalid preset, briefing I/O or a rejected policy check.
pub fn prepare_for(
    project: &Project,
    preset: &TerminalSpec,
    stack_id: Option<&str>,
    policy: &dyn Policy,
) -> Result<(TerminalSpec, SessionSpec)> {
    if let Some(id) = stack_id {
        ensure!(
            project.groups.iter().any(|g| g.id == id),
            "Unknown stack {id}"
        );
    }
    let mut terminal = preset.clone();
    terminal.id = STACK_TERMINAL.into();
    terminal.name = format!("Detect stack · {}", preset.name);
    let mut env = BTreeMap::new();
    if let Some(id) = stack_id {
        env.insert(TARGET_ENV.into(), id.into());
    }
    let spec = context::job_agent_spec(
        project,
        &terminal,
        &stack_context_for(project, stack_id),
        project.external_dirs(),
        MAP_SCOPE,
        PROMPT,
        env,
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
        // Names repeat only within a component.
        let web_dev = json!({"component":"web","name":"Dev","command":"npm run dev","reason":"x"});
        assert!(proposal(json!([existing, web_dev])).validate(&p).is_ok());
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
                json!([{"component":"api","terminal":"dev","command":" ","reason":"x"}]),
                "commands are one line",
            ),
            (
                json!([{"component":"api","terminal":"dev","command":"a\nb","reason":"x"}]),
                "commands are one line",
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
                json!([new, {"component":"web","name":" vite ","command":"vite","reason":"x"}]),
                "Terminal 2 (web ›  vite ): repeated",
            ),
            (
                json!([{"component":"api","name":"DEV","command":"npm start","reason":"x"}]),
                "api already has terminal dev (Dev); propose it by id",
            ),
            (
                json!([{"component":"api","name":"Test","command":"vitest","reason":"x"}]),
                "api already has terminal test (Test)",
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
    fn replacement_targets_a_stable_id_and_persists_corrected_commands() {
        let project = project();
        let mut replacement = proposal(json!([{
            "component":"api", "terminal":"dev", "command":" npm ci && npm run dev ",
            "readyWhen":"", "reason":"package.json:3"
        }]));
        replacement.stack_id = Some("g".into());
        replacement.name = "Corrected stack".into();
        assert!(replacement.validate(&project).is_ok());
        let store = std::env::temp_dir().join(format!("patchbay-stack-{}", uuid::Uuid::new_v4()));
        let pending = submit_in(&store, &project, "s", &replacement, 1).unwrap();
        assert_eq!(pending.stack_id.as_deref(), Some("g"));
        assert_eq!(
            pending.terminals[0].command.as_deref(),
            Some("npm ci && npm run dev")
        );
        assert_eq!(read_in(&store, &project.root).unwrap(), Some(pending));
        replacement.terminals.clear();
        assert!(
            replacement.validate(&project).is_ok(),
            "can remove all members"
        );
        replacement.stack_id = Some("missing".into());
        assert!(
            replacement
                .validate(&project)
                .unwrap_err()
                .to_string()
                .contains("Unknown stack")
        );
        let text = stack_context_for(&project, Some("g"));
        assert!(text.contains("Include \"stackId\":\"g\""));
        assert!(text.contains("omitting obsolete ones"));
        assert!(text.contains("chained with &&"));
        assert!(text.contains("selected worktree"));
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn preparation_is_optional_validated_and_persisted() {
        let p = project();
        let mut proposal = proposal(json!([]));
        assert!(proposal.worktree_setup.is_none());
        assert!(proposal.validate(&p).is_err());
        proposal.worktree_setup = Some(ProposedSetup {
            command: " npm ci ".into(),
            reason: " package-lock.json:1 ".into(),
        });
        assert!(proposal.validate(&p).is_ok());
        let store = std::env::temp_dir().join(format!("patchbay-stack-{}", uuid::Uuid::new_v4()));
        let pending = submit_in(&store, &p, "s", &proposal, 1).unwrap();
        let setup = pending.worktree_setup.as_ref().unwrap();
        assert_eq!(setup.command, "npm ci");
        assert_eq!(setup.reason, "package-lock.json:1");
        assert_eq!(read_in(&store, &p.root).unwrap(), Some(pending));
        for command in [
            "",
            "  ",
            "npm ci\nnpm start",
            &"x".repeat(COMMAND_LIMIT + 1),
        ] {
            proposal.worktree_setup.as_mut().unwrap().command = command.into();
            assert!(proposal.validate(&p).is_err());
        }
        proposal.worktree_setup.as_mut().unwrap().command = "npm ci".into();
        proposal.worktree_setup.as_mut().unwrap().reason = " ".into();
        assert!(proposal.validate(&p).is_err());
        let mut old = serde_json::to_value(
            submit_in(
                &store,
                &p,
                "s",
                &self::proposal(json!([{
                    "component": "api", "terminal": "dev", "reason": "Makefile:1"
                }])),
                2,
            )
            .unwrap(),
        )
        .unwrap();
        old.as_object_mut().unwrap().remove("worktreeSetup");
        assert!(
            serde_json::from_value::<Pending>(old)
                .unwrap()
                .worktree_setup
                .is_none()
        );
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn names_match_ignoring_case_and_spacing() {
        let mut p = project();
        p.components[0].terminals.push(
            serde_json::from_value(
                json!({"id":"serve","name":"Web  Server","kind":"task","command":"npm start"}),
            )
            .unwrap(),
        );
        let err = proposal(json!([
            {"component":"api","name":" web\tserver ","command":"node server.js","reason":"x"}
        ]))
        .validate(&p)
        .unwrap_err()
        .to_string();
        assert!(err.contains("api already has terminal serve"), "{err}");
        let err = proposal(json!([
            {"component":"web","name":"Vite  Dev","command":"vite","reason":"x"},
            {"component":"web","name":"vite dev","command":"npx vite","reason":"x"}
        ]))
        .validate(&p)
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("Terminal 2 (web › vite dev): repeated"),
            "{err}"
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
        assert!(text.contains("worktreeSetup"));
        assert!(text.contains("starting a stack does not rerun worktreeSetup"));
        assert!(text.contains("Xcode, Simulator, Android Studio, or an emulator"));
        assert!(text.contains("as Development terminals so Start stack opens them"));
        assert!(text.contains("do not put them in worktreeSetup"));
        assert!(text.contains("DeviceHub.app versus Simulator.app"));
        assert!(text.contains("Verify installed native app bundle"));
        assert!(text.contains("Prefer verified bundle paths when name lookup may fail"));
        assert!(text.contains("open -W on macOS"));
        assert!(text.contains("does not build, install, or launch the project app"));
        let mut configured = project();
        configured.worktree_setup = Some(crate::model::WorktreeSetup {
            command: "npm ci".into(),
        });
        assert!(stack_context(&configured).contains("npm ci"));
    }
}
