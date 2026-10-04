use crate::status::SessionStatus;
use serde::Serialize;

/// Structured terminal events. Every consumer (UI, CLI, future audit log) sees the same stream.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Started {
        session_id: String,
        generation: u64,
        /// Unix milliseconds.
        started_ms: u64,
        /// Why an agent's briefing wasn't injected normally, if it wasn't.
        notice: Option<String>,
    },
    Output {
        session_id: String,
        generation: u64,
        seq: u64,
        data: Vec<u8>,
    },
    Exited {
        session_id: String,
        generation: u64,
        exit_code: i32,
        /// Unix milliseconds.
        exited_ms: u64,
    },
    /// What a running session is doing changed (see [`SessionStatus`]).
    Status {
        session_id: String,
        generation: u64,
        status: SessionStatus,
    },
}

impl TerminalEvent {
    #[must_use]
    pub fn session_id(&self) -> &str {
        match self {
            Self::Started { session_id, .. }
            | Self::Output { session_id, .. }
            | Self::Exited { session_id, .. }
            | Self::Status { session_id, .. } => session_id,
        }
    }
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: TerminalEvent);
}
