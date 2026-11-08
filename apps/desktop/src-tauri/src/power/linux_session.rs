//! Session power managers can initiate suspend independently of logind's idle action.
//! Only use session inhibitors that preserve explicit suspend requests.
use zbus::blocking::{Connection, Proxy, fdo::DBusProxy};

pub struct Inhibitor {
    connection: Connection,
    destination: &'static str,
    path: &'static str,
    interface: &'static str,
    release: &'static str,
    cookie: u32,
}

impl Inhibitor {
    pub fn acquire() -> Result<Self, String> {
        let connection = Connection::session().map_err(|e| e.to_string())?;
        Self::acquire_on(connection)
    }

    fn acquire_on(connection: Connection) -> Result<Self, String> {
        // GNOME's suspend flag becomes a logind sleep/block inhibitor, which also
        // rejects manual suspend. Reject the session before trying any fallback
        // interfaces, which may be implemented by the same session manager.
        let bus = DBusProxy::new(&connection).map_err(|e| e.to_string())?;
        let gnome_running = bus
            .name_has_owner("org.gnome.SessionManager".try_into().unwrap())
            .map_err(|e| e.to_string())?;
        drop(bus);
        if gnome_running {
            return Err(
                "Idle-only sleep prevention is unavailable on GNOME; manual sleep remains available"
                    .into(),
            );
        }
        for (destination, path, interface, release, api) in [
            (
                "org.kde.Solid.PowerManagement",
                "/org/kde/Solid/PowerManagement/PolicyAgent",
                "org.kde.Solid.PowerManagement.PolicyAgent",
                "ReleaseInhibition",
                1,
            ),
            (
                "org.freedesktop.PowerManagement.Inhibit",
                "/org/freedesktop/PowerManagement/Inhibit",
                "org.freedesktop.PowerManagement.Inhibit",
                "UnInhibit",
                2,
            ),
        ] {
            let proxy =
                Proxy::new(&connection, destination, path, interface).map_err(|e| e.to_string())?;
            let cookie: zbus::Result<u32> = if api == 1 {
                // KDE InterruptSession policy (1) does not inhibit display power management.
                proxy.call(
                    "AddInhibition",
                    &(1_u32, "Patchbay", "Auto work or scheduled resume"),
                )
            } else {
                proxy.call("Inhibit", &("Patchbay", "Auto work or scheduled resume"))
            };
            if let Ok(cookie) = cookie {
                drop(proxy);
                return Ok(Self {
                    connection,
                    destination,
                    path,
                    interface,
                    release,
                    cookie,
                });
            }
        }
        Err("Desktop session does not provide suspend inhibition".into())
    }
}

impl Drop for Inhibitor {
    fn drop(&mut self) {
        if let Ok(proxy) = Proxy::new(
            &self.connection,
            self.destination,
            self.path,
            self.interface,
        ) {
            let _: zbus::Result<()> = proxy.call(self.release, &(self.cookie,));
        }
        // Closing the dedicated connection also lets the session manager clean up the cookie.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};
    use zbus::blocking::connection::Builder;

    struct SessionBus {
        gnome_running: bool,
    }

    #[zbus::interface(name = "org.freedesktop.DBus")]
    impl SessionBus {
        fn name_has_owner(&self, name: &str) -> bool {
            assert_eq!(name, "org.gnome.SessionManager");
            self.gnome_running
        }
    }

    struct PolicyAgent(Arc<Mutex<Vec<&'static str>>>);

    #[zbus::interface(name = "org.kde.Solid.PowerManagement.PolicyAgent")]
    impl PolicyAgent {
        fn add_inhibition(&self, policy: u32, app: &str, reason: &str) -> u32 {
            assert_eq!(policy, 1);
            assert_eq!(app, "Patchbay");
            assert!(!reason.is_empty());
            self.0.lock().unwrap().push("acquire");
            42
        }

        fn release_inhibition(&self, cookie: u32) {
            assert_eq!(cookie, 42);
            self.0.lock().unwrap().push("release");
        }
    }

    // A private D-Bus peer exercises the real proxy calls without a running desktop.
    fn session(
        gnome_running: bool,
        calls: Arc<Mutex<Vec<&'static str>>>,
    ) -> (Connection, Connection) {
        let (server, client) = UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || {
            Builder::async_io_unix_stream(server)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at("/org/freedesktop/DBus", SessionBus { gnome_running })
                .unwrap()
                .serve_at(
                    "/org/kde/Solid/PowerManagement/PolicyAgent",
                    PolicyAgent(calls),
                )
                .unwrap()
                .build()
                .unwrap()
        });
        let client = Builder::async_io_unix_stream(client).p2p().build().unwrap();
        (server.join().unwrap(), client)
    }

    #[test]
    fn gnome_is_unavailable_even_when_a_fallback_inhibitor_is_offered() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (_server, connection) = session(true, calls.clone());
        let result = Inhibitor::acquire_on(connection);
        assert!(matches!(result, Err(error) if error.contains("unavailable on GNOME")));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn supported_session_acquires_and_releases_its_cookie() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (_server, connection) = session(false, calls.clone());
        let inhibitor = Inhibitor::acquire_on(connection).unwrap();
        assert_eq!(*calls.lock().unwrap(), ["acquire"]);
        drop(inhibitor);
        assert_eq!(*calls.lock().unwrap(), ["acquire", "release"]);
    }
}
