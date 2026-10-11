//! Authenticated loopback command channel. A capability fixes launch context;
//! callers cannot supply a different project, checkout, or arbitrary command.
use crate::proposals::Proposal;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

/// A random id for activities and command tokens.
#[must_use]
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const LIMIT: u64 = 2 * 1024 * 1024;
/// Names the file holding the desktop's current address, which changes when it restarts.
pub const ENDPOINT_ENV: &str = "PATCHBAY_AGENT_ENDPOINT";
pub const TOKEN_ENV: &str = "PATCHBAY_AGENT_TOKEN";
pub const CLI_ENV: &str = "PATCHBAY_CLI";
pub const PROJECT_ENV: &str = "PATCHBAY_PROJECT_ID";
pub const TASK_ENV: &str = "PATCHBAY_TASK_ID";
/// Every variable `inject` sets; only the session it was injected for may carry them.
pub const BRIDGE_ENV: [&str; 5] = [ENDPOINT_ENV, TOKEN_ENV, CLI_ENV, PROJECT_ENV, TASK_ENV];

/// Explain missing commands in the terminal banner and retained output.
pub fn unavailable(spec: &mut crate::pty::SessionSpec, reason: &str) {
    let notice = format!("Patchbay agent commands are unavailable: {reason}.");
    spec.notice = Some(match spec.notice.take() {
        Some(previous) => format!("{previous}\n{notice}"),
        None => notice,
    });
}

/// What a token was launched for, looked up from the session that holds it.
#[derive(Clone)]
pub struct LaunchContext {
    pub project_id: String,
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
    #[must_use]
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

type Authenticate = dyn Fn(&str) -> Option<LaunchContext> + Send + Sync;
type Handler = dyn Fn(&LaunchContext, Action) -> Result<Value> + Send + Sync;
/// Tokens aren't kept here: `authenticate` resolves each one to the running session
/// launched with it, so they survive a desktop restart and end with their process.
pub struct Server {
    endpoint: PathBuf,
    stopped: AtomicBool,
}
impl Server {
    /// Listens on a loopback port and records its address in `endpoint`.
    ///
    /// # Errors
    /// Fails if no port can be bound or the endpoint file can't be written.
    pub fn start(
        endpoint: PathBuf,
        authenticate: impl Fn(&str) -> Option<LaunchContext> + Send + Sync + 'static,
        handler: impl Fn(&LaunchContext, Action) -> Result<Value> + Send + Sync + 'static,
    ) -> Result<Arc<Self>> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        crate::workspace::atomic_write(&endpoint, address.to_string().as_bytes())?;
        let server = Arc::new(Self {
            endpoint,
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&server);
        let authenticate: Arc<Authenticate> = Arc::new(authenticate);
        let handler: Arc<Handler> = Arc::new(handler);
        std::thread::spawn(move || {
            Self::listen(weak, authenticate, handler, || {
                listener.accept().map(|(stream, _)| stream)
            });
        });
        Ok(server)
    }
    fn listen(
        weak: std::sync::Weak<Self>,
        authenticate: Arc<Authenticate>,
        handler: Arc<Handler>,
        mut accept: impl FnMut() -> std::io::Result<TcpStream>,
    ) {
        while let Some(server) = weak.upgrade() {
            if server.stopped.load(Ordering::Acquire) {
                break;
            }
            match accept() {
                Ok(stream) => {
                    let authenticate = authenticate.clone();
                    let handler = handler.clone();
                    std::thread::spawn(move || {
                        let _ = server.serve(stream, &*authenticate, &*handler);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                // Interrupted accepts retry immediately; resource pressure and other
                // failures back off, keeping the endpoint usable once they clear.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    /// Adds a fresh token to an agent's environment; record it with the session.
    pub fn inject(
        &self,
        project_id: &str,
        task: Option<&str>,
        cli: &Path,
        env: &mut BTreeMap<String, String>,
    ) {
        env.insert(ENDPOINT_ENV.into(), self.endpoint.display().to_string());
        env.insert(TOKEN_ENV.into(), new_id());
        env.insert(CLI_ENV.into(), cli.display().to_string());
        env.insert(PROJECT_ENV.into(), project_id.into());
        env.insert(TASK_ENV.into(), task.unwrap_or_default().into());
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
    fn serve(
        &self,
        mut stream: TcpStream,
        authenticate: &Authenticate,
        handler: &Handler,
    ) -> Result<()> {
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
            let context = authenticate(&request.token)
                .context("Authentication failed; the agent session has ended or restarted")?;
            handler(&context, request.action)
        })());
        serde_json::to_writer(&mut stream, &response)?;
        stream.write_all(b"\n")?;
        Ok(())
    }
}

/// Sends one request to the desktop at `address`.
///
/// # Errors
/// Fails if the address isn't loopback, the desktop can't be reached, or it
/// answers with something other than a version 1 response.
pub fn call(address: &str, token: &str, action: Action) -> Result<Response> {
    let address: SocketAddr = address
        .trim()
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

/// [`call`] with the endpoint and token an agent terminal was launched with.
///
/// # Errors
/// Fails outside a Patchbay agent terminal, when the desktop isn't running, or as [`call`].
pub fn call_from_env(action: Action) -> Result<Response> {
    let endpoint =
        std::env::var(ENDPOINT_ENV).context("Run agent commands from a Patchbay agent terminal")?;
    let token = std::env::var(TOKEN_ENV).context("Missing Patchbay agent capability")?;
    call_endpoint(Path::new(&endpoint), &token, action)
}

fn call_endpoint(endpoint: &Path, token: &str, action: Action) -> Result<Response> {
    let address = std::fs::read_to_string(endpoint)
        .context("Desktop disconnected; open the launch project in Patchbay")?;
    call(&address, token, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A server whose tokens map to tasks in `tokens`, as the session service would.
    fn server(
        tokens: Arc<Mutex<BTreeMap<String, String>>>,
        handler: impl Fn(&LaunchContext, Action) -> Result<Value> + Send + Sync + 'static,
    ) -> (Arc<Server>, PathBuf) {
        let endpoint = std::env::temp_dir()
            .join(format!("patchbay-bridge-{}", new_id()))
            .join("endpoint");
        let server = Server::start(
            endpoint.clone(),
            move |token| {
                let task = tokens.lock().unwrap().get(token).cloned()?;
                Some(LaunchContext {
                    project_id: "p".into(),
                    agent_session: task.clone(),
                    task: Some(task),
                    planner: false,
                })
            },
            handler,
        )
        .unwrap();
        (server, endpoint)
    }
    fn launch(
        server: &Server,
        tokens: &Mutex<BTreeMap<String, String>>,
        task: &str,
    ) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        server.inject("p", Some(task), Path::new("patchbay"), &mut env);
        tokens
            .lock()
            .unwrap()
            .insert(env[TOKEN_ENV].clone(), task.into());
        env
    }
    fn address(env: &BTreeMap<String, String>) -> String {
        std::fs::read_to_string(&env[ENDPOINT_ENV]).unwrap()
    }

    #[test]
    fn listener_recovers_after_interrupted_and_resource_errors() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = Arc::new(Server {
            endpoint: PathBuf::new(),
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&server);
        let thread = std::thread::spawn(move || {
            let mut errors =
                [std::io::ErrorKind::Interrupted, std::io::ErrorKind::Other].into_iter();
            Server::listen(
                weak,
                Arc::new(|_| {
                    Some(LaunchContext {
                        project_id: "p".into(),
                        task: None,
                        agent_session: "one".into(),
                        planner: false,
                    })
                }),
                Arc::new(|_, _| Ok(serde_json::json!({"recovered":true}))),
                || {
                    if let Some(kind) = errors.next() {
                        return Err(std::io::Error::from(kind));
                    }
                    listener.accept().map(|(stream, _)| stream)
                },
            );
        });
        let result = call(&address.to_string(), "token", Action::Status {}).unwrap();
        assert_eq!(result.result.unwrap()["recovered"], true);
        server.stop();
        thread.join().unwrap();
    }

    #[test]
    fn authenticates_and_binds_requests_to_launch_context() {
        let tokens = Arc::default();
        let (server, endpoint) = server(Arc::clone(&tokens), |context, _| {
            Ok(serde_json::json!({"task":context.task}))
        });
        let first = launch(&server, &tokens, "one");
        let second = launch(&server, &tokens, "two");
        let request = |env: &BTreeMap<String, String>| {
            call(&address(env), &env[TOKEN_ENV], Action::Context {}).unwrap()
        };
        assert_eq!(request(&first).result.unwrap()["task"], "one");
        assert_eq!(request(&second).result.unwrap()["task"], "two");
        assert!(
            !call(&address(&first), "wrong", Action::Status {})
                .unwrap()
                .ok
        );
        // A token the session no longer holds (exited or restarted) stops working.
        tokens.lock().unwrap().remove(&first[TOKEN_ENV]);
        assert!(!request(&first).ok);
        // Unknown context/command fields cannot enter the protocol.
        assert!(
            serde_json::from_value::<Action>(serde_json::json!({"kind":"context","task":"two"}))
                .is_err()
        );
        server.stop();
        let disconnected = call(&address(&second), &second[TOKEN_ENV], Action::Status {});
        assert!(disconnected.is_err() || !disconnected.unwrap().ok);
        let _ = std::fs::remove_dir_all(endpoint.parent().unwrap());
    }

    #[test]
    fn a_restarted_desktop_serves_existing_agents_at_its_new_address() {
        let tokens = Arc::default();
        let ok = |context: &LaunchContext, _| Ok(serde_json::json!({"task":context.task}));
        let (first, endpoint) = server(Arc::clone(&tokens), ok);
        let env = launch(&first, &tokens, "one");
        first.stop();
        drop(first);
        let tokens_again = Arc::clone(&tokens);
        let second = Server::start(
            endpoint.clone(),
            move |token| {
                let task = tokens_again.lock().unwrap().get(token).cloned()?;
                Some(LaunchContext {
                    project_id: "p".into(),
                    agent_session: task.clone(),
                    task: Some(task),
                    planner: false,
                })
            },
            ok,
        )
        .unwrap();
        // The agent's environment is unchanged; the endpoint file follows the desktop.
        let response = call_endpoint(
            Path::new(&env[ENDPOINT_ENV]),
            &env[TOKEN_ENV],
            Action::Context {},
        )
        .unwrap();
        assert_eq!(response.result.unwrap()["task"], "one");
        second.stop();
        let _ = std::fs::remove_dir_all(endpoint.parent().unwrap());
    }

    #[test]
    fn waits_for_a_request_on_an_accepted_socket() {
        let tokens = Arc::default();
        let (server, endpoint) = server(Arc::clone(&tokens), |context, _| {
            Ok(serde_json::json!({"task":context.task}))
        });
        let env = launch(&server, &tokens, "one");
        let mut stream = TcpStream::connect(address(&env)).unwrap();
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
        let _ = std::fs::remove_dir_all(endpoint.parent().unwrap());
    }

    #[test]
    fn failures_are_json_results_and_connection_loss_is_reported() {
        let tokens = Arc::default();
        let (server, endpoint) = server(Arc::clone(&tokens), |_, _| {
            anyhow::bail!("Configured action is busy")
        });
        let env = launch(&server, &tokens, "one");
        let response = call(
            &address(&env),
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
        let _ = std::fs::remove_dir_all(endpoint.parent().unwrap());
    }
}
