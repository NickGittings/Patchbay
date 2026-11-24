//! Brokered HTTP for extensions. Extension frames have no network access of their own; each
//! request names an allowlisted origin, every redirect hop is checked against the same list,
//! and credentials come from the OS keychain (`secrets`) without passing through extension code.
use crate::secrets;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};

/// Largest request body an extension may send.
pub const REQUEST_LIMIT: usize = 1024 * 1024;
/// Largest response body returned to an extension.
pub const RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(25);
const MAX_REDIRECTS: usize = 5;
const MAX_HEADERS: usize = 32;
/// Headers an extension may not set itself: transport framing, ambient credentials, and
/// `Authorization`, which only the keychain-backed `auth` option supplies.
const FORBIDDEN_HEADERS: &[&str] = &[
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "keep-alive",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// An origin an extension may reach, from its manifest's `network` list or the user's
/// approval: `https://host[:port]`, optionally `https://*.domain` for its subdomains.
/// Plain `http` is allowed only for loopback hosts.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct HostPattern {
    scheme: String,
    host: String,
    wildcard: bool,
    port: u16,
}

fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

impl HostPattern {
    /// # Errors
    /// Fails for anything but a bare HTTPS (or loopback HTTP) origin.
    pub fn parse(pattern: &str) -> Result<Self> {
        ensure!(
            pattern.len() <= 256 && !pattern.chars().any(|c| c.is_whitespace() || c.is_control()),
            "invalid network origin {pattern:?}"
        );
        let (scheme, rest) = pattern
            .split_once("://")
            .with_context(|| format!("network origin {pattern:?} needs a scheme"))?;
        let (wildcard, rest) = rest
            .strip_prefix("*.")
            .map_or((false, rest), |rest| (true, rest));
        let url = url::Url::parse(&format!("{scheme}://{rest}"))
            .with_context(|| format!("invalid network origin {pattern:?}"))?;
        let host = url
            .host_str()
            .with_context(|| format!("network origin {pattern:?} needs a host"))?
            .to_ascii_lowercase();
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && matches!(url.path(), "" | "/")
                && url.query().is_none()
                && url.fragment().is_none(),
            "network origin {pattern:?} must not carry credentials, a path or a query"
        );
        match url.scheme() {
            "https" => {}
            "http" if loopback(&host) && !wildcard => {}
            _ => bail!("network origin {pattern:?} must use https (http only for localhost)"),
        }
        // `*.com` would cover every site under a top-level domain.
        ensure!(
            !wildcard || host.contains('.'),
            "network origin {pattern:?} is too broad"
        );
        Ok(Self {
            scheme: url.scheme().into(),
            port: url.port_or_known_default().context("missing port")?,
            host,
            wildcard,
        })
    }

    #[must_use]
    pub fn matches(&self, url: &url::Url) -> bool {
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        url.scheme() == self.scheme
            && url.port_or_known_default() == Some(self.port)
            && if self.wildcard {
                host.strip_suffix(&self.host)
                    .is_some_and(|prefix| prefix.len() > 1 && prefix.ends_with('.'))
            } else {
                host == self.host
            }
    }
}

/// Parse and check a request URL against `allowed`.
/// # Errors
/// Fails for invalid URLs, credentials in the URL, or an origin outside the list.
pub fn allowed_url(allowed: &[HostPattern], value: &str) -> Result<url::Url> {
    ensure!(value.len() <= 8192, "request URL exceeds 8 KiB");
    let url = url::Url::parse(value).context("invalid request URL")?;
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "request URLs may not carry credentials"
    );
    ensure!(
        allowed.iter().any(|p| p.matches(&url)),
        "{} isn't in this extension's network allowlist",
        url.origin().ascii_serialization()
    );
    Ok(url)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthScheme {
    /// `Authorization: Bearer <secret>` (GitHub, most OAuth-style tokens).
    Bearer,
    /// `Authorization: Basic base64(<username>:<secret>)` (Azure DevOps PATs, Jira API tokens).
    Basic,
    /// `Authorization: <secret>` (Linear personal API keys).
    Raw,
}

/// A keychain secret the broker adds as the `Authorization` header.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpAuth {
    pub secret: String,
    pub scheme: AuthScheme,
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub url: String,
    #[serde(default = "get")]
    pub method: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub auth: Option<HttpAuth>,
}
fn get() -> String {
    "GET".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    /// The final URL, after any allowed redirects.
    pub url: String,
    /// Lower-cased response headers.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

fn check_request(request: &HttpRequest) -> Result<()> {
    ensure!(
        matches!(request.method.as_str(), "GET" | "POST" | "HEAD"),
        "only GET, POST and HEAD requests are allowed"
    );
    ensure!(
        request.headers.len() <= MAX_HEADERS,
        "at most {MAX_HEADERS} request headers"
    );
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        ensure!(
            !name.is_empty()
                && name.len() <= 128
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && value.len() <= 8192
                && !value.chars().any(char::is_control),
            "invalid request header {name:?}"
        );
        ensure!(
            !FORBIDDEN_HEADERS.contains(&lower.as_str())
                && !lower.starts_with("proxy-")
                && !lower.starts_with("sec-"),
            "request header {name:?} isn't allowed; use the auth option for credentials"
        );
    }
    ensure!(
        request
            .body
            .as_ref()
            .is_none_or(|b| b.len() <= REQUEST_LIMIT),
        "request body exceeds 1 MiB"
    );
    ensure!(
        request.body.is_none() || request.method == "POST",
        "only POST requests carry a body"
    );
    Ok(())
}

fn authorization(extension: &str, allowed: &[HostPattern], auth: &HttpAuth) -> Result<String> {
    let secret = secrets::get(extension, &auth.secret, allowed)?.with_context(|| {
        format!(
            "Save the {} credential for the extension's current servers",
            auth.secret
        )
    })?;
    Ok(match auth.scheme {
        AuthScheme::Bearer => format!("Bearer {secret}"),
        AuthScheme::Raw => secret,
        AuthScheme::Basic => {
            use base64::Engine as _;
            ensure!(
                !auth.username.contains(':') && auth.username.len() <= 256,
                "invalid basic auth username"
            );
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{secret}", auth.username))
            )
        }
    })
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .max_redirects_will_error(false)
        .http_status_as_error(false)
        .user_agent("Patchbay")
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

/// Perform an extension's request. Redirects are followed by hand so each hop is checked
/// against `allowed`, and the credential is only sent to the origin it was requested for.
/// # Errors
/// Fails for a disallowed request, missing credential, network failure, or an oversized
/// response. HTTP error statuses are returned, not raised.
pub fn fetch(
    extension: &str,
    allowed: &[HostPattern],
    request: &HttpRequest,
) -> Result<HttpResponse> {
    check_request(request)?;
    let mut url = allowed_url(allowed, &request.url)?;
    let origin = url.origin();
    let authorization = request
        .auth
        .as_ref()
        .map(|auth| authorization(extension, allowed, auth))
        .transpose()?;
    let agent = agent();
    let mut method = request.method.clone();
    let mut body = request.body.clone();
    for _ in 0..=MAX_REDIRECTS {
        let mut builder = ureq::http::Request::builder()
            .method(method.as_str())
            .uri(url.as_str());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(value) = authorization.as_ref().filter(|_| url.origin() == origin) {
            builder = builder.header("authorization", value);
        }
        let response = match &body {
            Some(text) => agent.run(builder.body(text.clone())?),
            None => agent.run(builder.body(())?),
        }
        .with_context(|| format!("request to {} failed", url.origin().ascii_serialization()))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status)
            && let Some(location) = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
        {
            url = allowed_url(allowed, url.join(location)?.as_str())
                .context("redirect left the network allowlist")?;
            // Like browsers, 303 (and 301/302 after POST) continue as GET without a body.
            if status == 303 || (matches!(status, 301 | 302) && method == "POST") {
                method = "GET".into();
                body = None;
            }
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                let name = name.as_str().to_ascii_lowercase();
                (name != "set-cookie")
                    .then(|| value.to_str().ok().map(|v| (name, v.to_owned())))
                    .flatten()
            })
            .take(64)
            .collect();
        let mut bytes = vec![];
        response
            .into_body()
            .into_reader()
            .take(RESPONSE_LIMIT + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= RESPONSE_LIMIT,
            "response exceeds {} MiB",
            RESPONSE_LIMIT / 1024 / 1024
        );
        return Ok(HttpResponse {
            status,
            url: url.into(),
            headers,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    bail!("too many redirects")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patterns(list: &[&str]) -> Vec<HostPattern> {
        list.iter()
            .map(|p| HostPattern::parse(p).unwrap())
            .collect()
    }

    #[test]
    fn origins_must_be_bare_https_or_loopback_http() {
        for bad in [
            "api.github.com",
            "http://api.github.com",
            "https://user:pw@api.github.com",
            "https://api.github.com/repos",
            "https://api.github.com/?x=1",
            "https://*.com",
            "http://*.localhost",
            "ftp://example.com",
            "https://exa mple.com",
        ] {
            assert!(HostPattern::parse(bad).is_err(), "{bad}");
        }
        for good in [
            "https://api.github.com",
            "https://api.github.com/",
            "https://*.atlassian.net",
            "https://tfs.corp.example:8443",
            "http://localhost:8080",
            "http://127.0.0.1:3000",
        ] {
            assert!(HostPattern::parse(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn requests_match_scheme_host_and_port_exactly() {
        let allowed = patterns(&[
            "https://api.github.com",
            "https://*.atlassian.net",
            "http://localhost:8080",
        ]);
        for ok in [
            "https://api.github.com/repos/a/b/issues?page=2",
            "https://API.GitHub.com:443/",
            "https://acme.atlassian.net/rest/api/3/search",
            "https://a.b.atlassian.net/",
            "http://localhost:8080/items",
        ] {
            assert!(allowed_url(&allowed, ok).is_ok(), "{ok}");
        }
        for denied in [
            "http://api.github.com/",
            "https://api.github.com:8443/",
            "https://github.com/",
            "https://evil-api.github.com/",
            "https://atlassian.net/",
            "https://evilatlassian.net/",
            "https://atlassian.net.evil.com/",
            "http://localhost:9090/",
            "https://user:pw@api.github.com/",
            "file:///etc/passwd",
        ] {
            assert!(allowed_url(&allowed, denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn requests_cannot_set_credentials_or_framing_headers() {
        let request = |headers: Vec<(&str, &str)>, method: &str, body: Option<&str>| HttpRequest {
            url: "https://api.github.com/".into(),
            method: method.into(),
            headers: headers
                .into_iter()
                .map(|(n, v)| (n.into(), v.into()))
                .collect(),
            body: body.map(Into::into),
            auth: None,
        };
        assert!(check_request(&request(vec![("Accept", "application/json")], "GET", None)).is_ok());
        assert!(check_request(&request(vec![], "POST", Some("{}"))).is_ok());
        for bad in [
            request(vec![("Authorization", "Bearer x")], "GET", None),
            request(vec![("cookie", "a=b")], "GET", None),
            request(vec![("Proxy-Foo", "x")], "GET", None),
            request(vec![("Host", "evil")], "GET", None),
            request(vec![("X-Bad", "a\r\nb")], "GET", None),
            request(vec![], "DELETE", None),
            request(vec![], "GET", Some("body")),
        ] {
            assert!(check_request(&bad).is_err(), "{bad:?}");
        }
        let big = "x".repeat(REQUEST_LIMIT + 1);
        assert!(check_request(&request(vec![], "POST", Some(&big))).is_err());
    }
}
