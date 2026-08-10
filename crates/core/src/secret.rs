//! Trusted-boundary secret handling.
//!
//! The administrator-level SiYuan API token and the gateway HMAC secret
//! are "administrator secrets": they must stay inside the trusted boundary
//! (environment variables or local key files) and must never be
//! serialized into responses, audit entries, capability dumps, or logs.
//!
//! [`SecretRef::display`] always returns a redacted placeholder so a
//! programmer mistake cannot leak the value through formatted output.

use std::fmt;

/// Where a secret comes from. Literal values are only supported for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretSource {
    /// Read from the named environment variable at resolve time.
    Env(String),
    /// Read from the named local file at resolve time.
    File(String),
    /// Literal value (tests only).
    Literal(Vec<u8>),
}

/// A reference to an administrator secret that can be resolved to bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretRef {
    source: SecretSource,
    kind: SecretKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// HMAC key used to sign/verify client scoped tokens.
    GatewayHmac,
    /// Administrator-level SiYuan API token used only for outbound
    /// proxy calls to the SiYuan kernel (never exposed to agents).
    AdminToken,
}

impl SecretRef {
    pub fn from_env(kind: SecretKind, variable: &str) -> SecretRef {
        SecretRef {
            source: SecretSource::Env(variable.to_string()),
            kind,
        }
    }

    pub fn from_file(kind: SecretKind, path: &str) -> SecretRef {
        SecretRef {
            source: SecretSource::File(path.to_string()),
            kind,
        }
    }

    /// Literal secret for tests; production code should not use this.
    pub fn literal(kind: SecretKind, value: &[u8]) -> SecretRef {
        SecretRef {
            source: SecretSource::Literal(value.to_vec()),
            kind,
        }
    }

    pub fn kind(&self) -> SecretKind {
        self.kind
    }

    /// Resolves the secret bytes. Trailing newline/whitespace is trimmed
    /// for file-based secrets.
    pub fn resolve(&self) -> Result<Vec<u8>, String> {
        match &self.source {
            SecretSource::Env(variable) => std::env::var(variable)
                .map(|value| value.into_bytes())
                .map_err(|_| format!("environment variable '{variable}' is not set")),
            SecretSource::File(path) => {
                let raw = std::fs::read_to_string(path)
                    .map_err(|error| format!("cannot read secret file '{path}': {error}"))?;
                Ok(raw.trim().as_bytes().to_vec())
            }
            SecretSource::Literal(value) => Ok(value.clone()),
        }
    }
}

impl fmt::Display for SecretRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            SecretKind::AdminToken => write!(formatter, "<redacted-admin-token>"),
            SecretKind::GatewayHmac => write!(formatter, "<redacted-gateway-secret>"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_never_leaks_the_value() {
        let secret = SecretRef::literal(SecretKind::AdminToken, b"super-secret-token-value");
        assert_eq!(secret.to_string(), "<redacted-admin-token>");
        let hmac = SecretRef::literal(SecretKind::GatewayHmac, b"hmac-value");
        assert_eq!(hmac.to_string(), "<redacted-gateway-secret>");
        // Even formatting into a wider string must not expose the value.
        let formatted = format!("configured with {}", secret);
        assert!(!formatted.contains("super-secret-token-value"));
    }

    #[test]
    fn literal_resolves_to_bytes() {
        let secret = SecretRef::literal(SecretKind::AdminToken, b"abc");
        assert_eq!(secret.resolve().unwrap(), b"abc");
    }

    #[test]
    fn missing_env_is_an_error() {
        let secret =
            SecretRef::from_env(SecretKind::GatewayHmac, "SIYUANMASTER_UNSET_TEST_VAR_XYZ");
        assert!(secret.resolve().is_err());
    }
}
