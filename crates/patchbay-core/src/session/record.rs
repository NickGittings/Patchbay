//! Compatibility for persisted session records, applied during deserialization.
use super::{Metadata, Record};
use crate::pty::{SessionSpec, Snapshot};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredRecord {
    id: String,
    metadata: Metadata,
    spec: SessionSpec,
    snapshot: Option<Snapshot>,
    history: Vec<Snapshot>,
    #[serde(default)]
    launch_command: String,
    interrupted: bool,
    request_ids: Vec<String>,
}

impl From<StoredRecord> for Record {
    fn from(stored: StoredRecord) -> Self {
        let mut record = Self {
            id: stored.id,
            metadata: stored.metadata,
            spec: stored.spec,
            snapshot: stored.snapshot,
            history: stored.history,
            launch_command: stored.launch_command,
            interrupted: stored.interrupted,
            request_ids: stored.request_ids,
        };
        crate::merges::restore_record(&mut record);
        record
    }
}
