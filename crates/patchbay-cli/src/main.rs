use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use patchbay_core::{Project, context, detect, extensions::Registry};
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
    /// List local extensions and validation errors.
    Extensions,
    /// Print the component map Patchbay would suggest for a repository.
    Detect {
        #[arg(default_value = ".")]
        dir: PathBuf,
    },
    /// Print a planner briefing for selected component ids, or the whole project.
    Plan {
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        component_ids: Vec<String>,
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
        None => detect::detect_with(&root, &Registry::load().detectors()),
    }
}

fn main() -> Result<()> {
    let registry = Registry::load();
    match Cli::parse().cmd {
        Cmd::Extensions => println!("{}", serde_json::to_string_pretty(&registry)?),
        Cmd::Detect { dir } => {
            let root = dir.canonicalize()?;
            println!(
                "{}",
                serde_json::to_string_pretty(&detect::detect_with(&root, &registry.detectors())?)?
            );
        }
        Cmd::Plan { dir, component_ids } => {
            let project = open(&dir)?;
            for id in &component_ids {
                if project.component(id).is_none() {
                    bail!("unknown component {id}");
                }
            }
            print!(
                "{}",
                context::plan_context(
                    &project,
                    &component_ids,
                    &registry.sections(
                        &project,
                        &component_ids,
                        &[PathBuf::from(&project.root)],
                        vec![],
                    )
                )
            );
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
            print!(
                "{}",
                context::component_context(
                    &project,
                    &c.id,
                    &registry.sections(
                        &project,
                        std::slice::from_ref(&c.id),
                        &[PathBuf::from(&project.root)],
                        vec![],
                    )
                )
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_ids_are_positional_and_directory_is_a_flag() {
        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan", "api", "web"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("."));
        assert_eq!(component_ids, ["api", "web"]);

        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan", "api", "--dir", "../shop"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("../shop"));
        assert_eq!(component_ids, ["api"]);
    }

    #[test]
    fn plan_without_ids_uses_the_current_project() {
        let Cli {
            cmd: Cmd::Plan { dir, component_ids },
        } = Cli::try_parse_from(["patchbay", "plan"]).unwrap()
        else {
            panic!("expected plan command")
        };
        assert_eq!(dir, PathBuf::from("."));
        assert!(component_ids.is_empty());
    }
}
