//! Authenticated loopback command channel. A capability fixes launch context;
//! callers cannot supply a different project, checkout, or arbitrary command.
use crate::{Project, proposals::Proposal};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const LIMIT: u64 = 2 * 1024 * 1024;
pub const ADDRESS_ENV: &str = "PATCHBAY_AGENT_ADDRESS";
pub const TOKEN_ENV: &str = "PATCHBAY_AGENT_TOKEN";
pub const CLI_ENV: &str = "PATCHBAY_CLI";

#[derive(Clone)]
pub struct LaunchContext {
    pub project_id: String,
    pub project: Project,
    pub task: Option<String>,
    pub agent_session: String,
    pub planner: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Context {},
    Status {},
    Logs {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    EnvironmentStart {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    EnvironmentStop {
        #[serde(rename = "groupId")]
        group_id: String,
    },
    Validate {
        #[serde(rename = "componentId")]
        component_id: String,
    },
    Propose {
        proposal: Proposal,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    token: String,
    action: Action,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub version: u32,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<String>,
}
impl Response {
    pub fn from_result(result: Result<Value>) -> Self {
        match result {
            Ok(value) => Self {
                version: 1,
                ok: true,
                result: Some(value),
                error: None,
            },
            Err(error) => Self {
                version: 1,
                ok: false,
                result: None,
                error: Some(error.to_string()),
            },
        }
    }
}

type Handler = dyn Fn(&LaunchContext, Action) -> Result<Value> + Send + Sync;
pub struct Server {
    address: SocketAddr,
    contexts: Mutex<HashMap<String, LaunchContext>>,
    stopped: AtomicBool,
}
impl Server {
    pub fn start(
        handler: impl Fn(&LaunchContext, Action) -> Result<Value> + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let server = Arc::new(Self {
            address: listener.local_addr()?,
            contexts: Mutex::default(),
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&server);
        let handler: Arc<Handler> = Arc::new(handler);
        std::thread::spawn(move || {
            while let Some(server) = weak.upgrade() {
                if server.stopped.load(Ordering::Acquire) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let handler = handler.clone();
                        std::thread::spawn(move || {
                            let _ = server.serve(stream, &*handler);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(server)
    }
    pub fn inject(&self, launch: LaunchContext, cli: &Path, env: &mut BTreeMap<String, String>) {
        let token = uuid::Uuid::new_v4().to_string();
        env.insert(ADDRESS_ENV.into(), self.address.to_string());
        env.insert(TOKEN_ENV.into(), token.clone());
        env.insert(CLI_ENV.into(), cli.display().to_string());
        env.insert("PATCHBAY_PROJECT_ID".into(), launch.project_id.clone());
        env.insert(
            "PATCHBAY_TASK_ID".into(),
            launch.task.clone().unwrap_or_default(),
        );
        self.contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(token, launch);
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.contexts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
    fn serve(&self, mut stream: TcpStream, handler: &Handler) -> Result<()> {
        // macOS can inherit the listener's nonblocking flag on accepted sockets.
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        let response = Response::from_result((|| {
            let mut line = String::new();
            BufReader::new((&stream).take(LIMIT + 1)).read_line(&mut line)?;
            ensure!(
                line.len() as u64 <= LIMIT && line.ends_with('\n'),
                "Invalid bridge request size"
            );
            let request: Request = serde_json::from_str(&line)?;
            ensure!(request.version == 1, "Unsupported bridge version");
            ensure!(
                !self.stopped.load(Ordering::Acquire),
                "Desktop disconnected"
            );
            let context = self
                .contexts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&request.token)
                .cloned()
                .context("Authentication failed")?;
            handler(&context, request.action)
        })());
        serde_json::to_writer(&mut stream, &response)?;
        stream.write_all(b"\n")?;
        Ok(())
    }
}

pub fn call(address: &str, token: &str, action: Action) -> Result<Response> {
    let address: SocketAddr = address
        .parse()
        .context("Invalid desktop connection address")?;
    ensure!(address.ip().is_loopback(), "Desktop bridge must be local");
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .context("Desktop disconnected; open the launch project in Patchbay")?;
    // Configured validators can take time; connection loss still returns EOF immediately.
    stream.set_read_timeout(Some(Duration::from_secs(3600)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    serde_json::to_writer(
        &mut stream,
        &Request {
            version: 1,
            token: token.into(),
            action,
        },
    )?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream.take(16 * LIMIT)).read_line(&mut line)?;
    ensure!(!line.is_empty(), "Desktop disconnected");
    let response: Response = serde_json::from_str(&line)?;
    ensure!(
        response.version == 1,
        "Unsupported desktop response version"
    );
    Ok(response)
}

pub fn call_from_env(action: Action) -> Result<Response> {
    let address =
        std::env::var(ADDRESS_ENV).context("Run agent commands from a Patchbay agent terminal")?;
    let token = std::env::var(TOKEN_ENV).context("Missing Patchbay agent capability")?;
    call(&address, &token, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn launch(task: &str) -> LaunchContext {
        LaunchContext {
            project_id: "p".into(),
            project: serde_json::from_value(
                serde_json::json!({"name":"demo","root":".","components":[]}),
            )
            .unwrap(),
            task: Some(task.into()),
            agent_session: task.into(),
            planner: false,
        }
    }
    #[test]
    fn authenticates_and_binds_requests_to_launch_context() {
        let server =
            Server::start(|context, _| Ok(serde_json::json!({"task":context.task}))).unwrap();
        let mut first = BTreeMap::new();
        let mut second = BTreeMap::new();
        server.inject(launch("one"), Path::new("patchbay"), &mut first);
        server.inject(launch("two"), Path::new("patchbay"), &mut second);
        let request = |env: &BTreeMap<String, String>| {
            call(&env[ADDRESS_ENV], &env[TOKEN_ENV], Action::Context {}).unwrap()
        };
        assert_eq!(request(&first).result.unwrap()["task"], "one");
        assert_eq!(request(&second).result.unwrap()["task"], "two");
        assert!(
            !call(&first[ADDRESS_ENV], "wrong", Action::Status {})
                .unwrap()
                .ok
        );
        // Unknown context/command fields cannot enter the protocol.
        assert!(
            serde_json::from_value::<Action>(serde_json::json!({"kind":"context","task":"two"}))
                .is_err()
        );
        server.stop();
        let disconnected = call(&first[ADDRESS_ENV], &first[TOKEN_ENV], Action::Status {});
        assert!(disconnected.is_err() || !disconnected.unwrap().ok);
    }
    #[test]
    fn waits_for_a_request_on_an_accepted_socket() {
        let server =
            Server::start(|context, _| Ok(serde_json::json!({"task":context.task}))).unwrap();
        let mut env = BTreeMap::new();
        server.inject(launch("one"), Path::new("patchbay"), &mut env);
        let mut stream = TcpStream::connect(&env[ADDRESS_ENV]).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        serde_json::to_writer(
            &mut stream,
            &Request {
                version: 1,
                token: env[TOKEN_ENV].clone(),
                action: Action::Context {},
            },
        )
        .unwrap();
        stream.write_all(b"\n").unwrap();
        let mut text = String::new();
        BufReader::new(stream).read_line(&mut text).unwrap();
        assert!(serde_json::from_str::<Response>(&text).unwrap().ok);
        server.stop();
    }

    #[test]
    fn failures_are_json_results_and_connection_loss_is_reported() {
        let server = Server::start(|_, _| anyhow::bail!("Configured action is busy")).unwrap();
        let mut env = BTreeMap::new();
        server.inject(launch("one"), Path::new("patchbay"), &mut env);
        let response = call(
            &env[ADDRESS_ENV],
            &env[TOKEN_ENV],
            Action::Validate {
                component_id: "web".into(),
            },
        )
        .unwrap();
        assert!(!response.ok);
        assert!(response.error.unwrap().contains("busy"));
        assert!(call("192.0.2.1:1234", "x", Action::Status {}).is_err());
        server.stop();
    }
}
