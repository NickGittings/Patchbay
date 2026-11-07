#![cfg(unix)]

use patchbay_core::context::{self, Kickoff};
use patchbay_core::policy::{Policy, Scope};
use patchbay_core::{Project, TerminalSpec};
use std::os::unix::fs::PermissionsExt;

fn quoted(value: impl std::fmt::Display) -> String {
    format!("'{}'", value.to_string().replace('\'', "'\\''"))
}

struct Deny;
impl Policy for Deny {
    fn check(&self, _scope: Scope<'_>, _command: &str) -> Result<(), String> {
        Err("denied before inspection".into())
    }
}

#[test]
fn rejected_presets_are_never_executed_by_configuration_inspection() {
    let dir = std::env::temp_dir().join(format!("patchbay-policy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = dir.join("codex");
    let marker = dir.join("executed");
    std::fs::write(
        &program,
        format!("#!/bin/sh\ntouch {}\n", quoted(marker.display())),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let terminal: TerminalSpec = serde_json::from_value(serde_json::json!({
        "id":"agent", "name":"Probe", "kind":"agent", "command":quoted(program.display()),
    }))
    .unwrap();
    let project: Project = serde_json::from_value(serde_json::json!({
        "name":"Policy probe", "root":dir,
        "components":[{"id":"app", "name":"App", "path":".", "terminals":[terminal]}]
    }))
    .unwrap();
    let terminal = &project.components[0].terminals[0];
    for result in [
        context::session_spec(&project, "app", "agent", &Deny, &[]),
        context::plan_session_spec(&project, &[], terminal, &Deny, &[], None),
        context::task_root_session_spec(
            &project,
            &[],
            terminal,
            None,
            &Deny,
            &[],
            Some(Kickoff::ImplementPlan { subagents: None }),
        ),
        context::merge_agent_spec(&project, terminal, "Merge", vec![], &Deny),
    ] {
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("denied before inspection")
        );
        assert!(
            !marker.exists(),
            "a rejected preset executed before policy approval"
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn profile_restrictions_come_from_the_home_reported_by_the_launched_codex() {
    let dir = std::env::temp_dir().join(format!("patchbay-profile-{}", uuid::Uuid::new_v4()));
    let home = dir.join("shell-home");
    std::fs::create_dir_all(&home).unwrap();
    let profile = format!("locked-{}", uuid::Uuid::new_v4());
    std::fs::write(home.join(format!("{profile}.config.toml")), "default_permissions=\":read-only\"\n[features.network_proxy.domains]\n\"127.0.0.1\"=\"deny\"\n").unwrap();
    let snapshot = serde_json::json!({"id":1,"result":{"layers":[{
        "name":{"type":"user","file":home.join("config.toml")},
        "config":{"default_permissions":":workspace"}
    }]}});
    let program = dir.join("codex");
    // The selected program reports its own home, independently of the parent
    // process environment, as when a login shell exports CODEX_HOME.
    std::fs::write(&program, format!("#!/bin/sh\nread -r request\nprintf '%s\\n' {}\nread -r initialized\nread -r request\nprintf '%s\\n' {}\nread -r request\nprintf '%s\\n' {}\n",
        quoted(serde_json::json!({"id":0,"result":{}})), quoted(snapshot),
        quoted(serde_json::json!({"id":2,"result":{"requirements":null}})),
    )).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let terminal: TerminalSpec = serde_json::from_value(serde_json::json!({
        "id":profile, "name":"Probe", "kind":"agent", "command":format!("{} -p {profile}", quoted(program.display())),
    })).unwrap();
    let project: Project =
        serde_json::from_value(serde_json::json!({"name":"Profile probe", "root":dir})).unwrap();
    let spec = context::plan_session_spec(
        &project,
        &[],
        &terminal,
        &patchbay_core::policy::AllowAll,
        &[],
        None,
    )
    .unwrap();
    assert!(spec.notice.is_none(), "{:?}", spec.notice);
    assert!(
        spec.command
            .contains("permissions.patchbay_loopback.extends=\":read-only\""),
        "{}",
        spec.command
    );
    assert!(spec.command.contains("\"127.0.0.1\"=\"deny\""));
    std::fs::remove_dir_all(dir).unwrap();
}
