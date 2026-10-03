use serde::Serialize;

/// Structured terminal events. Every consumer (UI, CLI, future audit log) sees the same stream.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Started { session_id: String },
    Output { session_id: String, data: Vec<u8> },
    Exited { session_id: String, exit_code: i32 },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: TerminalEvent);
}
