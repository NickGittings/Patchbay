fn main() -> anyhow::Result<()> {
    let dir = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .map_or_else(patchbay_core::session::runtime_dir, Ok)?;
    patchbay_core::session::serve(&dir)
}
