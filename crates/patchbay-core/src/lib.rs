//! Patchbay core: the component map model, project detection, terminal sessions,
//! agent context and terminal presets. Has no UI dependency so it can be driven
//! by the desktop app, the CLI, or a future server.

pub mod access;
pub mod actions;
pub mod context;
pub mod detect;
pub mod devices;
pub mod events;
pub mod extensions;
pub mod files;
pub mod git;
pub mod maintenance;
pub mod model;
pub mod navigation;
pub mod plans;
pub mod policy;
pub mod pty;
pub mod status;
pub mod tasks;
pub mod watch;

pub use events::{EventSink, TerminalEvent};
pub use model::{Component, ComponentKind, Link, Project, TerminalKind, TerminalSpec};

pub mod adapters;
pub mod agent_hooks;
pub mod session;
pub mod workspace;
