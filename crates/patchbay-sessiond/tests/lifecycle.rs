//! Real helper lifecycle: disconnect clients, reconnect to the same process, then restart service.
#[cfg(unix)]
#[test]
fn independent_service_survives_clients_and_serializes_startup() {
    use patchbay_core::TerminalKind;
    use patchbay_core::pty::{SessionSpec, Snapshot};
    use patchbay_core::session::{Client, Metadata, Record, Request};
    use std::{
        collections::BTreeMap,
        time::{Duration, Instant},
    };
    let dir = std::env::temp_dir().join(format!("patchbay-lifecycle-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let helper = std::path::Path::new(env!("CARGO_BIN_EXE_patchbay-sessiond"));
    let starts: Vec<_> = (0..4)
        .map(|_| {
            let dir = dir.clone();
            let helper = helper.to_owned();
            std::thread::spawn(move || Client::ensure(&dir, &helper).unwrap())
        })
        .collect();
    let clients: Vec<_> = starts.into_iter().map(|t| t.join().unwrap()).collect();
    let instance = clients[0].instance.clone();
    assert!(clients.iter().all(|c| c.instance == instance));
    drop(clients);
    let mut client = Client::connect(&dir).unwrap();
    let id: String = client.call(Request::Start {
        request_id: "counter-request".into(),
        metadata: Box::new(Metadata { project_id: "project".into(), project_name: "P".into(), project_root: dir.display().to_string(), component_id: "api".into(), terminal_id: "counter".into(), name: "Counter".into(), kind: TerminalKind::Task, adapter: None, conversation_id: None, extension_id: None, command_id: None, key: None, command: String::new() }),
        spec: SessionSpec { id: "discarded".into(), command: "echo process:$$; i=0; while :; do echo sequence:$i; i=$((i+1)); sleep 0.05; done".into(), cwd: dir.clone(), env: BTreeMap::new(), ready_when: String::new(), service: false, notice: None },
    }).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let before: Option<Snapshot> = client.call(Request::Snapshot { id: id.clone() }).unwrap();
    drop(client); // Desktop quit must be just this: no PTY reset.
    std::thread::sleep(Duration::from_millis(300));
    let mut reconnected = Client::connect(&dir).unwrap();
    assert_eq!(reconnected.instance, instance);
    let after: Option<Snapshot> = reconnected
        .call(Request::Snapshot { id: id.clone() })
        .unwrap();
    let (before, after) = (before.unwrap(), after.unwrap());
    assert!(after.running);
    assert_eq!(before.generation, after.generation);
    assert!(after.end > before.end);
    assert!(after.data.starts_with(&before.data));
    assert_eq!(
        String::from_utf8_lossy(&after.data)
            .matches("process:")
            .count(),
        1
    );
    assert!(
        reconnected
            .call::<()>(Request::Shutdown {
                stop_running: false
            })
            .is_err()
    );
    reconnected
        .call::<()>(Request::Stop { id: id.clone() })
        .unwrap();
    reconnected
        .call::<()>(Request::Shutdown {
            stop_running: false,
        })
        .unwrap();
    drop(reconnected);
    let until = Instant::now() + Duration::from_secs(5);
    while dir.join("endpoint.json").exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(25));
    }
    let mut restarted = Client::ensure(&dir, helper).unwrap();
    assert_ne!(restarted.instance, instance);
    let records: Vec<Record> = restarted.call(Request::List).unwrap();
    assert_eq!(records.len(), 1);
    assert!(!records[0].snapshot.as_ref().unwrap().running);
    restarted.call::<()>(Request::Forget { id }).unwrap();
    restarted
        .call::<()>(Request::Shutdown {
            stop_running: false,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(150));
    std::fs::remove_dir_all(dir).unwrap();
}

/// Provider executables and history are isolated fixtures; no account or user history is used.
#[cfg(unix)]
#[test]
fn exact_provider_resume_retains_incarnations_and_rejects_duplicates() {
    use patchbay_core::TerminalKind;
    use patchbay_core::adapters::Adapter;
    use patchbay_core::pty::{SessionSpec, Snapshot};
    use patchbay_core::session::{Client, Metadata, Record, Request};
    use std::collections::BTreeMap;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};
    let root = std::env::temp_dir().join(format!("patchbay-provider-{}", uuid_fixture()));
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join("service");
    struct Helper(std::process::Child);
    impl Drop for Helper {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _helper = Helper(
        std::process::Command::new(env!("CARGO_BIN_EXE_patchbay-sessiond"))
            .arg(&dir)
            .env("CODEX_HOME", root.join("codex"))
            .env("CLAUDE_CONFIG_DIR", root.join("claude"))
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut client = loop {
        if let Ok(c) = Client::connect(&dir) {
            break c;
        }
        assert!(Instant::now() < deadline, "Fixture service did not start");
        std::thread::sleep(Duration::from_millis(25));
    };
    for (name, adapter, invocation, history_dir) in [
        (
            "codex",
            Adapter::Codex,
            "resume",
            root.join("codex/sessions/2026/10/04"),
        ),
        (
            "claude",
            Adapter::Claude,
            "--resume",
            root.join("claude/projects/fixture"),
        ),
    ] {
        std::fs::create_dir_all(&history_dir).unwrap();
        let conversation = "12345678-aaaa-1234-bbbb-123456789abc";
        std::fs::write(history_dir.join(format!("{conversation}.jsonl")), "{}").unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let executable = root.join("bin").join(name);
        std::fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = '{invocation}' ]; then\n  printf 'resumed:%s options:%s %s\\n' \"$2\" \"$3\" \"$4\"\n  sleep 2\nelse\n  echo '{name} {invocation} {conversation}'\nfi\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command = format!("'{}' --model fixture", executable.display());
        let id: String = client
            .call(Request::Start {
                request_id: format!("start-{name}"),
                metadata: Box::new(Metadata {
                    project_id: "fixture".into(),
                    project_name: "Fixture".into(),
                    project_root: root.display().to_string(),
                    component_id: "shared".into(),
                    terminal_id: name.into(),
                    name: name.into(),
                    kind: TerminalKind::Agent,
                    adapter: Some(adapter),
                    conversation_id: None,
                    extension_id: None,
                    command_id: None,
                    key: None,
                    command: command.clone(),
                }),
                spec: SessionSpec {
                    id: "discard".into(),
                    command,
                    cwd: root.clone(),
                    env: BTreeMap::new(),
                    ready_when: String::new(),
                    service: false,
                    notice: None,
                },
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let initial = loop {
            let snapshot: Option<Snapshot> =
                client.call(Request::Snapshot { id: id.clone() }).unwrap();
            if let Some(s) = snapshot
                && !s.running
            {
                break s;
            }
            assert!(Instant::now() < deadline, "Fixture did not exit");
            std::thread::sleep(Duration::from_millis(25));
        };
        let records: Vec<Record> = client.call(Request::List).unwrap();
        assert_eq!(
            records
                .iter()
                .find(|r| r.id == id)
                .unwrap()
                .metadata
                .conversation_id
                .as_deref(),
            Some(conversation)
        );
        client
            .call::<String>(Request::Resume {
                id: id.clone(),
                request_id: format!("resume-{name}"),
            })
            .unwrap();
        client
            .call::<String>(Request::Resume {
                id: id.clone(),
                request_id: format!("resume-{name}"),
            })
            .unwrap();
        assert!(
            client
                .call::<String>(Request::Resume {
                    id: id.clone(),
                    request_id: format!("duplicate-{name}")
                })
                .is_err()
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let resumed = loop {
            let snapshot: Option<Snapshot> =
                client.call(Request::Snapshot { id: id.clone() }).unwrap();
            if let Some(s) = snapshot
                && String::from_utf8_lossy(&s.data).contains("options:--model fixture")
            {
                break s;
            }
            assert!(
                Instant::now() < deadline,
                "Fixture did not receive preserved options"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(resumed.generation > initial.generation);
        assert!(
            String::from_utf8_lossy(&resumed.data).contains(&format!("resumed:{conversation}"))
        );
        let history: Option<Snapshot> = client
            .call(Request::History {
                id: id.clone(),
                incarnation: 0,
            })
            .unwrap();
        assert_eq!(history.unwrap().data, initial.data);
        client.call::<()>(Request::Stop { id: id.clone() }).unwrap();
        client
            .call::<()>(Request::Conversation {
                id: id.clone(),
                conversation_id: "87654321-missing".into(),
            })
            .unwrap();
        assert!(
            client
                .call::<String>(Request::Resume {
                    id: id.clone(),
                    request_id: "missing-history".into()
                })
                .is_err()
        );
        let unchanged: Option<Snapshot> = client.call(Request::Snapshot { id }).unwrap();
        assert_eq!(unchanged.unwrap().generation, resumed.generation);
    }
    client
        .call::<()>(Request::Shutdown { stop_running: true })
        .unwrap();
    std::thread::sleep(Duration::from_millis(150));
    std::fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
fn uuid_fixture() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}
