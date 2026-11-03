//! Commands used for background work, outside interactive PTY sessions.

use std::ffi::OsStr;
use std::process::Command;

/// Avoid creating a console window when a GUI process launches a Windows tool.
/// Callers retain control over arguments, streams, and exit handling.
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt as _;
        let mut command = command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    command
}

#[cfg(test)]
mod tests {
    use super::background_command;

    #[test]
    fn background_command_preserves_output_and_exit_status() {
        #[cfg(windows)]
        let mut command = {
            let mut command = background_command("cmd.exe");
            command.args(["/D", "/C", "echo output& echo error>&2& exit /B 23"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = background_command("/bin/sh");
            command.args(["-c", "echo output; echo error >&2; exit 23"]);
            command
        };
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(23));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "output");
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "error");
    }

    #[cfg(windows)]
    #[test]
    fn background_command_has_no_windows_console() {
        // Query the child itself: redirecting its output alone does not prevent
        // Windows from allocating a console when the parent is a GUI app.
        let output = background_command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; if ([ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 1 }; Write-Output 'no console'"#,
            ])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "no console");
    }
}
