//! Reviewed, selection-bound proposals for existing one-shot validation tooling.
use crate::{
    context,
    model::{MAP_SCOPE, Project, TerminalKind, TerminalSpec},
    policy::Policy,
    pty::SessionSpec,
    submissions::{Store, Submission},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fmt::Write as _,
};
static SUBMISSIONS: Store = Store::new("validation-proposals");
pub const VALIDATION_TERMINAL: &str = "validation-discovery";
pub const SELECTION_ENV: &str = "PATCHBAY_VALIDATION_SELECTION";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedCheck {
    pub component: String,
    pub path: String,
    pub terminal: Option<String>,
    pub name: Option<String>,
    pub command: String,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissingCheck {
    pub component: String,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationProposal {
    pub version: u32,
    pub terminals: Vec<ProposedCheck>,
    pub missing: Vec<MissingCheck>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub session_id: String,
    pub submitted_ms: u64,
    pub component_ids: Vec<String>,
    pub terminals: Vec<ProposedCheck>,
    pub missing: Vec<MissingCheck>,
}
impl Submission for Pending {
    fn id(&self) -> &str {
        &self.id
    }
}
fn line(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.contains(['\n', '\r'])
}
impl ValidationProposal {
    /// Validate a report against the authenticated launch selection and readable map.
    /// # Errors
    /// Rejects unknown versions, oversized reports, invalid terminals and incomplete coverage.
    pub fn validate(&self, project: &Project, selected: &[String]) -> Result<()> {
        ensure!(self.version == 1, "Unsupported proposal version");
        ensure!(
            !selected.is_empty() && selected.len() <= 500,
            "Select 1–500 components"
        );
        ensure!(
            self.terminals.len() <= 100 && self.missing.len() <= 500,
            "Report is too large"
        );
        let mut seen = HashSet::new();
        let mut names = HashSet::new();
        let mut covered = HashSet::new();
        for t in &self.terminals {
            ensure!(
                selected.contains(&t.component),
                "Component {} is outside the launch selection",
                t.component
            );
            let c = project
                .component(&t.component)
                .ok_or_else(|| anyhow::anyhow!("Unknown component {}", t.component))?;
            ensure!(c.path == t.path, "Component folder changed: {}", c.id);
            ensure!(
                line(&t.command, 1000) && line(&t.reason, 1000),
                "Give a bounded command and source evidence"
            );
            if let Some(id) = &t.terminal {
                let x = c
                    .terminals
                    .iter()
                    .find(|x| &x.id == id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown terminal {id}"))?;
                ensure!(
                    t.name.is_none()
                        && x.kind == TerminalKind::Task
                        && x.action.is_none()
                        && x.command == t.command,
                    "Only matching unassigned task terminals can become Validation"
                );
            } else {
                let name = t.name.as_deref().unwrap_or("");
                ensure!(line(name, 60), "Name each new check");
                ensure!(
                    names.insert((&t.component, crate::detect::slug(name))),
                    "Repeated terminal name"
                );
                ensure!(
                    !c.terminals
                        .iter()
                        .any(|x| x.name.eq_ignore_ascii_case(name)
                            || x.id == crate::detect::slug(name)),
                    "Terminal name already exists"
                );
                ensure!(
                    !c.terminals.iter().any(|x| x.kind == TerminalKind::Task
                        && x.action.is_none()
                        && x.command == t.command),
                    "Reuse the matching unassigned task terminal"
                );
            }
            ensure!(
                seen.insert((&t.component, &t.command)),
                "Repeated check command"
            );
            covered.insert(&t.component);
        }
        for m in &self.missing {
            ensure!(
                selected.contains(&m.component) && project.component(&m.component).is_some(),
                "Missing-check report outside selection"
            );
            ensure!(
                line(&m.reason, 1000),
                "Explain missing checks or prerequisites"
            );
            ensure!(
                covered.insert(&m.component),
                "Repeated or contradictory component report"
            );
        }
        ensure!(
            selected.iter().all(|id| covered.contains(id)),
            "Report checks or an explanation for every selected component"
        );
        Ok(())
    }
}
/// Persist a validated discovery report.
/// # Errors
/// Fails for an invalid report or storage failure.
pub fn submit(
    project: &Project,
    session: &str,
    selected: &[String],
    proposal: &ValidationProposal,
) -> Result<Pending> {
    proposal.validate(project, selected)?;
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session.into(),
        submitted_ms: crate::pty::now_ms(),
        component_ids: selected.to_vec(),
        terminals: proposal.terminals.clone(),
        missing: proposal.missing.clone(),
    };
    let _guard = SUBMISSIONS.lock();
    SUBMISSIONS.write_in(&SUBMISSIONS.dir()?, &project.root, &pending)?;
    Ok(pending)
}
/// Read a report awaiting review.
/// # Errors
/// Fails on storage errors.
pub fn read(root: &str) -> Result<Option<Pending>> {
    SUBMISSIONS.read_in(&SUBMISSIONS.dir()?, root)
}
/// Clear only the reviewed submission.
/// # Errors
/// Fails on storage errors.
pub fn clear(root: &str, id: &str) -> Result<bool> {
    SUBMISSIONS.clear_in::<Pending>(&SUBMISSIONS.dir()?, root, id)
}
/// Prepare a read-only discovery agent for the selected component folders.
/// # Errors
/// Rejects empty or unknown selections, invalid presets and policy failures.
pub fn prepare(
    project: &Project,
    preset: &TerminalSpec,
    selected: &[String],
    policy: &dyn Policy,
) -> Result<(TerminalSpec, SessionSpec)> {
    ensure!(
        !selected.is_empty() && selected.len() <= 500,
        "Select 1–500 components"
    );
    let mut briefing = String::from(
        "# Configure validation checks\nRead repository documentation, scripts, test and static-check configuration for ONLY these components. Do not run checks, edit repository files, install dependencies or set up environments. Discover tests, lint, type checks and format checks that exit after one run, using check-only modes. Exclude watchers, servers and automatic fixes. Report missing tooling and prerequisites explicitly. Commands run from the component folder; do not broaden checks to other components. Preserve existing validators. Reuse an unassigned task terminal with the same command; never repurpose Development, shell or agent terminals.\n",
    );
    for id in selected {
        let c = project
            .component(id)
            .ok_or_else(|| anyhow::anyhow!("Unknown component {id}"))?;
        let _ = writeln!(briefing, "Component: {}", serde_json::to_string(c)?);
    }
    let _ = writeln!(
        briefing,
        "Submit JSON {{\"version\":1,\"terminals\":[{{\"component\":\"id\",\"path\":\"component path from above\",\"terminal\":null,\"name\":\"Tests\",\"command\":\"npm test -- --run\",\"reason\":\"package.json:10 and prerequisites\"}}],\"missing\":[{{\"component\":\"id with no suitable checks\",\"reason\":\"explanation\"}}]}} via {} on stdin. For existing terminals give terminal id, name null and its exact command. Cover every selected component with checks or a missing explanation. An empty terminals list is valid. Do not propose already configured validators. The user reviews before applying.",
        context::agent_command("propose-validation --file -")
    );
    let mut terminal = preset.clone();
    terminal.id = VALIDATION_TERMINAL.into();
    terminal.name = format!("Configure checks · {}", preset.name);
    let mut env = BTreeMap::new();
    env.insert(SELECTION_ENV.into(), serde_json::to_string(selected)?);
    let mut selected_project = project.clone();
    selected_project
        .components
        .retain(|c| selected.contains(&c.id));
    let spec = context::job_agent_spec(
        project,
        &terminal,
        &briefing,
        selected_project.external_dirs(),
        MAP_SCOPE,
        "Discover validation checks and submit your proposal.",
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
        serde_json::from_value(json!({"schemaVersion":4,"name":"p","root":"/tmp/p","components":[{"id":"api","name":"API","kind":"backend","path":"api","terminals":[{"id":"check","name":"Check","kind":"task","command":"npm test"}]},{"id":"web","name":"Web","kind":"frontend","path":"/tmp/other-repo","terminals":[]}],"links":[]})).unwrap()
    }
    fn report() -> ValidationProposal {
        serde_json::from_value(json!({"version":1,"terminals":[{"component":"api","path":"api","terminal":"check","name":null,"command":"npm test","reason":"package.json:7"}],"missing":[]})).unwrap()
    }
    #[test]
    fn selection_and_snapshots_are_enforced() {
        let mut p = project();
        let selected = vec!["api".into()];
        assert!(report().validate(&p, &selected).is_ok());
        assert!(report().validate(&p, &["web".into()]).is_err());
        assert!(
            report()
                .validate(&p, &["api".into(), "web".into()])
                .is_err()
        );
        p.components[0].terminals[0].action = Some(crate::model::TerminalAction::Development);
        assert!(report().validate(&p, &selected).is_err());
        p.components[0].terminals[0].action = None;
        p.components[0].terminals[0].command = "npm run dev".into();
        assert!(report().validate(&p, &selected).is_err());
        let mut bad = report();
        bad.version = 2;
        assert!(bad.validate(&project(), &selected).is_err());
    }
    #[test]
    fn empty_report_and_external_component_are_supported() {
        let p = project();
        let report = ValidationProposal {
            version: 1,
            terminals: vec![],
            missing: vec![MissingCheck {
                component: "web".into(),
                reason: "No tooling configured; install prerequisites separately".into(),
            }],
        };
        assert!(report.validate(&p, &["web".into()]).is_ok());
        let dir = std::env::temp_dir().join(format!("validation-{}", uuid::Uuid::new_v4()));
        let first = Pending {
            id: "1".into(),
            session_id: "s".into(),
            submitted_ms: 0,
            component_ids: vec!["web".into()],
            terminals: vec![],
            missing: report.missing,
        };
        SUBMISSIONS.write_in(&dir, &p.root, &first).unwrap();
        let second = Pending {
            id: "2".into(),
            ..first
        };
        SUBMISSIONS.write_in(&dir, &p.root, &second).unwrap();
        assert!(!SUBMISSIONS.clear_in::<Pending>(&dir, &p.root, "1").unwrap());
        assert_eq!(
            SUBMISSIONS.read_in::<Pending>(&dir, &p.root).unwrap(),
            Some(second)
        );
        assert!(SUBMISSIONS.clear_in::<Pending>(&dir, &p.root, "2").unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
