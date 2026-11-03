//! Temporary authentication terminals are owned by their webview, outside sessiond.
use super::*;
use patchbay_core::{
    adapters::Adapter,
    provider_auth::{AuthStatus, LaunchContext},
};

const EVENT: &str = "patchbay://provider-login";
#[derive(Clone, Deserialize)]
struct AuthTerminal {
    command: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthRequest {
    provider: Adapter,
    project_id: Option<String>,
    terminal: Option<AuthTerminal>,
    project: Option<Project>,
    component_id: Option<String>,
    task: Option<String>,
    session_id: Option<String>,
    working_directory: Option<PathBuf>,
}
fn resolve(state: &AppState, request: AuthRequest) -> CmdResult<LaunchContext> {
    if let Some(id) = request.session_id {
        let record = state
            .service
            .list()?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Unknown session")?;
        return Ok(LaunchContext {
            provider: request.provider,
            command: record
                .spec
                .resume_command
                .unwrap_or(record.metadata.command),
            cwd: record.spec.cwd,
            env: record
                .spec
                .env
                .into_iter()
                .filter(|(k, _)| !k.starts_with("PATCHBAY_"))
                .collect(),
        });
    }
    let cwd = if let Some(project) = request.project {
        let scoped = state.project(request.project_id.as_deref().ok_or("Missing project")?)?;
        if let Some(directory) = request.working_directory {
            let root = scoped
                .access
                .snapshot()
                .root()
                .ok_or("Project unavailable")?;
            let canonical = directory
                .canonicalize()
                .map_err(|_| "Working directory is missing")?;
            if !git::worktrees(&root)
                .iter()
                .any(|w| Path::new(&w.path) == canonical)
            {
                return Err("Choose a worktree belonging to this project".into());
            }
            return Ok(LaunchContext {
                provider: request.provider,
                command: request.terminal.map_or_else(
                    || match request.provider {
                        Adapter::Claude => "claude".into(),
                        Adapter::Codex => "codex".into(),
                    },
                    |t| t.command,
                ),
                cwd: canonical,
                env: Default::default(),
            });
        }
        let ids: Vec<_> = request
            .component_id
            .clone()
            .filter(|id| project.component(id).is_some())
            .into_iter()
            .collect();
        let project = scoped
            .access
            .snapshot()
            .restrict(project, &ids)
            .map_err(err)?;
        let (project, _, _) = for_task(project, request.task.as_deref(), &ids, scoped.roots())?;
        request
            .component_id
            .as_deref()
            .and_then(|id| project.component(id))
            .map_or_else(
                || PathBuf::from(&project.root),
                |c| project.component_dir(c),
            )
    } else {
        dirs_home()?
    };
    let command = request.terminal.map_or_else(
        || match request.provider {
            Adapter::Claude => "claude".into(),
            Adapter::Codex => "codex".into(),
        },
        |t| t.command,
    );
    let command = if command.starts_with("PATCHBAY_AGENT_PROFILE=") && command.ends_with(" claude")
    {
        patchbay_core::profiles::from_command(&command)
            .map_err(|_| "Invalid provider profile")?
            .map_or_else(
                || Ok(command.clone()),
                |profile| patchbay_core::profiles::command(&profile),
            )
            .map_err(|_| "Invalid provider profile")?
    } else {
        command
    };
    Ok(LaunchContext {
        provider: request.provider,
        command,
        cwd,
        env: Default::default(),
    })
}
fn dirs_home() -> CmdResult<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| "No home directory".into())
}
fn login_id(window: &WebviewWindow, id: &str) -> CmdResult<String> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("Invalid login session".into());
    }
    Ok(format!("{}/{}", window.label(), id))
}
#[tauri::command]
pub(crate) async fn provider_auth_check(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AuthRequest,
    force: Option<bool>,
) -> CmdResult<AuthStatus> {
    let manager = state.provider_auth.clone();
    // Resolution may contact sessiond; keep that off the async runtime.
    blocking(move || {
        let context = resolve(&app.state::<AppState>(), request)?;
        Ok(manager.check(&context, force.unwrap_or(false)))
    })
    .await
}
#[tauri::command]
pub(crate) async fn provider_login_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: AuthRequest,
    id: String,
) -> CmdResult<()> {
    let session_id = login_id(&window, &id)?;
    let manager = state.provider_auth.clone();
    blocking(move || {
        let context = resolve(&window.state::<AppState>(), request)?;
        let sink_window = window.clone();
        manager
            .login(
                &session_id,
                &context,
                Arc::new(move |event| {
                    let _ = sink_window.emit(EVENT, &event);
                }),
            )
            .map_err(|_| {
                "The sign-in terminal could not start. Check the provider CLI and try again."
                    .to_string()
            })?;
        // A close can race a slow spawn. Never leave its login process behind.
        if window
            .app_handle()
            .get_webview_window(window.label())
            .is_none()
        {
            manager.cancel(&session_id);
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub(crate) async fn provider_login_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<()> {
    let id = login_id(&window, &id)?;
    let manager = state.provider_auth.clone();
    blocking(move || {
        manager.cancel(&id);
        Ok(())
    })
    .await
}
#[tauri::command]
pub(crate) fn provider_login_write(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> CmdResult<()> {
    state
        .provider_auth
        .write(&login_id(&window, &id)?, data.as_bytes())
        .map_err(|_| "Login has ended".into())
}
#[tauri::command]
pub(crate) fn provider_login_resize(
    window: WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state
        .provider_auth
        .resize(
            &login_id(&window, &id)?,
            cols.clamp(2, 500),
            rows.clamp(2, 200),
        )
        .map_err(|_| "Login has ended".into())
}
