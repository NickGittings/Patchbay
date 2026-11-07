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
    pub role: Role,
}

/// What kind of session holds a token, which decides the actions it may run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// A component's or task root's agent.
    Component,
    Scanner,
    Coordinator,
    Worker,
    /// The project's planner (`PLAN_SCOPE`): it saves plans and proposals, and runs nothing.
    Planner,
    /// Map detection (`MAP_SCOPE`): it may only read context and submit what its terminal
    /// detects.
    Mapper(Proposes),
}

/// What a map detection session may submit, decided by its terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proposes {
    /// Dependency detection (`link_proposals::MAP_TERMINAL`).
    Links,
    /// Stack detection (`stack_proposals::STACK_TERMINAL`).
    Stack,
    Validation,
    /// Any other terminal at `MAP_SCOPE`.
    Nothing,
}

impl Role {
    /// The role of a session at `component_id` running `terminal_id`.
    #[must_use]
    pub fn of(component_id: &str, terminal_id: &str) -> Self {
        match component_id {
            crate::model::PLAN_SCOPE => Self::Planner,
            crate::model::SCAN_SCOPE => Self::Scanner,
            crate::model::COORDINATOR_SCOPE => Self::Coordinator,
            crate::model::WORKER_SCOPE => Self::Worker,
            crate::model::MAP_SCOPE => Self::Mapper(match terminal_id {
                crate::link_proposals::MAP_TERMINAL => Proposes::Links,
                crate::stack_proposals::STACK_TERMINAL => Proposes::Stack,
                crate::validation_proposals::VALIDATION_TERMINAL => Proposes::Validation,
                _ => Proposes::Nothing,
            }),
            _ => Self::Component,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    ProviderRun {
        command: crate::orchestration::Command,
    },
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
    ValidateSelected {
        #[serde(rename = "componentIds")]
        component_ids: Vec<String>,
    },
    ValidateChanged {
        #[serde(rename = "componentIds")]
        component_ids: Vec<String>,
    },
    Propose {
        proposal: Proposal,
    },
    /// A native plan from the planner's provider: `presented` while its approval
    /// dialog is open, else approved. `conversation` is the provider's, so a nested
    /// run in the planner's terminal can't replace the plan.
    SavePlan {
        plan: String,
        conversation: Option<String>,
        #[serde(default)]
        presented: bool,
    },
    /// The provider's approval dialog closed without approving the presented plan.
    WithdrawPlan {
        conversation: Option<String>,
    },
    /// Dependencies a detection agent proposes for the user to review.
    ProposeLinks {
        proposal: crate::link_proposals::LinkProposal,
    },
    /// A local stack a detection agent proposes for the user to review.
    ProposeValidation {
        proposal: crate::validation_proposals::ValidationProposal,
    },
    ProposeStack {
        proposal: crate::stack_proposals::StackProposal,
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
                error: Some(format!("{error:#}")),
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
                "Patchbay desktop bridge is shutting down; reopen Patchbay and try again"
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
    // Configured validators can take time; connection loss still returns EOF immediately.
    call_within(address, token, action, Duration::from_secs(3600))
}

fn call_within(address: &str, token: &str, action: Action, wait: Duration) -> Result<Response> {
    call_via(address, token, action, wait, managed_proxy()?.as_deref())
}

fn call_via(
    address: &str,
    token: &str,
    action: Action,
    wait: Duration,
    proxy: Option<&str>,
) -> Result<Response> {
    let address: SocketAddr = address
        .trim()
        .parse()
        .context("Invalid Patchbay desktop connection address in endpoint file; restart Patchbay to refresh it")?;
    ensure!(address.ip().is_loopback(), "Desktop bridge must be local");
    let mut stream = connect(address, wait, proxy)?;
    stream
        .set_read_timeout(Some(wait))
        .context("Could not configure desktop response timeout")?;
    stream
        .set_write_timeout(Some(wait.min(Duration::from_secs(10))))
        .context("Could not configure desktop request timeout")?;
    serde_json::to_writer(
        &mut stream,
        &Request {
            version: 1,
            token: token.into(),
            action,
        },
    )
    .with_context(|| format!("Could not send request to Patchbay desktop at {address}; the request outcome is unknown"))?;
    stream.write_all(b"\n").with_context(|| {
        format!("Could not finish sending request to Patchbay desktop at {address}; the request outcome is unknown")
    })?;
    let mut line = String::new();
    BufReader::new(stream.take(16 * LIMIT))
        .read_line(&mut line)
        .with_context(|| format!("Could not read response from Patchbay desktop at {address} (response timeout: {} seconds); the request outcome is unknown", wait.as_secs_f64()))?;
    ensure!(
        !line.is_empty(),
        "Patchbay desktop at {address} closed the connection without a response; the request outcome is unknown. Reopen Patchbay and inspect the action status before retrying"
    );
    let response: Response = serde_json::from_str(&line)
        .context("Invalid response from Patchbay desktop; expected a version 1 JSON response. The request outcome is unknown")?;
    ensure!(
        response.version == 1,
        "Unsupported Patchbay desktop response version {}; expected version 1. Use matching desktop and CLI versions; the request outcome is unknown",
        response.version
    );
    Ok(response)
}

/// Only Codex's explicit marker opts into proxying. Other providers and ordinary
/// shell proxy settings retain the direct bridge connection. Never bypass a
/// managed proxy after a rejection or connection failure.
fn managed_proxy() -> Result<Option<String>> {
    proxy_setting(
        std::env::var(crate::agent_hooks::PROVIDER_ENV)
            .ok()
            .as_deref(),
        std::env::var("CODEX_NETWORK_PROXY_ACTIVE").ok().as_deref(),
        std::env::var("ALL_PROXY")
            .or_else(|_| std::env::var("all_proxy"))
            .ok(),
    )
}

fn proxy_setting(
    provider: Option<&str>,
    active: Option<&str>,
    proxy: Option<String>,
) -> Result<Option<String>> {
    if provider != Some("codex") || active.is_none() || active == Some("0") {
        return Ok(None);
    }
    ensure!(
        active == Some("1"),
        "Unrecognized Codex managed network marker; restart the agent session"
    );
    let proxy = proxy
        .context("Codex managed networking is active but its SOCKS proxy is missing; restart the agent session to receive updated launch settings")?;
    Ok(Some(proxy))
}

fn connect(address: SocketAddr, wait: Duration, proxy: Option<&str>) -> Result<TcpStream> {
    let Some(proxy) = proxy else {
        return TcpStream::connect_timeout(&address, wait.min(Duration::from_secs(2)))
            .map_err(|error| connection_error(address, error));
    };
    let proxy = url::Url::parse(proxy).context("Invalid Codex managed SOCKS proxy URL")?;
    ensure!(
        matches!(proxy.scheme(), "socks5" | "socks5h")
            && proxy.username().is_empty()
            && proxy.password().is_none(),
        "Codex managed networking requires an unauthenticated SOCKS5 proxy; restart the agent session or check its network policy"
    );
    // Managed Codex listeners are local. Never send a bridge capability to an
    // arbitrary proxy from an inherited environment variable.
    let host = proxy.host_str().context("Missing Codex SOCKS proxy host")?;
    let ip: std::net::IpAddr = host
        .trim_matches(['[', ']'])
        .parse()
        .context("Codex managed SOCKS proxy must use a loopback IP address")?;
    ensure!(ip.is_loopback(), "Codex managed SOCKS proxy must be local");
    let port = proxy.port().context("Missing Codex SOCKS proxy port")?;
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::new(ip, port),
        wait.min(Duration::from_secs(2)),
    ).context("Could not connect to Codex managed SOCKS proxy; restart the agent session to receive updated launch settings")?;
    stream.set_read_timeout(Some(wait.min(Duration::from_secs(2))))?;
    stream.set_write_timeout(Some(wait.min(Duration::from_secs(2))))?;
    socks_connect(&mut stream, address).context("Could not reach Patchbay desktop through Codex managed SOCKS proxy; check the loopback allowance and managed network policy. Restart the agent session after changing launch settings")?;
    Ok(stream)
}

fn socks_connect(stream: &mut TcpStream, address: SocketAddr) -> Result<()> {
    stream.write_all(&[5, 1, 0])?; // SOCKS5, one method, no authentication.
    let mut greeting = [0; 2];
    stream.read_exact(&mut greeting)?;
    ensure!(
        greeting == [5, 0],
        "Codex SOCKS proxy rejected unauthenticated SOCKS5"
    );
    let mut request = vec![5, 1, 0]; // CONNECT; the destination is always loopback.
    match address.ip() {
        std::net::IpAddr::V4(ip) => {
            request.push(1);
            request.extend(ip.octets());
        }
        std::net::IpAddr::V6(ip) => {
            request.push(4);
            request.extend(ip.octets());
        }
    }
    request.extend(address.port().to_be_bytes());
    stream.write_all(&request)?;
    let mut reply = [0; 4];
    stream.read_exact(&mut reply)?;
    ensure!(
        reply[0] == 5 && reply[2] == 0,
        "Invalid Codex SOCKS5 response"
    );
    match reply[1] {
        0 => {}
        2 => anyhow::bail!(
            "Codex SOCKS proxy denied the Patchbay loopback destination under its network policy"
        ),
        5 => anyhow::bail!(
            "Patchbay desktop refused the proxied connection; start or reopen Patchbay and try again"
        ),
        code => anyhow::bail!(
            "Codex SOCKS proxy could not connect to Patchbay desktop (SOCKS5 reply {code})"
        ),
    }
    let size = match reply[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut length = [0];
            stream.read_exact(&mut length)?;
            usize::from(length[0])
        }
        _ => anyhow::bail!("Invalid Codex SOCKS5 address type"),
    };
    let mut bound = vec![0; size + 2];
    stream.read_exact(&mut bound)?;
    Ok(())
}

fn connection_error(address: SocketAddr, error: std::io::Error) -> anyhow::Error {
    let message = if error.kind() == std::io::ErrorKind::PermissionDenied {
        format!(
            "Permission denied connecting to Patchbay desktop at {address}; check the agent's \
             sandbox and managed network policy. Restart the agent session after changing its \
             launch settings; reopening the desktop does not update a running agent's permissions. \
             Codex scoped networking requires its managed SOCKS proxy and a loopback allowance; \
             this requires support from the installed Codex version and managed policy"
        )
    } else {
        format!(
            "Could not connect to Patchbay desktop at {address}; start or reopen Patchbay and try again"
        )
    };
    anyhow::Error::new(error).context(message)
}

/// [`call`] with the endpoint and token an agent terminal was launched with.
///
/// # Errors
/// Fails outside a Patchbay agent terminal, when the desktop isn't running, or as [`call`].
pub fn call_from_env(action: Action) -> Result<Response> {
    call_from_env_within(action, Duration::from_secs(3600))
}

/// [`call_from_env`] that waits at most `wait` to connect and again for the answer,
/// for provider hooks, which must finish within their own timeout.
///
/// # Errors
/// As [`call_from_env`], or when the desktop doesn't answer in time.
pub fn call_from_env_within(action: Action, wait: Duration) -> Result<Response> {
    let endpoint =
        std::env::var(ENDPOINT_ENV).context("Run agent commands from a Patchbay agent terminal")?;
    let token = std::env::var(TOKEN_ENV).context("Missing Patchbay agent capability")?;
    call_endpoint(Path::new(&endpoint), &token, action, wait)
}

fn call_endpoint(endpoint: &Path, token: &str, action: Action, wait: Duration) -> Result<Response> {
    let address = std::fs::read_to_string(endpoint).with_context(|| {
        format!(
            "Could not read Patchbay desktop endpoint file {}; start or reopen Patchbay and try again",
            endpoint.display()
        )
    })?;
    call_within(&address, token, action, wait)
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
                    role: Role::Component,
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
    fn link_proposals_have_a_strict_wire_format() {
        let wire = serde_json::json!({"kind":"proposeLinks","proposal":{"version":1,
            "links":[{"source":"app","target":"api","label":"REST","reason":"App/API.swift:3"}]}});
        let action: Action = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&action).unwrap(), wire);
        let mut extra = wire;
        extra["proposal"]["links"][0]["confidence"] = 1.into();
        assert!(serde_json::from_value::<Action>(extra).is_err());
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
                        role: Role::Component,
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
                    role: Role::Component,
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
            Duration::from_secs(5),
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

    /// Consume the complete request before replying so EOF tests do not depend on
    /// platform-specific connection resets caused by unread socket data.
    fn with_desktop(reply: impl FnOnce(TcpStream) + Send + 'static, check: impl FnOnce(&str)) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = String::new();
            BufReader::new(&stream).read_line(&mut request).unwrap();
            reply(stream);
        });
        check(&address);
        thread.join().unwrap();
    }

    #[test]
    fn response_preserves_error_chain_and_json_shape() {
        let error = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let cause = error.to_string();
        let response = Response::from_result(Err(
            anyhow::Error::new(error).context("Could not read desktop endpoint")
        ));
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["ok"], false);
        assert!(json["result"].is_null());
        let message = json["error"].as_str().unwrap();
        assert!(message.contains("Could not read desktop endpoint"));
        assert!(message.contains(&cause));
    }

    #[test]
    fn missing_endpoint_reports_path_and_recovery() {
        let endpoint = std::env::temp_dir().join(format!("missing-endpoint-{}", new_id()));
        let error = call_endpoint(
            &endpoint,
            "secret-token",
            Action::Status {},
            Duration::from_secs(1),
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains(&endpoint.display().to_string()));
        assert!(message.contains("Could not read"));
        assert!(message.contains("start or reopen Patchbay"));
        assert!(error.chain().count() > 1);
        assert!(!message.contains("secret-token"));
    }

    #[test]
    fn invalid_endpoint_address_reports_parse_failure() {
        let error = call("invalid-address", "secret-token", Action::Status {}).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid Patchbay desktop connection address")
        );
        assert!(error.chain().count() > 1);
    }

    #[test]
    fn refused_connection_reports_address_and_cause() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        drop(listener);
        let error = call(&address, "secret-token", Action::Status {}).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("Could not connect"));
        assert!(message.contains(&address));
        assert!(message.contains("start or reopen Patchbay"));
        assert!(error.chain().count() > 1);
        assert!(!message.contains("secret-token"));
        assert!(!message.contains("Permission denied"));
        assert!(!message.contains("Restart the agent session"));
    }

    #[test]
    fn denied_connection_explains_network_policy_and_session_restart() {
        let address = "127.0.0.1:12345".parse().unwrap();
        let cause = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let expected = cause.to_string();
        let error = connection_error(address, cause);
        let message = format!("{error:#}");
        assert!(message.contains("Permission denied connecting"));
        assert!(message.contains(&address.to_string()));
        assert!(message.contains("sandbox and managed network policy"));
        assert!(message.contains("Restart the agent session"));
        assert!(message.contains("reopening the desktop does not update"));
        assert!(message.contains("managed SOCKS proxy and a loopback allowance"));
        assert!(message.contains(&expected));
        assert_eq!(error.chain().count(), 2);
        assert!(!message.contains("start or reopen Patchbay"));
    }

    #[cfg(unix)]
    #[test]
    fn os_permission_errors_are_not_reported_as_an_unavailable_desktop() {
        // EPERM and EACCES are both used by Unix sandbox implementations.
        for errno in [1, 13] {
            let error = connection_error(
                "127.0.0.1:12345".parse().unwrap(),
                std::io::Error::from_raw_os_error(errno),
            );
            assert!(error.to_string().contains("Permission denied connecting"));
            assert_eq!(
                error
                    .downcast_ref::<std::io::Error>()
                    .unwrap()
                    .raw_os_error(),
                Some(errno)
            );
        }
    }

    #[test]
    fn only_codex_managed_networking_selects_a_proxy() {
        let proxy = Some("socks5h://127.0.0.1:8081".into());
        for provider in [None, Some("claude"), Some("other")] {
            assert_eq!(
                proxy_setting(provider, Some("1"), proxy.clone()).unwrap(),
                None
            );
        }
        assert_eq!(
            proxy_setting(Some("codex"), None, proxy.clone()).unwrap(),
            None
        );
        assert_eq!(
            proxy_setting(Some("codex"), Some("0"), proxy.clone()).unwrap(),
            None
        );
        assert_eq!(
            proxy_setting(Some("codex"), Some("1"), proxy.clone()).unwrap(),
            proxy
        );
        assert!(proxy_setting(Some("codex"), Some("1"), None).is_err());
        assert!(proxy_setting(Some("codex"), Some("unexpected"), proxy).is_err());
    }

    /// A mock proxy validates the request, with short reads on the client, and
    /// returns its CONNECT header plus any tunneled data supplied by the test.
    fn with_proxy(
        destination: SocketAddr,
        reply: Vec<u8>,
        serve: impl FnOnce(TcpStream) + Send + 'static,
        check: impl FnOnce(&str),
    ) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!("socks5h://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 1, 0]);
            stream.write_all(&[5, 0]).unwrap();
            let size = if destination.is_ipv4() { 10 } else { 22 };
            let mut request = vec![0; size];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(&request[..3], &[5, 1, 0]);
            match destination.ip() {
                std::net::IpAddr::V4(ip) => {
                    assert_eq!(request[3], 1);
                    assert_eq!(&request[4..8], ip.octets());
                }
                std::net::IpAddr::V6(ip) => {
                    assert_eq!(request[3], 4);
                    assert_eq!(&request[4..20], ip.octets());
                }
            }
            assert_eq!(&request[size - 2..], destination.port().to_be_bytes());
            for byte in reply {
                stream.write_all(&[byte]).unwrap();
            }
            serve(stream);
        });
        check(&url);
        thread.join().unwrap();
    }

    #[test]
    fn socks_tunnels_ipv4_and_ipv6_without_consuming_bridge_data() {
        for destination in ["127.0.0.1:12345", "[::1]:12345"] {
            for bound in [
                vec![1, 127, 0, 0, 1, 0, 1],
                vec![4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
                vec![3, 3, b'a', b'b', b'c', 0, 1],
            ] {
                let address = destination.parse().unwrap();
                let mut reply = vec![5, 0, 0];
                reply.extend(bound);
                reply.extend(b"bridge");
                with_proxy(
                    address,
                    reply,
                    |_| {},
                    |proxy| {
                        let mut stream =
                            connect(address, Duration::from_secs(5), Some(proxy)).unwrap();
                        let mut bytes = [0; 6];
                        stream.read_exact(&mut bytes).unwrap();
                        assert_eq!(&bytes, b"bridge");
                    },
                );
            }
        }
    }

    #[test]
    fn socks_keeps_the_authenticated_version_one_bridge_protocol() {
        let destination = "127.0.0.1:12345".parse().unwrap();
        with_proxy(
            destination,
            vec![5, 0, 0, 1, 127, 0, 0, 1, 0, 1],
            |mut stream| {
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Request = serde_json::from_str(&line).unwrap();
                assert_eq!(request.version, 1);
                assert_eq!(request.token, "launch-capability");
                assert!(matches!(request.action, Action::Status {}));
                stream
                    .write_all(b"{\"version\":1,\"ok\":true,\"result\":{\"proxied\":true}}\n")
                    .unwrap();
            },
            |proxy| {
                let response = call_via(
                    &destination.to_string(),
                    "launch-capability",
                    Action::Status {},
                    Duration::from_secs(5),
                    Some(proxy),
                )
                .unwrap();
                assert_eq!(response.result.unwrap()["proxied"], true);
            },
        );
    }

    #[test]
    fn socks_denials_and_protocol_failures_never_fall_back_to_direct_tcp() {
        let desktop = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        desktop.set_nonblocking(true).unwrap();
        let address = desktop.local_addr().unwrap();
        for (reply, expected) in [
            (vec![5, 2, 0, 1], "denied the Patchbay loopback destination"),
            (vec![5, 5, 0, 1], "start or reopen Patchbay"),
            (vec![4, 0, 0, 1], "Invalid Codex SOCKS5 response"),
            (vec![5, 0, 1, 1], "Invalid Codex SOCKS5 response"),
            (vec![5, 0, 0, 2], "Invalid Codex SOCKS5 address type"),
            (vec![5, 0], "failed to fill whole buffer"),
        ] {
            with_proxy(
                address,
                reply,
                |_| {},
                |proxy| {
                    let error = call_via(
                        &address.to_string(),
                        "secret-token",
                        Action::Status {},
                        Duration::from_secs(5),
                        Some(proxy),
                    )
                    .unwrap_err();
                    let message = format!("{error:#}");
                    assert!(message.contains(expected), "{message}");
                    assert!(!message.contains("secret-token"));
                    assert_eq!(
                        desktop.accept().unwrap_err().kind(),
                        std::io::ErrorKind::WouldBlock
                    );
                },
            );
        }
    }

    #[test]
    fn malformed_or_nonlocal_proxy_settings_are_rejected_without_leaking_credentials() {
        for proxy in [
            "http://127.0.0.1:8081",
            "socks5h://example.com:8081",
            "socks5h://192.168.1.1:8081",
            "socks5h://user:secret-token@127.0.0.1:8081",
            "socks5h://127.0.0.1",
            "not a URL",
        ] {
            let error = connect(
                "127.0.0.1:12345".parse().unwrap(),
                Duration::from_millis(10),
                Some(proxy),
            )
            .unwrap_err();
            assert!(!format!("{error:#}").contains("secret-token"));
        }
    }

    #[test]
    fn eof_reports_unknown_request_outcome() {
        with_desktop(drop, |address| {
            let error = call(address, "secret-token", Action::Status {}).unwrap_err();
            let message = error.to_string();
            assert!(message.contains(address));
            assert!(message.contains("closed the connection without a response"));
            assert!(message.contains("outcome is unknown"));
        });
    }

    #[test]
    fn read_timeout_reports_phase_and_unknown_outcome() {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        with_desktop(
            move |_stream| {
                let _ = wait.recv_timeout(Duration::from_secs(5));
            },
            |address| {
                let error = call_within(
                    address,
                    "secret-token",
                    Action::Status {},
                    Duration::from_millis(30),
                )
                .unwrap_err();
                release.send(()).unwrap();
                let message = format!("{error:#}");
                assert!(message.contains("Could not read response"));
                assert!(message.contains(address));
                assert!(message.contains("response timeout: 0.03 seconds"));
                assert!(message.contains("outcome is unknown"));
                assert!(error.chain().count() > 1);
            },
        );
    }

    #[test]
    fn malformed_response_reports_protocol_failure() {
        with_desktop(
            |mut stream| {
                stream.write_all(b"not-json\n").unwrap();
            },
            |address| {
                let error = call(address, "secret-token", Action::Status {}).unwrap_err();
                assert!(
                    error
                        .to_string()
                        .contains("Invalid response from Patchbay desktop")
                );
                assert!(error.to_string().contains("outcome is unknown"));
                assert!(error.chain().count() > 1);
            },
        );
    }

    #[test]
    fn unsupported_response_version_reports_versions() {
        with_desktop(
            |mut stream| {
                stream
                    .write_all(b"{\"version\":2,\"ok\":true,\"result\":null,\"error\":null}\n")
                    .unwrap();
            },
            |address| {
                let error = call(address, "secret-token", Action::Status {}).unwrap_err();
                assert!(
                    error
                        .to_string()
                        .contains("response version 2; expected version 1")
                );
                assert!(error.to_string().contains("outcome is unknown"));
            },
        );
    }

    #[test]
    fn stopped_bridge_reports_shutdown() {
        let tokens = Arc::default();
        let (server, endpoint) = server(tokens, |_, _| panic!("Stopped server must not dispatch"));
        server.stop();
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            server
                .serve(stream, &|_| None, &|_, _| unreachable!())
                .unwrap();
        });
        let response = call(&address, "secret-token", Action::Status {}).unwrap();
        assert!(!response.ok);
        assert!(response.error.unwrap().contains("bridge is shutting down"));
        thread.join().unwrap();
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
