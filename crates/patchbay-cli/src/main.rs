use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use patchbay_core::{Project, context, detect, extensions::Registry};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(
    name = "patchbay",
    about = "Inspect Patchbay component maps from the command line"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Use configured actions in the desktop agent's fixed launch task.
    Agent {
        #[command(subcommand)]
        command: AgentCmd,
    },
    /// Inspect and control independent local terminal sessions.
    Sessions {
        #[command(subcommand)]
        command: SessionsCmd,
    },
    /// List local extensions and validation errors.
    Extensions,
    /// Print the component map Patchbay would suggest for a repository.
    Detect {
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
    /// Print a planner briefing for selected component ids, or the whole project.
    Plan {
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        component_ids: Vec<String>,
    },
    /// Print the context an agent terminal on a component receives.
    Context {
        component: String,
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// The saved map if there is one, otherwise a detected one.
fn open(dir: &Path) -> Result<Project> {
    let root = dir
        .canonicalize()
        .with_context(|| format!("{}", dir.display()))?;
    match Project::load(&root)? {
        Some(p) => Ok(p),
        None => detect::detect_with(&root, &Registry::load().detectors()),
    }
}

fn main() -> Result<()> {
    let registry = Registry::load();
    match Cli::parse().cmd {
        Cmd::Agent { command } => {
            if !agent(command)? {
                std::process::exit(1);
            }
        }
        Cmd::Sessions { command } => sessions(command)?,
        Cmd::Extensions => println!("{}", serde_json::to_string_pretty(&registry)?),
        Cmd::Detect { dir } => {
            let root = dir.canonicalize()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&detect::detect_with(&root, &registry.detectors())?)?
            );
        }
        Cmd::Plan { dir, component_ids } => {
            let project = open(&dir)?;
            for id in &component_ids {
                if project.component(id).is_none() {
                    bail!("unknown component {id}");
                }
            }
            print!(
                "{}",
                context::plan_context(
                    &project,
                    &component_ids,
                    &registry.sections(
                        &project,
                        &component_ids,
                        &[PathBuf::from(&project.root)],
                        vec![],
                    )
                )
            );
        }
        Cmd::Context { component, dir } => {
            let project = open(&dir)?;
            let Some(c) = project
                .components
                .iter()
                .find(|c| c.id == component || c.name == component)
            else {
                bail!("no component named {component}");
            };
            print!(
                "{}",
                context::component_context(
                    &project,
                    &c.id,
                    &registry.sections(
                        &project,
                        std::slice::from_ref(&c.id),
                        &[PathBuf::from(&project.root)],
                        vec![],
                    )
                )
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_ids_are_positional_and_directory_is_a_flag() {
        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan", "api", "web"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("."));
        assert_eq!(component_ids, ["api", "web"]);

        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan", "api", "--dir", "../shop"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("../shop"));
        assert_eq!(component_ids, ["api"]);
    }

    #[test]
    fn agent_commands_accept_configured_ids_and_require_proposal_files() {
        for args in [
            vec!["patchbay", "agent", "context"],
            vec!["patchbay", "agent", "status"],
            vec!["patchbay", "agent", "validate", "web"],
            vec!["patchbay", "agent", "environment", "start", "dev"],
            vec!["patchbay", "agent", "environment", "stop", "dev"],
            vec!["patchbay", "agent", "logs", "s-1"],
            vec!["patchbay", "agent", "propose", "--file", "proposal.json"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
        assert!(Cli::try_parse_from(["patchbay", "agent", "validate"]).is_err());
        assert!(Cli::try_parse_from(["patchbay", "agent", "propose"]).is_err());
        assert!(
            Cli::try_parse_from([
                "patchbay",
                "agent",
                "environment",
                "start",
                "dev",
                "--command",
                "echo hi"
            ])
            .is_err()
        );
    }

    #[test]
    fn control_keys_map_to_terminal_bytes() {
        // crossterm 0.29 parses raw 0x1D (Ctrl+]) as Ctrl+5.
        assert_eq!(control_byte('5'), Some(DETACH));
        assert_eq!(control_byte(']'), Some(DETACH));
        assert_eq!(control_byte('4'), Some(0x1c));
        assert_eq!(control_byte('c'), Some(0x03));
        assert_eq!(control_byte(' '), Some(0));
        assert_eq!(control_byte('é'), None);
    }

    #[test]
    fn plan_without_ids_uses_the_current_project() {
        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("."));
        assert!(component_ids.is_empty());
    }
}

#[derive(Subcommand)]
enum SessionsCmd {
    List,
    /// Attach to a live process; Ctrl+] detaches without stopping it.
    Attach {
        id: String,
    },
    Stop {
        id: String,
    },
    Resume {
        id: String,
    },
    SetConversation {
        id: String,
        conversation_id: String,
    },
    Forget {
        id: String,
    },
    /// Refuses while work runs unless --stop-running is explicit.
    Shutdown {
        #[arg(long)]
        stop_running: bool,
    },
}
fn sessions(command: SessionsCmd) -> Result<()> {
    use patchbay_core::session::{Client, Record, Request};
    let dir = patchbay_core::session::runtime_dir()?;
    let helper = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "patchbay-sessiond.exe"
    } else {
        "patchbay-sessiond"
    });
    let mut client = match command {
        SessionsCmd::Shutdown { .. } => Client::connect(&dir)?,
        _ => Client::ensure(&dir, &helper)?,
    };
    match command {
        SessionsCmd::List => println!(
            "{}",
            serde_json::to_string_pretty(&client.call::<Vec<Record>>(Request::List)?)?
        ),
        SessionsCmd::Stop { id } => client.call::<()>(Request::Stop { id })?,
        SessionsCmd::Resume { id } => println!(
            "{}",
            client.call::<String>(Request::Resume {
                id,
                request_id: format!(
                    "cli-{}-{:?}",
                    std::process::id(),
                    std::time::SystemTime::now()
                )
            })?
        ),
        SessionsCmd::SetConversation {
            id,
            conversation_id,
        } => client.call::<()>(Request::Conversation {
            id,
            conversation_id,
        })?,
        SessionsCmd::Forget { id } => client.call::<()>(Request::Forget { id })?,
        SessionsCmd::Shutdown { stop_running } => {
            client.call::<()>(Request::Shutdown { stop_running })?
        }
        SessionsCmd::Attach { id } => interactive_attach(&mut client, &id)?,
    }
    Ok(())
}
/// Ctrl+] (GS), which detaches instead of reaching the session.
const DETACH: u8 = 0x1d;

/// The byte a Ctrl+key sends. In raw mode crossterm reports 0x1C–0x1F (Ctrl+\\,
/// Ctrl+], Ctrl+^, Ctrl+_) as Ctrl+4 to Ctrl+7 and NUL as Ctrl+Space; keyboard
/// enhancement reports the symbols themselves.
fn control_byte(c: char) -> Option<u8> {
    let c = u8::try_from(u32::from(c)).ok()?;
    match c {
        b' ' | b'2' | b'@' => Some(0),
        b'3' | b'[' => Some(0x1b),
        b'4' | b'\\' => Some(0x1c),
        b'5' | b']' => Some(0x1d),
        b'6' | b'^' => Some(0x1e),
        b'7' | b'_' | b'/' => Some(0x1f),
        b'8' | b'?' => Some(0x7f),
        b'a'..=b'z' | b'A'..=b'Z' => Some(c & 0x1f),
        _ => None,
    }
}

fn interactive_attach(client: &mut patchbay_core::session::Client, id: &str) -> Result<()> {
    use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
    use patchbay_core::pty::Snapshot;
    use patchbay_core::session::{Batch, Request};
    use std::io::Write;
    let viewer = format!("cli-{}", std::process::id());
    let baseline: Batch = client.call(Request::Poll { after: 0 })?;
    let snapshot: Option<Snapshot> = client.call(Request::Attach {
        id: id.into(),
        viewer: viewer.clone(),
        claim: true,
    })?;
    let snapshot = snapshot.context("Unknown session")?;
    anyhow::ensure!(
        snapshot.running,
        "Session ended; use resume explicitly or inspect its retained output with sessions list"
    );
    crossterm::terminal::enable_raw_mode()?;
    struct Raw;
    impl Drop for Raw {
        fn drop(&mut self) {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
    let _raw = Raw;
    let (cols, rows) = crossterm::terminal::size()?;
    client.call::<()>(Request::Resize {
        id: id.into(),
        viewer: viewer.clone(),
        cols,
        rows,
    })?;
    let mut output = std::io::stdout();
    output.write_all(&snapshot.data)?;
    output.flush()?;
    let mut after = baseline.end;
    let mut end = snapshot.end;
    let mut generation = snapshot.generation;
    loop {
        let batch: Batch = client.call(Request::Poll { after })?;
        if batch.gap {
            let snapshot: Option<Snapshot> = client.call(Request::Snapshot { id: id.into() })?;
            if let Some(s) = snapshot {
                let start = s.end.saturating_sub(s.data.len() as u64);
                let covered = usize::try_from(end.saturating_sub(start))?.min(s.data.len());
                output.write_all(&s.data[covered..])?;
                end = s.end;
            }
            after = batch.end;
        } else {
            for envelope in batch.events {
                after = envelope.sequence;
                if envelope.event.session_id() != id {
                    continue;
                }
                match envelope.event {
                    patchbay_core::TerminalEvent::Output {
                        seq,
                        data,
                        generation: g,
                        ..
                    } => {
                        if g != generation {
                            generation = g;
                            end = 0;
                        }
                        let covered = usize::try_from(end.saturating_sub(seq))?.min(data.len());
                        output.write_all(&data[covered..])?;
                        end = end.max(seq + data.len() as u64);
                    }
                    patchbay_core::TerminalEvent::Exited { .. } => {
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
        output.flush()?;
        if event::poll(std::time::Duration::from_millis(50))? {
            let data = match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    let control = key.modifiers.contains(KeyModifiers::CONTROL);
                    let byte = match key.code {
                        KeyCode::Char(c) if control => control_byte(c),
                        _ => None,
                    };
                    if byte == Some(DETACH) {
                        break;
                    }
                    match key.code {
                        KeyCode::Char(_) if control => {
                            byte.map(|b| char::from(b).to_string()).unwrap_or_default()
                        }
                        KeyCode::Char(c) => c.to_string(),
                        KeyCode::Enter => "\r".into(),
                        KeyCode::Backspace => "\x7f".into(),
                        KeyCode::Tab => "\t".into(),
                        KeyCode::Esc => "\x1b".into(),
                        KeyCode::Up => "\x1b[A".into(),
                        KeyCode::Down => "\x1b[B".into(),
                        KeyCode::Right => "\x1b[C".into(),
                        KeyCode::Left => "\x1b[D".into(),
                        _ => String::new(),
                    }
                }
                Event::Resize(cols, rows) => {
                    client.call::<()>(Request::Resize {
                        id: id.into(),
                        viewer: viewer.clone(),
                        cols,
                        rows,
                    })?;
                    String::new()
                }
                _ => String::new(),
            };
            if !data.is_empty() {
                let write = |data: String| Request::Write {
                    id: id.into(),
                    viewer: viewer.clone(),
                    data,
                };
                // A desktop window may have taken input; typing here takes it back.
                if client.call::<()>(write(data.clone())).is_err() {
                    client.call::<()>(Request::Claim {
                        id: id.into(),
                        viewer: viewer.clone(),
                        claim: true,
                    })?;
                    client.call::<()>(write(data))?;
                }
            }
        }
    }
    client.call::<()>(Request::Detach {
        id: id.into(),
        viewer,
    })?;
    Ok(())
}

#[derive(Subcommand)]
enum AgentCmd {
    Context,
    Environment {
        #[command(subcommand)]
        command: EnvironmentCmd,
    },
    Validate {
        component_id: String,
    },
    Status,
    Logs {
        session_id: String,
    },
    Propose {
        #[arg(long)]
        file: PathBuf,
    },
}
#[derive(Subcommand)]
enum EnvironmentCmd {
    Start { group_id: String },
    Stop { group_id: String },
}
fn agent(command: AgentCmd) -> Result<bool> {
    use patchbay_core::agent_bridge::{self, Action, Response};
    let response = Response::from_result((|| {
        let action = match command {
            AgentCmd::Context => Action::Context {},
            AgentCmd::Status => Action::Status {},
            AgentCmd::Logs { session_id } => Action::Logs { session_id },
            AgentCmd::Validate { component_id } => Action::Validate { component_id },
            AgentCmd::Environment {
                command: EnvironmentCmd::Start { group_id },
            } => Action::EnvironmentStart { group_id },
            AgentCmd::Environment {
                command: EnvironmentCmd::Stop { group_id },
            } => Action::EnvironmentStop { group_id },
            AgentCmd::Propose { file } => {
                anyhow::ensure!(
                    file.metadata()?.len() <= 1024 * 1024,
                    "Proposal file is too large"
                );
                Action::Propose {
                    proposal: serde_json::from_slice(&std::fs::read(file)?)?,
                }
            }
        };
        let response = agent_bridge::call_from_env(action)?;
        if !response.ok {
            bail!(
                "{}",
                response
                    .error
                    .unwrap_or_else(|| "Agent command failed".into())
            );
        }
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    })());
    println!("{}", serde_json::to_string_pretty(&response)?);
    Ok(response.ok)
}
