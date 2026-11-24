//! Validation checks a detection agent proposes, as part of a version 2 stack proposal
//! (`stack_proposals.rs`), and the rules they follow. Standalone validation discovery
//! (`propose-validation`) is retired; a submission it left behind is still read once for
//! review, then cleared.
use crate::{
    model::{Project, TerminalKind},
    submissions::{Store, Submission},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

static SUBMISSIONS: Store = Store::new("validation-proposals");
/// The retired discovery terminal; sessions still running it may submit nothing.
pub const VALIDATION_TERMINAL: &str = "validation-discovery";
pub const MAX_CHECKS: usize = 100;
pub const MAX_MISSING: usize = 500;
const TEXT_LIMIT: usize = 1000;
const NAME_LIMIT: usize = 60;
/// The error a retired `propose-validation` gets.
pub const RETIRED: &str = "propose-validation is retired: put checks and missingChecks in a version 2 proposal and submit it with propose-stack";

/// A one-shot check for a component: an unassigned task terminal by `terminal` with its
/// exact `command`, or a new one with `name`. `path` is the component's folder as the
/// agent saw it, so a moved component is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedCheck {
    pub component: String,
    pub path: String,
    #[serde(default)]
    pub terminal: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    pub command: String,
    pub reason: String,
}

/// Why a component gets no check: no tooling, or prerequisites the agent can't provide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissingCheck {
    pub component: String,
    pub reason: String,
}

/// A submission left by the retired discovery agent.
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

/// Check proposed checks against the readable map. `scope` is the component selection the
/// detection was launched with, or every component when empty. Every component in scope
/// without a Validation terminal needs checks or a missing-check explanation (with a
/// selection, every selected one does). `development` lists `(component, terminal id)`
/// pairs the same proposal makes Development, which can't also become checks.
///
/// # Errors
/// Fails for oversized reports, components outside scope, moved folders, terminals that
/// can't become Validation, repeats, or incomplete coverage.
pub fn validate_checks(
    project: &Project,
    scope: &[String],
    checks: &[ProposedCheck],
    missing: &[MissingCheck],
    development: &[(&str, &str)],
) -> Result<()> {
    ensure!(scope.len() <= 500, "Select at most 500 components");
    for id in scope {
        ensure!(
            project.component(id).is_some(),
            "Unknown selected component {id}"
        );
    }
    ensure!(
        checks.len() <= MAX_CHECKS && missing.len() <= MAX_MISSING,
        "Propose at most {MAX_CHECKS} checks and {MAX_MISSING} missing-check reports"
    );
    let in_scope = |id: &str| scope.is_empty() || scope.iter().any(|s| s == id);
    let mut seen = HashSet::new();
    let mut names = HashSet::new();
    let mut covered = HashSet::new();
    for (n, t) in checks.iter().enumerate() {
        let at = format!(
            "Check {} ({} › {})",
            n + 1,
            t.component,
            t.terminal.as_deref().or(t.name.as_deref()).unwrap_or("?")
        );
        ensure!(
            in_scope(&t.component),
            "{at}: component {} is outside the selection",
            t.component
        );
        let c = project
            .component(&t.component)
            .ok_or_else(|| anyhow::anyhow!("{at}: unknown component {}", t.component))?;
        ensure!(c.path == t.path, "{at}: component folder changed: {}", c.id);
        ensure!(
            line(&t.command, TEXT_LIMIT) && line(&t.reason, TEXT_LIMIT),
            "{at}: give a one-line command and source evidence"
        );
        if let Some(id) = &t.terminal {
            let x = c
                .terminals
                .iter()
                .find(|x| &x.id == id)
                .ok_or_else(|| anyhow::anyhow!("{at}: unknown terminal {id}"))?;
            ensure!(
                t.name.is_none()
                    && x.kind == TerminalKind::Task
                    && x.action.is_none()
                    && x.command == t.command,
                "{at}: only matching unassigned task terminals can become Validation"
            );
            ensure!(
                !development.contains(&(t.component.as_str(), id.as_str())),
                "{at}: {id} is proposed as a Development terminal too"
            );
        } else {
            let name = t.name.as_deref().unwrap_or("");
            ensure!(line(name, NAME_LIMIT), "{at}: name each new check");
            ensure!(
                names.insert((&t.component, crate::detect::slug(name))),
                "{at}: repeated terminal name"
            );
            ensure!(
                !c.terminals
                    .iter()
                    .any(|x| x.name.eq_ignore_ascii_case(name) || x.id == crate::detect::slug(name)),
                "{at}: terminal name already exists"
            );
            ensure!(
                !c.terminals.iter().any(|x| x.kind == TerminalKind::Task
                    && x.action.is_none()
                    && x.command == t.command),
                "{at}: reuse the matching unassigned task terminal"
            );
        }
        ensure!(
            seen.insert((&t.component, &t.command)),
            "{at}: repeated check command"
        );
        covered.insert(t.component.as_str());
    }
    for m in missing {
        ensure!(
            in_scope(&m.component) && project.component(&m.component).is_some(),
            "Missing-check report for {} is outside the selection",
            m.component
        );
        ensure!(
            line(&m.reason, TEXT_LIMIT),
            "Explain missing checks or prerequisites for {}",
            m.component
        );
        ensure!(
            covered.insert(m.component.as_str()),
            "Repeated or contradictory report for {}",
            m.component
        );
    }
    for c in &project.components {
        let validated = c
            .terminals
            .iter()
            .any(|t| t.action == Some(crate::model::TerminalAction::Validation));
        ensure!(
            !in_scope(&c.id) || covered.contains(c.id.as_str()) || (scope.is_empty() && validated),
            "Report checks or a missingChecks explanation for {}",
            c.id
        );
    }
    Ok(())
}

/// A submission the retired discovery agent left for review.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn project() -> Project {
        serde_json::from_value(json!({"schemaVersion":4,"name":"p","root":"/tmp/p","components":[{"id":"api","name":"API","kind":"backend","path":"api","terminals":[{"id":"check","name":"Check","kind":"task","command":"npm test"}]},{"id":"web","name":"Web","kind":"frontend","path":"/tmp/other-repo","terminals":[]}],"links":[]})).unwrap()
    }
    fn check() -> ProposedCheck {
        serde_json::from_value(json!({"component":"api","path":"api","terminal":"check","name":null,"command":"npm test","reason":"package.json:7"})).unwrap()
    }
    fn missing(component: &str) -> MissingCheck {
        MissingCheck {
            component: component.into(),
            reason: "No tooling configured".into(),
        }
    }

    #[test]
    fn selection_snapshots_and_coverage_are_enforced() {
        let mut p = project();
        let api = vec!["api".to_string()];
        assert!(validate_checks(&p, &api, &[check()], &[], &[]).is_ok());
        assert!(validate_checks(&p, &["web".into()], &[check()], &[], &[]).is_err());
        let both = vec!["api".to_string(), "web".to_string()];
        let err = validate_checks(&p, &both, &[check()], &[], &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("for web"), "{err}");
        assert!(validate_checks(&p, &both, &[check()], &[missing("web")], &[]).is_ok());
        // Without a selection every component without a validator is covered.
        assert!(validate_checks(&p, &[], &[check()], &[], &[]).is_err());
        assert!(validate_checks(&p, &[], &[check()], &[missing("web")], &[]).is_ok());
        let err = validate_checks(&p, &api, &[check()], &[], &[("api", "check")])
            .unwrap_err()
            .to_string();
        assert!(err.contains("Development terminal too"), "{err}");
        p.components[0].terminals[0].action = Some(crate::model::TerminalAction::Development);
        assert!(validate_checks(&p, &api, &[check()], &[], &[]).is_err());
        p.components[0].terminals[0].action = None;
        p.components[0].terminals[0].command = "npm run dev".into();
        assert!(validate_checks(&p, &api, &[check()], &[], &[]).is_err());
        let mut moved = check();
        moved.path = "elsewhere".into();
        assert!(validate_checks(&project(), &api, &[moved], &[], &[]).is_err());
        assert!(
            validate_checks(&project(), &api, &[check()], &[missing("api")], &[]).is_err(),
            "a component is either checked or missing"
        );
        assert!(validate_checks(&project(), &["db".into()], &[], &[], &[]).is_err());
    }

    #[test]
    fn existing_validators_need_no_report_and_new_checks_are_named() {
        let mut p = project();
        p.components[0].terminals[0].action = Some(crate::model::TerminalAction::Validation);
        assert!(validate_checks(&p, &[], &[], &[missing("web")], &[]).is_ok());
        let new: ProposedCheck = serde_json::from_value(json!({"component":"web","path":"/tmp/other-repo","name":"Lint","command":"npm run lint","reason":"package.json:9"})).unwrap();
        assert!(validate_checks(&p, &[], std::slice::from_ref(&new), &[], &[]).is_ok());
        let mut unnamed = new.clone();
        unnamed.name = None;
        assert!(validate_checks(&p, &[], &[unnamed], &[], &[]).is_err());
        assert!(validate_checks(&p, &[], &[new.clone(), new], &[], &[]).is_err());
    }
}
