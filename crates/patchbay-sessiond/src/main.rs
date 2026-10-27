fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("report-status") {
        patchbay_core::agent_hooks::reporter(&std::env::args().nth(2).unwrap_or_default());
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("status-line") {
        let dir = std::env::args_os().nth(2).map(std::path::PathBuf::from);
        patchbay_core::usage::capture_status_line(dir.as_deref());
        return Ok(());
    }
    let dir = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .map_or_else(patchbay_core::session::runtime_dir, Ok)?;
    patchbay_core::session::serve(&dir)
}
