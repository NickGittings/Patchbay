//! Extension credentials in the OS keychain. Values are entered in Patchbay's own prompt and
//! read only by the network broker (`net`), so extension code can name a secret but never see it.
use crate::net::HostPattern;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const SERVICE: &str = "app.patchbay.extensions";
const VALUE_LIMIT: usize = 16 * 1024;
// Legacy entries contain UTF-8 passwords. Older builds cannot read the binary record as one.
const RECORD_PREFIX: &[u8] = b"\xffpatchbay-hosts-v1\0";

#[derive(Serialize, Deserialize)]
struct Credential {
    hosts: BTreeSet<HostPattern>,
    value: String,
}

fn host_set(hosts: &[HostPattern]) -> BTreeSet<HostPattern> {
    hosts.iter().cloned().collect()
}

fn scoped_value(stored: &[u8], hosts: &[HostPattern]) -> Result<Option<String>> {
    let Some(record) = stored.strip_prefix(RECORD_PREFIX) else {
        return Ok(None);
    };
    let credential: Credential =
        serde_json::from_slice(record).context("Could not read the saved credential")?;
    Ok((!hosts.is_empty() && credential.hosts == host_set(hosts)).then_some(credential.value))
}

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

/// Save (or replace) an extension's secret for the current network allowlist.
/// # Errors
/// Fails for an invalid name, an empty or oversized value, no approved hosts, or keychain errors.
pub fn set(extension: &str, name: &str, value: &str, hosts: &[HostPattern]) -> Result<()> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= VALUE_LIMIT,
        "Enter a value of at most 16 KiB"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "The value contains control characters"
    );
    ensure!(
        !hosts.is_empty(),
        "Approve a server before saving a credential"
    );
    let mut record = RECORD_PREFIX.to_vec();
    serde_json::to_writer(
        &mut record,
        &Credential {
            hosts: host_set(hosts),
            value: value.into(),
        },
    )?;
    entry(extension, name)?
        .set_secret(&record)
        .context("Could not save the credential")
}

/// The secret, for the broker only, when the allowlist still matches the user's approval.
/// # Errors
/// Fails for an invalid name or keychain errors.
pub fn get(extension: &str, name: &str, hosts: &[HostPattern]) -> Result<Option<String>> {
    absent(entry(extension, name)?.get_secret())?
        .map_or(Ok(None), |stored| scoped_value(&stored, hosts))
}

/// Whether the secret is saved for the current allowlist.
/// # Errors
/// Fails for an invalid name or keychain errors.
pub fn has(extension: &str, name: &str, hosts: &[HostPattern]) -> Result<bool> {
    Ok(get(extension, name, hosts)?.is_some())
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
    fn credentials_require_the_same_canonical_servers() {
        let github = HostPattern::parse("https://api.github.com").unwrap();
        let enterprise = HostPattern::parse("https://git.example").unwrap();
        let mut stored = RECORD_PREFIX.to_vec();
        serde_json::to_writer(
            &mut stored,
            &Credential {
                hosts: host_set(&[github.clone(), enterprise.clone()]),
                value: "test-token".into(),
            },
        )
        .unwrap();
        assert!(std::str::from_utf8(&stored).is_err());
        assert_eq!(
            scoped_value(
                &stored,
                &[
                    enterprise.clone(),
                    HostPattern::parse("https://API.GITHUB.COM:443/").unwrap(),
                    enterprise.clone(),
                ],
            )
            .unwrap()
            .as_deref(),
            Some("test-token")
        );
        assert_eq!(
            scoped_value(&stored, std::slice::from_ref(&github)).unwrap(),
            None
        );
        let other = HostPattern::parse("https://other.example").unwrap();
        assert_eq!(
            scoped_value(&stored, &[github.clone(), other]).unwrap(),
            None
        );
        assert_eq!(
            scoped_value(
                &stored,
                &[
                    github,
                    enterprise,
                    HostPattern::parse("https://new.example").unwrap()
                ]
            )
            .unwrap(),
            None
        );
        assert_eq!(scoped_value(b"legacy-token", &[]).unwrap(), None);
        assert_eq!(
            scoped_value(
                b"legacy-token",
                &[HostPattern::parse("https://api.github.com").unwrap()]
            )
            .unwrap(),
            None
        );
    }

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
        assert!(set("acme.tracker", "token", "  ", &[]).is_err());
        assert!(set("acme.tracker", "token", "a\nb", &[]).is_err());
    }
}
