//! Session power managers can initiate suspend independently of logind's idle action.
//! Inhibit suspend only (GNOME flag 4), leaving display idle and screen locking alone.
use zbus::blocking::{Connection, Proxy};

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
        for (destination, path, interface, release, api) in [
            (
                "org.gnome.SessionManager",
                "/org/gnome/SessionManager",
                "org.gnome.SessionManager",
                "Uninhibit",
                0,
            ),
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
            let cookie: zbus::Result<u32> = if api == 0 {
                proxy.call(
                    "Inhibit",
                    &(
                        "dev.patchbay.desktop",
                        0_u32,
                        "Auto work or scheduled resume",
                        4_u32,
                    ),
                )
            } else if api == 1 {
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
