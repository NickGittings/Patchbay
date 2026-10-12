//! Pending launches own their input file; accepted sessions retain a separate copy.
use super::Request;
use crate::{context, pty::SessionSpec};
use std::path::PathBuf;

pub(super) struct PendingBriefing(Option<PathBuf>);
impl PendingBriefing {
    pub(super) fn new(spec: &SessionSpec) -> Self {
        Self(context::owned_briefing(spec))
    }
}
impl Drop for PendingBriefing {
    fn drop(&mut self) {
        if let Some(file) = &self.0 {
            context::remove_owned_briefing_file(file);
        }
    }
}

/// Dispatch a request while owning its pending briefing, including connection failures.
/// Accepted launches retain their own copy, so cleanup is safe even if a reply is lost.
pub fn with_pending_briefing<T>(request: Request, dispatch: impl FnOnce(Request) -> T) -> T {
    let _pending = match &request {
        Request::Start { spec, .. } | Request::Restart { spec, .. } => {
            Some(PendingBriefing::new(spec))
        }
        _ => None,
    };
    dispatch(request)
}
