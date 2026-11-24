//! Debug-only: serve the frontend from the Vite port the launcher chose, compiled out of release
//! builds.
//!
//! `scripts/tauri.mjs` and the smoke runner pick a free port (`scripts/dev-port.mjs`) and pass it
//! in `PATCHBAY_DEV_PORT`, so several worktrees can run the app at once without rebuilding it for
//! a different `devUrl`.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use patchbay_core::pty::DEV_PORT_ENV as PORT_ENV;
/// The launcher skips the Tauri CLI's wait, which only knows the configured `devUrl`.
const WAIT: Duration = Duration::from_secs(60);

/// Points `devUrl` at `PATCHBAY_DEV_PORT`, if set, and waits for that server to answer.
pub fn apply<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let Ok(value) = std::env::var(PORT_ENV) else {
        return;
    };
    let Some(port) = value.parse::<u16>().ok().filter(|&p| p != 0) else {
        eprintln!("Ignoring {PORT_ENV}={value}: not a port");
        return;
    };
    let Ok(url) = format!("http://localhost:{port}").parse::<tauri::Url>() else {
        return;
    };
    context.config_mut().build.dev_url = Some(url);
    let deadline = Instant::now() + WAIT;
    while !answers(port) {
        if Instant::now() >= deadline {
            eprintln!("Nothing answers on port {port}; loading the frontend anyway");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn answers(port: u16) -> bool {
    ("localhost", port)
        .to_socket_addrs()
        .is_ok_and(|mut addrs| {
            addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn answers_only_while_something_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(answers(port));
        drop(listener);
        assert!(!answers(port));
    }
}
