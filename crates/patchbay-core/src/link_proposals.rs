//! Dependencies a detection agent proposes for the map. Like planner proposals they
//! are artifacts the user reviews, never edits to `patchbay.json`.
use crate::context;
use crate::model::{MAP_SCOPE, Project, TerminalSpec};
use crate::policy::Policy;
use crate::pty::SessionSpec;
use crate::submissions::{Store, Submission};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

/// Submissions awaiting review, one per project root under `~/.patchbay/map-links/`.
static SUBMISSIONS: Store = Store::new("map-links");

/// The one detection terminal of a project (`MAP_SCOPE`).
pub const MAP_TERMINAL: &str = "detect";
pub const MAX_LINKS: usize = 100;
pub const LABEL_LIMIT: usize = 60;
pub const REASON_LIMIT: usize = 1000;
const PROMPT: &str = "Detect the dependencies described in your Patchbay briefing and submit them with propose-links.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedLink {
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkProposal {
    pub version: u32,
    pub links: Vec<ProposedLink>,
}

/// A submission awaiting review. `skipped` were already on the map when submitted.
/// `id` is unique per submission, so clearing one never removes a newer one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub session_id: String,
    pub submitted_ms: u64,
    pub links: Vec<ProposedLink>,
    pub skipped: Vec<ProposedLink>,
}

impl Submission for Pending {
    fn id(&self) -> &str {
        &self.id
    }
}

impl LinkProposal {
    /// Check against the readable map: known ids, no self or repeated pairs, and
    /// bounded single-line labels with a reason. Errors name the entry.
    ///
    /// # Errors
    /// Fails for another version, no links or too many, or an invalid entry.
    pub fn validate(&self, project: &Project) -> Result<()> {
        ensure!(self.version == 1, "Unsupported proposal version");
        ensure!(!self.links.is_empty(), "The proposal needs links");
        ensure!(
            self.links.len() <= MAX_LINKS,
            "Propose at most {MAX_LINKS} links"
        );
        let mut seen = HashSet::new();
        for (n, link) in self.links.iter().enumerate() {
            let at = format!("Link {} ({} → {})", n + 1, link.source, link.target);
            for id in [&link.source, &link.target] {
                ensure!(
                    project.component(id).is_some(),
                    "{at}: unknown component {id}"
                );
            }
            ensure!(
                link.source != link.target,
                "{at}: a component can't depend on itself"
            );
            ensure!(
                seen.insert((&link.source, &link.target)),
                "{at}: repeated dependency"
            );
            if let Some(label) = &link.label {
                ensure!(
                    !label.contains(['\n', '\r']) && label.trim().chars().count() <= LABEL_LIMIT,
                    "{at}: labels are one line of at most {LABEL_LIMIT} characters"
                );
            }
            ensure!(!link.reason.trim().is_empty(), "{at}: give a reason");
            ensure!(
                link.reason.chars().count() <= REASON_LIMIT,
                "{at}: the reason is longer than {REASON_LIMIT} characters"
            );
        }
        Ok(())
    }
}

fn submit_in(
    store: &Path,
    project: &Project,
    session: &str,
    proposal: &LinkProposal,
    now_ms: u64,
) -> Result<Pending> {
    let _guard = SUBMISSIONS.lock();
    proposal.validate(project)?;
    let linked: HashSet<_> = project
        .links
        .iter()
        .map(|l| (l.source.as_str(), l.target.as_str()))
        .collect();
    let (skipped, links) = proposal
        .links
        .iter()
        .cloned()
        .map(|mut l| {
            l.label = l
                .label
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            l
        })
        .partition(|l| linked.contains(&(l.source.as_str(), l.target.as_str())));
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session.into(),
        submitted_ms: now_ms,
        links,
        skipped,
    };
    // Nothing to review: leave any earlier submission for the user.
    if pending.links.is_empty() {
        return Ok(pending);
    }
    SUBMISSIONS.write_in(store, &project.root, &pending)?;
    Ok(pending)
}

fn read_in(store: &Path, root: &str) -> Result<Option<Pending>> {
    SUBMISSIONS.read_in(store, root)
}

fn clear_in(store: &Path, root: &str, id: &str) -> Result<bool> {
    SUBMISSIONS.clear_in::<Pending>(store, root, id)
}

/// Save an agent's proposal for review, replacing any earlier one. A proposal
/// whose links are all on the map already is returned without being saved.
///
/// # Errors
/// Fails if the proposal is invalid for `project` or can't be saved.
pub fn submit(project: &Project, session: &str, proposal: &LinkProposal) -> Result<Pending> {
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

/// The detection agent's briefing: the map as it stands and how to submit.
#[must_use]
pub fn map_context(project: &Project) -> String {
    let mut out = format!(
        "# Patchbay dependency detection\n\nProject: {}\nRoot: {}\n\n## Components\n\n",
        project.name, project.root
    );
    for c in &project.components {
        let _ = writeln!(
            out,
            "- `{}`: {} ({:?}) at `{}`{}",
            c.id,
            c.name,
            c.kind,
            c.path,
            if c.path.starts_with("..") {
                ", outside the project folder"
            } else {
                ""
            }
        );
    }
    out.push_str("\n## Dependencies already on the map\n\n");
    if project.links.is_empty() {
        out.push_str("None.\n");
    }
    for l in &project.links {
        let _ = writeln!(
            out,
            "- `{}` → `{}`{}",
            l.source,
            l.target,
            l.label
                .as_ref()
                .map(|s| format!(" ({s})"))
                .unwrap_or_default()
        );
    }
    let _ = write!(
        out,
        "\n## Task\n\nFind how these components depend on each other. `source → target` means \
         source depends on target: it calls, imports, reads or deploys with it. Look for HTTP or \
         RPC clients and their base URLs or environment variables pointing at another component's \
         server, generated API clients, mobile or web apps calling backend endpoints, jobs and \
         workers importing backend code or sharing its settings, shared databases or schemas, \
         queues and topics, shared packages, and docker-compose or deployment files linking \
         services. Leave out third-party services and dependencies already listed above.\n\n\
         Only read; don't edit project files, install anything or start servers. Use only the \
         component ids above. For each dependency give a short label (at most {LABEL_LIMIT} \
         characters, such as REST API or shared models) and a reason with file:line evidence.\n\n\
         Submit JSON {{\"version\":1,\"links\":[{{\"source\":\"id\",\"target\":\"id\",\"label\":\"REST API\",\
         \"reason\":\"Krilo/API.swift:12 calls the backend's /api routes\"}}]}} by piping it to \
         {} on standard input; don't write it to a file. Submitting again \
         replaces the earlier proposal. The user reviews the links before any are added to the \
         map.\n",
        context::agent_command("propose-links --file -")
    );
    out
}

/// The detection terminal and its launch for `preset`, at the project root.
///
/// # Errors
/// Fails for a preset that isn't an agent, briefing I/O, or a rejected policy check.
pub fn prepare(
    project: &Project,
    preset: &TerminalSpec,
    policy: &dyn Policy,
) -> Result<(TerminalSpec, SessionSpec)> {
    let mut terminal = preset.clone();
    terminal.id = MAP_TERMINAL.into();
    terminal.name = format!("Detect dependencies · {}", preset.name);
    let spec = context::job_agent_spec(
        project,
        &terminal,
        &map_context(project),
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
            "schemaVersion": 4, "name": "krilo", "root": "/tmp/krilo",
            "components": [
                {"id":"app","name":"App","kind":"app","path":"App","terminals":[]},
                {"id":"api","name":"API","kind":"backend","path":"Api","terminals":[]},
                {"id":"jobs","name":"Jobs","kind":"service","path":"Jobs","terminals":[]}
            ],
            "links": [{"id":"jobs->api","source":"jobs","target":"api"}]
        }))
        .unwrap()
    }
    fn proposal(links: serde_json::Value) -> LinkProposal {
        serde_json::from_value(json!({"version":1,"links":links})).unwrap()
    }

    #[test]
    fn validation_names_the_offending_entry() {
        let p = project();
        let ok = json!({"source":"app","target":"api","label":"REST","reason":"App/API.swift:3"});
        assert!(proposal(json!([ok])).validate(&p).is_ok());
        for (links, error) in [
            (json!([]), "needs links"),
            (
                json!([{"source":"app","target":"web","reason":"x"}]),
                "unknown component web",
            ),
            (
                json!([{"source":"app","target":"app","reason":"x"}]),
                "itself",
            ),
            (json!([ok, ok]), "Link 2 (app → api): repeated"),
            (
                json!([{"source":"app","target":"api","label":"a\nb","reason":"x"}]),
                "one line",
            ),
            (
                json!([{"source":"app","target":"api","label":"x".repeat(61),"reason":"x"}]),
                "one line",
            ),
            (
                json!([{"source":"app","target":"api","reason":" "}]),
                "give a reason",
            ),
        ] {
            let err = proposal(links).validate(&p).unwrap_err().to_string();
            assert!(err.contains(error), "{err}");
        }
        let many: Vec<_> = (0..=MAX_LINKS).map(|_| ok.clone()).collect();
        assert!(
            proposal(json!(many))
                .validate(&p)
                .unwrap_err()
                .to_string()
                .contains("at most")
        );
        let mut v2 = proposal(json!([ok]));
        v2.version = 2;
        assert!(v2.validate(&p).is_err());
        assert!(
            serde_json::from_value::<LinkProposal>(json!({"version":1,"links":[],"extra":1}))
                .is_err()
        );
    }

    #[test]
    fn submissions_skip_linked_pairs_and_clear_only_themselves() {
        let store =
            std::env::temp_dir().join(format!("patchbay-map-links-{}", uuid::Uuid::new_v4()));
        let p = project();
        let links = json!([
            {"source":"app","target":"api","label":"  REST  ","reason":"App/API.swift:3"},
            {"source":"jobs","target":"api","reason":"Jobs/settings.py:1"}
        ]);
        let first = submit_in(&store, &p, "s-1", &proposal(links.clone()), 10).unwrap();
        assert_eq!(first.links.len(), 1);
        assert_eq!(first.links[0].label.as_deref(), Some("REST"));
        assert_eq!(first.skipped[0].source, "jobs");
        assert_eq!(read_in(&store, &p.root).unwrap().as_ref(), Some(&first));
        // The same millisecond: only the id tells them apart.
        let second = submit_in(&store, &p, "s-1", &proposal(links.clone()), 10).unwrap();
        assert_ne!(first.id, second.id);
        assert!(
            !clear_in(&store, &p.root, &first.id).unwrap(),
            "a newer submission stays"
        );
        assert!(clear_in(&store, &p.root, &second.id).unwrap());
        assert_eq!(read_in(&store, &p.root).unwrap(), None);
        assert!(!clear_in(&store, &p.root, &second.id).unwrap());
        // Only links already on the map: nothing is saved, an earlier one stays.
        let third = submit_in(&store, &p, "s-1", &proposal(json!([links[0]])), 11).unwrap();
        let linked = json!([{"source":"jobs","target":"api","reason":"Jobs/settings.py:1"}]);
        let empty = submit_in(&store, &p, "s-1", &proposal(linked), 12).unwrap();
        assert!(empty.links.is_empty());
        assert_eq!(read_in(&store, &p.root).unwrap(), Some(third));
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn briefing_lists_the_map_and_the_submit_command() {
        let text = map_context(&project());
        assert!(text.contains("- `app`: App (App) at `App`"));
        assert!(text.contains("- `jobs` → `api`"));
        assert!(text.contains("agent propose-links --file -"));
        assert!(text.contains("standard input"));
    }
}
