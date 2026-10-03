use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use patchbay_core::{Project, context, detect};
use std::path::{Path, PathBuf};

#[derive(Parser)]
#[command(
    name = "patchbay",
    about = "Inspect Patchbay component maps from the command line"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print the component map Patchbay would suggest for a repository.
    Detect {
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
    /// Print the context an agent terminal on a component receives.
    Context {
        component: String,
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// The saved map if there is one, otherwise a detected one.
fn open(dir: &Path) -> Result<Project> {
    let root = dir
        .canonicalize()
        .with_context(|| format!("{}", dir.display()))?;
    match Project::load(&root)? {
        Some(p) => Ok(p),
        None => detect::detect(&root),
    }
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Detect { dir } => {
            let root = dir.canonicalize()?;
            println!("{}", serde_json::to_string_pretty(&detect::detect(&root)?)?);
        }
        Cmd::Context { component, dir } => {
            let project = open(&dir)?;
            let Some(c) = project
                .components
                .iter()
                .find(|c| c.id == component || c.name == component)
            else {
                bail!("no component named {component}");
            };
            print!("{}", context::component_context(&project, &c.id));
        }
    }
    Ok(())
}
