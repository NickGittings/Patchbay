//! Extension credentials in the OS keychain. Values are entered in Patchbay's own prompt and
//! read only by the network broker (`net`), so extension code can name a secret but never see it.
use anyhow::{Context, Result, ensure};

const SERVICE: &str = "app.patchbay.extensions";
const VALUE_LIMIT: usize = 16 * 1024;

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn entry(extension: &str, name: &str) -> Result<keyring::Entry> {
    ensure!(valid_name(name), "Secret names use letters, digits, - or _");
    ensure!(
        !extension.is_empty() && !extension.contains('/'),
        "Invalid extension id"
    );
    keyring::Entry::new(SERVICE, &format!("{extension}/{name}"))
        .context("OS credential store unavailable")
}

fn absent<T>(result: keyring::Result<T>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Save (or replace) an extension's secret.
/// # Errors
/// Fails for an invalid name, an empty or oversized value, or keychain errors.
pub fn set(extension: &str, name: &str, value: &str) -> Result<()> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= VALUE_LIMIT,
        "Enter a value of at most 16 KiB"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "The value contains control characters"
    );
    entry(extension, name)?
        .set_password(value)
        .context("Could not save the credential")
}

/// The secret, for the broker only.
/// # Errors
/// Fails for an invalid name or keychain errors.
pub fn get(extension: &str, name: &str) -> Result<Option<String>> {
    absent(entry(extension, name)?.get_password())
}

/// Whether the secret is saved.
/// # Errors
/// Fails for an invalid name or keychain errors.
pub fn has(extension: &str, name: &str) -> Result<bool> {
    Ok(get(extension, name)?.is_some())
}

/// Forget the secret; forgetting a missing one succeeds.
/// # Errors
/// Fails for an invalid name or keychain errors.
pub fn delete(extension: &str, name: &str) -> Result<()> {
    absent(entry(extension, name)?.delete_credential()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_are_short_slugs() {
        for ok in ["token", "github-pat", "LINEAR_KEY", "a1"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "a/b", "../x", "has space", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
            assert!(entry("acme.tracker", bad).is_err());
        }
        assert!(entry("a/b", "token").is_err());
        assert!(set("acme.tracker", "token", "  ").is_err());
        assert!(set("acme.tracker", "token", "a\nb").is_err());
    }
}
