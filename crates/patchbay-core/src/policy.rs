use crate::model::Component;

/// Checked before every terminal session starts. Lets an admin enforce allow/deny rules later.
pub trait Policy: Send + Sync {
    /// # Errors
    /// Returns the reason the command is not allowed.
    fn check(&self, component: &Component, command: &str) -> Result<(), String>;
}

pub struct AllowAll;

impl Policy for AllowAll {
    fn check(&self, _component: &Component, _command: &str) -> Result<(), String> {
        Ok(())
    }
}
