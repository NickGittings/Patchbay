//! Desktop-only idle-sleep inhibition. The worker owns native handles so Windows
//! thread-local power assertions are acquired and released on the same thread.
use serde::Serialize;
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const POLL: Duration = Duration::from_secs(5);
const LEASE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Status {
    Inactive,
    Active,
    OnBattery,
    PowerUnknown,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Report {
    status: Status,
    error: Option<String>,
}

#[derive(Default)]
struct Control {
    sender: Option<mpsc::Sender<bool>>,
    closed: bool,
}

#[derive(Default)]
pub struct PowerManager(Mutex<Control>);

impl PowerManager {
    pub fn close(&self) {
        if let Ok(mut control) = self.0.lock() {
            control.closed = true;
            control.sender.take(); // Disconnect wakes the worker and drops its assertion.
        }
    }
}

#[tauri::command]
pub fn set_auto_keep_awake_demand(
    window: tauri::WebviewWindow,
    enabled: bool,
    needed: bool,
    manager: tauri::State<'_, PowerManager>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("power management belongs to the main window".into());
    }
    let mut control = manager.0.lock().map_err(|e| e.to_string())?;
    if control.closed {
        return Err("main window closed".into());
    }
    if control.sender.is_none() {
        let (sender, receiver) = mpsc::channel();
        let app = window.app_handle().clone();
        std::thread::spawn(move || {
            let mut awake = None;
            let mut demand = false;
            let mut refreshed = Instant::now();
            loop {
                match receiver.recv_timeout(POLL) {
                    Ok(value) => {
                        demand = value;
                        refreshed = Instant::now();
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                let report = reconcile(
                    &mut awake,
                    demand && refreshed.elapsed() < LEASE,
                    external_power,
                    acquire,
                );
                let _ = app.emit_to("main", "auto-power-status", report);
            }
        });
        control.sender = Some(sender);
    }
    control
        .sender
        .as_ref()
        .unwrap()
        .send(enabled && needed)
        .map_err(|e| e.to_string())
}

struct Awake {
    _idle: keepawake::KeepAwake,
    #[cfg(target_os = "linux")]
    _session: linux_session::Inhibitor,
}

fn acquire() -> Result<Awake, String> {
    let idle = keepawake::Builder::default()
        .idle(true)
        .display(false)
        .sleep(false)
        .app_name("Patchbay")
        .app_reverse_domain("dev.patchbay.desktop")
        .reason("Auto work or scheduled resume")
        .create()
        .map_err(|e| e.to_string())?;
    Ok(Awake {
        _idle: idle,
        #[cfg(target_os = "linux")]
        _session: linux_session::Inhibitor::acquire()?,
    })
}

#[cfg(target_os = "linux")]
mod linux_session;

fn reconcile<T>(
    awake: &mut Option<T>,
    needed: bool,
    power: impl FnOnce() -> Option<bool>,
    acquire: impl FnOnce() -> Result<T, String>,
) -> Report {
    let mut error = None;
    let status = if !needed {
        Status::Inactive
    } else {
        match power() {
            Some(false) => Status::OnBattery,
            None => Status::PowerUnknown,
            Some(true) => {
                if awake.is_none() {
                    match acquire() {
                        Ok(handle) => *awake = Some(handle),
                        Err(e) => error = Some(e),
                    }
                }
                if awake.is_some() {
                    Status::Active
                } else {
                    Status::Unavailable
                }
            }
        }
    };
    if status != Status::Active {
        awake.take();
    }
    Report { status, error }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn external_power() -> Option<bool> {
    use objc2_io_kit::{IOPSCopyPowerSourcesInfo, IOPSGetProvidingPowerSourceType};
    let snapshot = IOPSCopyPowerSourcesInfo()?;
    // SAFETY: snapshot was returned by IOPSCopyPowerSourcesInfo and lives through this call.
    let source = unsafe { IOPSGetProvidingPowerSourceType(Some(&snapshot)) }?;
    match source.to_string().as_str() {
        "AC Power" => Some(true),
        "Battery Power" | "UPS Power" => Some(false),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn external_power() -> Option<bool> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: status points to a writable, correctly sized native structure.
    unsafe { GetSystemPowerStatus(&mut status) }.ok()?;
    match status.ACLineStatus {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn external_power() -> Option<bool> {
    let connection = zbus::blocking::Connection::system().ok()?;
    let proxy = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.UPower",
        "/org/freedesktop/UPower",
        "org.freedesktop.UPower",
    )
    .ok()?;
    proxy
        .get_property::<bool>("OnBattery")
        .ok()
        .map(|on_battery| !on_battery)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn external_power() -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn shares_assertion_and_releases_on_battery_unknown_or_no_demand() {
        let acquisitions = Cell::new(0);
        let mut handle = None;
        for power in [
            Some(true),
            Some(true),
            Some(false),
            Some(true),
            None,
            Some(true),
        ] {
            let report = reconcile(
                &mut handle,
                true,
                || power,
                || {
                    acquisitions.set(acquisitions.get() + 1);
                    Ok(())
                },
            );
            assert_eq!(handle.is_some(), power == Some(true));
            assert_eq!(report.status == Status::Active, handle.is_some());
        }
        assert_eq!(acquisitions.get(), 3);
        let report = reconcile(
            &mut handle,
            false,
            || panic!("unneeded power check"),
            || Ok(()),
        );
        assert_eq!(report.status, Status::Inactive);
        assert!(handle.is_none());
    }

    #[test]
    fn acquisition_failure_is_reported_and_retried() {
        let mut handle = None;
        let report = reconcile::<()>(&mut handle, true, || Some(true), || Err("denied".into()));
        assert_eq!(report.status, Status::Unavailable);
        assert_eq!(report.error.as_deref(), Some("denied"));
        assert_eq!(
            reconcile(&mut handle, true, || Some(true), || Ok(())).status,
            Status::Active
        );
    }
}
