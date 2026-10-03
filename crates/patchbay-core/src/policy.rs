use crate::model::Component;

/// Real component information available to a policy before launching a session.
#[derive(Debug, Clone, Copy)]
pub enum Scope<'a> {
    Component(&'a Component),
    Plan(&'a [&'a Component]),
}

/// Checked before every terminal session starts. Lets an admin enforce allow/deny rules later.
pub trait Policy: Send + Sync {
    /// # Errors
    /// Returns the reason the command is not allowed.
    fn check(&self, scope: Scope<'_>, command: &str) -> Result<(), String>;
}

pub struct AllowAll;

impl Policy for AllowAll {
    fn check(&self, _scope: Scope<'_>, _command: &str) -> Result<(), String> {
        Ok(())
    }
}
