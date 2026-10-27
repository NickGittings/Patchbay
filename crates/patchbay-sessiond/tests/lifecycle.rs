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
        metadata: Box::new(Metadata { project_id: "project".into(), project_name: "P".into(), project_root: dir.display().to_string(), component_id: "api".into(), terminal_id: "counter".into(), task: None, task_title: None, name: "Counter".into(), kind: TerminalKind::Task, adapter: None, conversation_id: None, conversation_pinned: false, extension_id: None, command_id: None, key: None, branch: None, lane: None, command: String::new() }),
        spec: SessionSpec { resume_command: None, rerun_on_resume: false, owns_briefing: false, exclusive_cwd: false, merge_source: None, id: "discarded".into(), command: "echo process:$$; i=0; while :; do echo sequence:$i; i=$((i+1)); sleep 0.05; done".into(), cwd: dir.clone(), env: BTreeMap::new(), ready_when: String::new(), service: false, notice: None, dirs: Vec::new() },
    }).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let before: Option<Snapshot> = client
        .call(Request::Snapshot {
            id: id.clone(),
            output_limit: None,
        })
        .unwrap();
    drop(client); // Desktop quit must be just this: no PTY reset.
    std::thread::sleep(Duration::from_millis(300));
    let mut reconnected = Client::connect(&dir).unwrap();
    assert_eq!(reconnected.instance, instance);
    let after: Option<Snapshot> = reconnected
        .call(Request::Snapshot {
            id: id.clone(),
            output_limit: None,
        })
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
    let mut restored = records[0].clone();
    restored.spec.command = "echo restarted-output".into();
    restarted
        .call::<String>(Request::Start {
            request_id: "explicit-after-restart".into(),
            metadata: Box::new(restored.metadata),
            spec: restored.spec,
        })
        .unwrap();
    let snapshot: Option<Snapshot> = restarted
        .call(Request::Snapshot {
            id: id.clone(),
            output_limit: None,
        })
        .unwrap();
    assert!(
        snapshot.unwrap().generation > after.generation,
        "New output must sort after restored history"
    );
    restarted
        .call::<()>(Request::Stop { id: id.clone() })
        .unwrap();
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
        std::fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = '{invocation}' ]; then\n  printf 'resumed:%s options:%s %s argc:%s\\n' \"$2\" \"$3\" \"$4\" \"$#\"\n  sleep 2\nelse\n  echo '{name} {invocation} {conversation}'\nfi\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command = format!("'{}' --model fixture", executable.display());
        let briefing = root.join(format!("{name}-briefing.md"));
        std::fs::write(&briefing, "Original scope and plan").unwrap();
        let launch = Request::Start {
            request_id: format!("start-{name}"),
            metadata: Box::new(Metadata {
                project_id: "fixture".into(),
                project_name: "Fixture".into(),
                project_root: root.display().to_string(),
                component_id: "shared".into(),
                terminal_id: name.into(),
                task: None,
                task_title: None,
                name: name.into(),
                kind: TerminalKind::Agent,
                adapter: Some(adapter),
                conversation_id: None,
                conversation_pinned: false,
                extension_id: None,
                command_id: None,
                key: None,
                branch: None,
                lane: None,
                command: command.clone(),
            }),
            spec: SessionSpec {
                resume_command: Some(command.clone()),
                rerun_on_resume: false,
                owns_briefing: false,
                exclusive_cwd: false,
                merge_source: None,
                id: "discard".into(),
                command: format!("{command} 'kickoff merge'"),
                cwd: root.clone(),
                env: BTreeMap::from([(
                    patchbay_core::context::CONTEXT_ENV.into(),
                    briefing.display().to_string(),
                )]),
                ready_when: String::new(),
                service: false,
                notice: None,
                dirs: Vec::new(),
            },
        };
        let Request::Start { metadata, spec, .. } = &launch else {
            unreachable!()
        };
        let metadata = metadata.clone();
        let spec = spec.clone();
        let id: String = client.call(launch).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let initial = loop {
            let snapshot: Option<Snapshot> = client
                .call(Request::Snapshot {
                    id: id.clone(),
                    output_limit: None,
                })
                .unwrap();
            if let Some(s) = snapshot
                && !s.running
            {
                break s;
            }
            assert!(Instant::now() < deadline, "Fixture did not exit");
            std::thread::sleep(Duration::from_millis(25));
        };
        // The serve loop captures the resume hint on its next tick after the exit.
        let captured = loop {
            let records: Vec<Record> = client.call(Request::List).unwrap();
            let captured = records
                .into_iter()
                .find(|r| r.id == id)
                .unwrap()
                .metadata
                .conversation_id;
            if captured.is_some() || Instant::now() >= deadline {
                break captured;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(captured.as_deref(), Some(conversation));
        client
            .call::<String>(Request::Restart {
                metadata: metadata.clone(),
                spec: spec.clone(),
                request_id: format!("resume-{name}"),
            })
            .unwrap();
        client
            .call::<String>(Request::Restart {
                metadata: metadata.clone(),
                spec: spec.clone(),
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
            let snapshot: Option<Snapshot> = client
                .call(Request::Snapshot {
                    id: id.clone(),
                    output_limit: None,
                })
                .unwrap();
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
        assert!(
            String::from_utf8_lossy(&resumed.data).contains("argc:4"),
            "Recovery must preserve model options without resending the kickoff"
        );
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
        let unchanged: Option<Snapshot> = client
            .call(Request::Snapshot {
                id: id.clone(),
                output_limit: None,
            })
            .unwrap();
        assert_eq!(unchanged.unwrap().generation, resumed.generation);
        // A regenerated scope/plan must start fresh even with a pinned, unavailable conversation.
        std::fs::write(&briefing, "Changed highlights, peers, and plan").unwrap();
        client
            .call::<String>(Request::Restart {
                request_id: format!("new-context-{name}"),
                metadata: metadata.clone(),
                spec: spec.clone(),
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot: Option<Snapshot> = client
                .call(Request::Snapshot {
                    id: id.clone(),
                    output_limit: None,
                })
                .unwrap();
            if let Some(s) = snapshot
                && !s.running
            {
                assert!(s.generation > resumed.generation);
                assert!(!String::from_utf8_lossy(&s.data).contains("resumed:"));
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(25));
        }
        // Editing a former agent into a task must run the edited command.
        let mut metadata = metadata;
        metadata.kind = TerminalKind::Task;
        metadata.command = "printf edited-task".into();
        let mut spec = spec;
        spec.command = metadata.command.clone();
        client
            .call::<String>(Request::Restart {
                request_id: format!("edited-task-{name}"),
                metadata,
                spec,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot: Option<Snapshot> = client
                .call(Request::Snapshot {
                    id: id.clone(),
                    output_limit: None,
                })
                .unwrap();
            if let Some(s) = snapshot
                && !s.running
            {
                assert!(String::from_utf8_lossy(&s.data).contains("edited-task"));
                break;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(25));
        }
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

/// Graph environments are owned by project, task and group even after all viewers disconnect.
#[cfg(unix)]
#[test]
fn detached_task_environments_preserve_other_projects_and_shared_owners() {
    use patchbay_core::Project;
    use patchbay_core::actions::{ActionPlan, ActionReport, ActionRequest, TaskOutcome};
    use patchbay_core::pty::Snapshot;
    use patchbay_core::session::{Client, Record, Request};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(mut client) = Client::connect(&self.0.join("service")) {
                let _ = client.call::<()>(Request::Shutdown { stop_running: true });
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.0.join("service/endpoint.json").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let fixture =
        Fixture(std::env::temp_dir().join(format!("patchbay-environments-{}", uuid_fixture())));
    let service = fixture.0.join("service");
    let helper = std::path::Path::new(env!("CARGO_BIN_EXE_patchbay-sessiond"));
    let mut client = Client::ensure(&service, helper).unwrap();
    let instance = client.instance.clone();
    let project = |folder: &str| {
        let root = fixture.0.join(folder);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("patchbay.json"),
            r#"{
          "name":"Fixture","components":[{
            "id":"shared","name":"Shared","path":".","terminals":[{
              "id":"dev","name":"Dev","kind":"task","action":"development",
              "command":"printf 'READY\\n'; sleep 120","readyWhen":"READY"
            }]
          }],"links":[],"groups":[
            {"id":"first","name":"First","componentIds":["shared"]},
            {"id":"second","name":"Second","componentIds":["shared"]}
          ]
        }"#,
        )
        .unwrap();
        Project::load(&root).unwrap().unwrap()
    };
    let scopes = [
        ("one", None, project("one")),
        ("one", Some("same-task"), project("one-task")),
        ("two", None, project("two")),
        ("two", Some("same-task"), project("two-task")),
    ];
    let mut ids = Vec::new();
    for (project_id, task, project) in &scopes {
        let plan = ActionPlan::build(
            project,
            project_id,
            ActionRequest::StartGroup {
                group_id: "first".into(),
            },
            *task,
        )
        .unwrap();
        let report: ActionReport = client
            .call(Request::ActionRun {
                project: Box::new(project.clone()),
                plan: Box::new(plan),
            })
            .unwrap();
        assert!(matches!(report.results[0].outcome, TaskOutcome::Started));
        ids.push(report.results[0].session_id.clone());
    }
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        4
    );
    let plan = ActionPlan::build(
        &scopes[1].2,
        "one",
        ActionRequest::StartGroup {
            group_id: "second".into(),
        },
        Some("same-task"),
    )
    .unwrap();
    let report: ActionReport = client
        .call(Request::ActionRun {
            project: Box::new(scopes[1].2.clone()),
            plan: Box::new(plan),
        })
        .unwrap();
    assert!(matches!(report.results[0].outcome, TaskOutcome::Reused));
    drop(client);
    let mut client = Client::connect(&service).unwrap();
    assert_eq!(client.instance, instance);
    let records: Vec<Record> = client.call(Request::List).unwrap();
    for ((project_id, task, project), id) in scopes.iter().zip(&ids) {
        let record = records.iter().find(|r| &r.id == id).unwrap();
        assert_eq!(&record.metadata.project_id, project_id);
        assert_eq!(record.metadata.task.as_deref(), *task);
        assert_eq!(record.spec.cwd, PathBuf::from(&project.root));
        assert!(record.snapshot.as_ref().unwrap().running);
    }
    client
        .call::<()>(Request::ActionStopGroup {
            project_id: "one".into(),
            group_id: "first".into(),
            task: Some("same-task".into()),
        })
        .unwrap();
    for id in &ids {
        let snapshot: Option<Snapshot> = client
            .call(Request::Snapshot {
                id: id.clone(),
                output_limit: None,
            })
            .unwrap();
        assert!(
            snapshot.unwrap().running,
            "Removing one shared owner stopped {id}"
        );
    }
    client
        .call::<()>(Request::ActionStopGroup {
            project_id: "one".into(),
            group_id: "second".into(),
            task: Some("same-task".into()),
        })
        .unwrap();
    for (index, id) in ids.iter().enumerate() {
        let snapshot: Option<Snapshot> = client
            .call(Request::Snapshot {
                id: id.clone(),
                output_limit: None,
            })
            .unwrap();
        assert_eq!(
            snapshot.unwrap().running,
            index != 1,
            "Stop leaked into another scope: {id}"
        );
    }
}
