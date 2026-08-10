//! Client-scoped bearer tokens (`smt1.<payloadB64Url>.<macB64Url>`).
//!
//! External agents never receive the administrator-level SiYuan API token.
//! Instead they receive a scope-limited token signed with the gateway HMAC
//! secret. Every request checks the *minimum required scope* against the
//! token's declared scopes; an empty scope set denies everything
//! (default deny).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// Fixed versioned prefix of every SiYuanMaster scoped token.
pub const TOKEN_PREFIX: &str = "smt1.";
/// Payload schema version.
const PAYLOAD_VERSION: u32 = 1;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    /// Token does not start with `smt1.` or has the wrong number of parts.
    Malformed,
    /// Payload is not valid base64url or not valid JSON.
    BadPayload,
    /// MAC does not verify (tampered or wrong secret).
    BadSignature,
    /// Token is expired (or issued in the future beyond a small skew).
    Expired,
    /// A required scope was requested but is not granted.
    ScopeDenied { required: String },
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenError::Malformed => write!(formatter, "token is malformed"),
            TokenError::BadPayload => write!(formatter, "token payload is invalid"),
            TokenError::BadSignature => write!(formatter, "token signature is invalid"),
            TokenError::Expired => write!(formatter, "token is expired"),
            TokenError::ScopeDenied { required } => {
                write!(formatter, "required scope '{required}' is not granted")
            }
        }
    }
}

impl std::error::Error for TokenError {}

/// Claims carried inside a token payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenClaims {
    pub v: u32,
    pub sub: String,
    pub scopes: Vec<String>,
    pub iat: u64,
    pub exp: u64,
    pub nonce: String,
}

/// Validated token plus the decoded claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedToken {
    pub claims: TokenClaims,
}

/// Signs and verifies scoped tokens with a single HMAC-SHA256 secret.
#[derive(Debug, Clone)]
pub struct TokenEngine {
    secret: Vec<u8>,
}

impl TokenEngine {
    pub fn new(secret: &[u8]) -> TokenEngine {
        TokenEngine {
            secret: secret.to_vec(),
        }
    }

    /// Issues a token. `now` is injected for deterministic tests.
    pub fn issue(
        &self,
        subject: &str,
        scopes: &[&str],
        ttl_seconds: u64,
        now: u64,
    ) -> Result<String, String> {
        if subject.trim().is_empty() {
            return Err("subject must not be empty".to_string());
        }
        if scopes.is_empty() {
            return Err("at least one scope is required".to_string());
        }
        let claims = TokenClaims {
            v: PAYLOAD_VERSION,
            sub: subject.trim().to_string(),
            scopes: scopes.iter().map(|scope| (*scope).to_string()).collect(),
            iat: now,
            exp: now.saturating_add(ttl_seconds),
            nonce: format!(
                "{now:x}-{}",
                subject
                    .len()
                    .wrapping_mul(0x9e37)
                    .wrapping_add(scopes.len())
            ),
        };
        self.sign(claims)
    }

    /// Verifies a token against an optional required scope.
    ///
    /// `now` is injected for deterministic tests. A token with no scopes is
    /// rejected (`ScopeDenied`) unless no scope is required — but callers
    /// should always require a scope for any data operation.
    pub fn verify(
        &self,
        token: &str,
        required_scope: Option<&str>,
        now: u64,
    ) -> Result<VerifiedToken, TokenError> {
        let claims = self.verify_signature(token)?;
        if now > claims.exp || now + 60 < claims.iat {
            return Err(TokenError::Expired);
        }
        if let Some(required) = required_scope {
            if !claims.scopes.iter().any(|granted| granted == required) {
                return Err(TokenError::ScopeDenied {
                    required: required.to_string(),
                });
            }
        }
        Ok(VerifiedToken { claims })
    }

    /// Verifies only the MAC; does not check expiry or scopes.
    pub fn verify_signature(&self, token: &str) -> Result<TokenClaims, TokenError> {
        let payload = token
            .strip_prefix(TOKEN_PREFIX)
            .ok_or(TokenError::Malformed)?;
        let mut parts = payload.split('.');
        let (payload_b64, mac_b64) = match (parts.next(), parts.next(), parts.next()) {
            (Some(payload), Some(mac), None) => (payload, mac),
            _ => return Err(TokenError::Malformed),
        };
        let actual = URL_SAFE_NO_PAD
            .decode(mac_b64.as_bytes())
            .map_err(|_| TokenError::BadSignature)?;
        // Constant-time comparison via hmac crate's verify_slice.
        let mut mac =
            HmacSha256::new_from_slice(&self.secret).map_err(|_| TokenError::BadSignature)?;
        mac.update(payload_b64.as_bytes());
        mac.verify_slice(&actual)
            .map_err(|_| TokenError::BadSignature)?;
        let decoded = URL_SAFE_NO_PAD
            .decode(payload_b64.as_bytes())
            .map_err(|_| TokenError::BadPayload)?;
        let claims: TokenClaims =
            serde_json::from_slice(&decoded).map_err(|_| TokenError::BadPayload)?;
        if claims.v != PAYLOAD_VERSION {
            return Err(TokenError::BadPayload);
        }
        Ok(claims)
    }

    /// Produces the raw HMAC bytes for the given message (used in tests to
    /// forge tokens).
    pub fn raw_mac(&self, message: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("hmac accepts any key");
        mac.update(message);
        mac.finalize().into_bytes().to_vec()
    }

    fn mac(&self, message: &[u8]) -> Vec<u8> {
        self.raw_mac(message)
    }

    fn sign(&self, claims: TokenClaims) -> Result<String, String> {
        let payload_json = serde_json::to_vec(&claims).map_err(|error| error.to_string())?;
        let payload_b64 = URL_SAFE_NO_PAD.encode(&payload_json);
        let mac = self.mac(payload_b64.as_bytes());
        let mac_b64 = URL_SAFE_NO_PAD.encode(&mac);
        Ok(format!("{TOKEN_PREFIX}{payload_b64}.{mac_b64}"))
    }
}

/// Current Unix timestamp in seconds.
pub fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Checks that `required` is a subset of the granted scopes (exact match
/// semantics; notebook-scoped wildcards are resolved by the caller).
pub fn scope_allows(granted: &HashSet<String>, required: &str) -> bool {
    granted.contains(required)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> TokenEngine {
        TokenEngine::new(b"test-secret")
    }

    #[test]
    fn issue_and_verify_roundtrip() {
        let engine = engine();
        let token = engine
            .issue(
                "agent-a",
                &["op:read", "notebook:read:20260101000000-abcdefg"],
                3600,
                1_000,
            )
            .unwrap();
        let verified = engine.verify(&token, Some("op:read"), 1_000).unwrap();
        assert_eq!(verified.claims.sub, "agent-a");
        assert_eq!(verified.claims.scopes.len(), 2);
        assert_eq!(verified.claims.exp, 1_000 + 3600);
        assert!(token.starts_with(TOKEN_PREFIX));
    }

    #[test]
    fn default_deny_without_scopes() {
        let engine = engine();
        let token = engine.issue("agent-a", &["op:read"], 3600, 1_000).unwrap();
        let error = engine.verify(&token, Some("op:write"), 1_000).unwrap_err();
        assert!(matches!(error, TokenError::ScopeDenied { .. }));
    }

    #[test]
    fn expired_token_is_rejected() {
        let engine = engine();
        let token = engine.issue("agent-a", &["op:read"], 10, 1_000).unwrap();
        let error = engine.verify(&token, Some("op:read"), 1_100).unwrap_err();
        assert!(matches!(error, TokenError::Expired));
    }

    #[test]
    fn tampered_token_is_rejected() {
        let engine = engine();
        let token = engine.issue("agent-a", &["op:read"], 3600, 1_000).unwrap();
        let tampered = format!("{}x", token);
        let error = engine
            .verify(&tampered, Some("op:read"), 1_000)
            .unwrap_err();
        assert!(matches!(error, TokenError::BadSignature));
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let token = engine()
            .issue("agent-a", &["op:read"], 3600, 1_000)
            .unwrap();
        let other = TokenEngine::new(b"other-secret");
        let error = other.verify(&token, Some("op:read"), 1_000).unwrap_err();
        assert!(matches!(error, TokenError::BadSignature));
    }

    #[test]
    fn malformed_token_is_rejected() {
        let engine = engine();
        assert!(matches!(
            engine.verify("not-a-token", None, 1_000).unwrap_err(),
            TokenError::Malformed
        ));
        assert!(matches!(
            engine.verify("smt1.onlyone", None, 1_000).unwrap_err(),
            TokenError::Malformed
        ));
    }

    #[test]
    fn forged_token_without_valid_mac_is_rejected() {
        let engine = engine();
        let payload = serde_json::json!({
            "v": 1,
            "sub": "attacker",
            "scopes": ["op:write"],
            "iat": 1_000,
            "exp": 9_999_999,
            "nonce": "x"
        });
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        // MAC computed over a different message than the payload.
        let forged = format!(
            "{TOKEN_PREFIX}{payload_b64}.{}",
            URL_SAFE_NO_PAD.encode(b"forged")
        );
        let error = engine.verify(&forged, Some("op:write"), 1_000).unwrap_err();
        assert!(matches!(error, TokenError::BadSignature));
    }

    #[test]
    fn empty_scope_set_is_rejected_at_issue_time() {
        let engine = engine();
        let error = engine.issue("agent-a", &[], 3600, 1_000).unwrap_err();
        assert!(error.contains("scope"));
    }
}
