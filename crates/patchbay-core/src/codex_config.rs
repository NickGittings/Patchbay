//! Read Codex's own layer and managed-policy decisions rather than guessing trust.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub(crate) fn inspect(command: &str, cwd: &Path, overrides: &[String]) -> Result<Value> {
    let raw = crate::context::launch_raw_words(command).context("Unsupported Codex command")?;
    let (program, _) = crate::context::launch_program(command).context("Missing Codex program")?;
    let mut probe = format!("{} app-server --stdio", raw[..=program].join(" "));
    if program > 0 && raw[0].contains('=') {
        probe.insert_str(0, "env ");
    }
    for value in overrides {
        probe.push_str(" -c ");
        probe.push_str(&crate::context::quote_argument(value));
    }
    #[cfg(unix)]
    let mut process = {
        let mut process = crate::process::background_command(
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
        );
        // exec makes timeout cleanup own the Codex process, not an extra shell.
        process.args(["-ilc", &format!("exec {probe}")]);
        process
    };
    #[cfg(windows)]
    let mut process = {
        let mut process = crate::process::background_command("cmd.exe");
        process.args(["/D", "/S", "/C", &probe]);
        process
    };
    let mut child = process
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Could not inspect installed Codex configuration")?;
    let mut input = child
        .stdin
        .take()
        .context("Missing Codex configuration input")?;
    let output = child
        .stdout
        .take()
        .context("Missing Codex configuration output")?;
    let (send, receive) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        // Never surface config contents or provider credentials in an error.
        for line in BufReader::new(output.take(8 * 1024 * 1024)).lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && send.send(value).is_err()
            {
                break;
            }
        }
    });
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        let send = |input: &mut std::process::ChildStdin, value: Value| -> Result<()> {
            serde_json::to_writer(&mut *input, &value)?;
            input.write_all(b"\n")?;
            input.flush()?;
            Ok(())
        };
        let response = |id: u64| -> Result<Value> {
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                ensure!(
                    !remaining.is_zero(),
                    "Installed Codex did not provide configuration metadata within five seconds"
                );
                let response = receive.recv_timeout(remaining).context(
                    "Installed Codex did not provide configuration metadata within five seconds",
                )?;
                if response["id"].as_u64() == Some(id) {
                    ensure!(
                        response.get("error").is_none(),
                        "Installed Codex does not support safe configuration inspection"
                    );
                    return response
                        .get("result")
                        .cloned()
                        .context("Missing Codex configuration metadata");
                }
            }
        };
        send(
            &mut input,
            json!({"id":0,"method":"initialize","params":{"clientInfo":{"name":"patchbay-network-policy","version":env!("CARGO_PKG_VERSION")}}}),
        )?;
        response(0)?;
        send(&mut input, json!({"method":"initialized"}))?;
        send(
            &mut input,
            json!({"id":1,"method":"config/read","params":{"cwd":cwd,"includeLayers":true}}),
        )?;
        let config = response(1)?;
        send(
            &mut input,
            json!({"id":2,"method":"configRequirements/read","params":{}}),
        )?;
        let requirements = response(2)?;
        validate_requirements(&requirements)?;
        Ok(config)
    })();
    drop(input);
    #[cfg(windows)]
    let _ = crate::process::background_command("taskkill.exe")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn validate_requirements(requirements: &Value) -> Result<()> {
    ensure!(
        requirements
            .pointer("/requirements/featureRequirements/network_proxy")
            .and_then(Value::as_bool)
            != Some(false),
        "Managed policy disables Codex's network proxy; command networking was not enabled"
    );
    ensure!(
        requirements
            .pointer("/requirements/network/enabled")
            .and_then(Value::as_bool)
            != Some(false),
        "Managed policy disables Codex managed networking; command networking was not enabled"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_proxy_disablement_prevents_network_configuration() {
        assert!(validate_requirements(&json!({"requirements":null})).is_ok());
        assert!(
            validate_requirements(
                &json!({"requirements":{"featureRequirements":{"network_proxy":true}}})
            )
            .is_ok()
        );
        for requirements in [
            json!({"featureRequirements":{"network_proxy":false}}),
            json!({"network":{"enabled":false}}),
        ] {
            assert!(
                validate_requirements(&json!({"requirements":requirements}))
                    .unwrap_err()
                    .to_string()
                    .contains("was not enabled")
            );
        }
    }
}
