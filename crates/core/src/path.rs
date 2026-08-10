//! Human-readable paths are lookup-only.
//!
//! Reads may resolve a human-readable path to a document ID
//! ([`ReadTarget`]). Writes must address targets by exact block/document
//! ID plus an optional expected state ([`WriteTarget`]); a path can never
//! be used to address a write, so a `WriteTarget` cannot be constructed
//! from a path string.

/// SiYuan block/document ID pattern: `14 digits + '-' + 7 lowercase
/// alphanumerics`.
pub const SIYUAN_ID_PATTERN: &str = r"^\d{14}-[a-z0-9]{7}$";

/// A read target: either an exact ID or a human-readable path that is
/// resolved to an ID before any content is accessed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadTarget {
    ById { id: String },
    ByPath { notebook_id: String, hpath: String },
}

/// A write target: an exact ID plus an optional expected hash (or expected
/// content digest). Construction from a path is impossible by type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteTarget {
    pub id: String,
    pub expected_hash: Option<String>,
}

/// Validates that a string is a well-formed SiYuan ID.
pub fn is_valid_siyuan_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 22 {
        return false;
    }
    let (date_part, rest) = value.split_at(14);
    let dash_ok = rest.starts_with('-');
    let date_ok = date_part.bytes().all(|byte| byte.is_ascii_digit());
    let tail_ok = rest
        .bytes()
        .skip(1)
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    date_ok && dash_ok && tail_ok && rest.len() == 8
}

/// Constructs a `WriteTarget` from a raw string; rejects anything that is
/// not an exact ID (paths, titles, arbitrary text).
pub fn parse_write_target(
    raw_id: &str,
    expected_hash: Option<String>,
) -> Result<WriteTarget, String> {
    let id = raw_id.trim();
    if !is_valid_siyuan_id(id) {
        return Err(format!(
            "write targets must be exact SiYuan IDs (pattern {SIYUAN_ID_PATTERN}); received '{raw_id}'"
        ));
    }
    if let Some(hash) = &expected_hash {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("expectedHash must be a 64-character hex SHA-256 digest".to_string());
        }
    }
    Ok(WriteTarget {
        id: id.to_string(),
        expected_hash,
    })
}

/// A human-readable path is only ever a lookup hint; the lookup result is
/// an ID, after which the read proceeds by ID.
pub fn is_lookup_only_path(hpath: &str) -> bool {
    hpath.starts_with('/') && hpath.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_ID: &str = "20260101000000-abcdefg";

    #[test]
    fn valid_id_patterns_are_accepted() {
        assert!(is_valid_siyuan_id(VALID_ID));
        assert!(is_valid_siyuan_id("20260101000000-hijklmn"));
    }

    #[test]
    fn non_ids_are_rejected_for_writes() {
        for bad in [
            "/AI/Memory/note",
            "AI/Memory/note",
            "not-an-id",
            "20260101000000-ABC1234",
            "20260101000000-abcdef",
            "2026010100000-abcdefg",
        ] {
            assert!(!is_valid_siyuan_id(bad), "{bad} must be rejected");
            assert!(
                parse_write_target(bad, None).is_err(),
                "{bad} must not be writable"
            );
        }
    }

    #[test]
    fn write_target_requires_id_and_validates_hash() {
        let target = parse_write_target(VALID_ID, None).unwrap();
        assert_eq!(target.id, VALID_ID);
        assert!(parse_write_target(VALID_ID, Some("zz".to_string())).is_err());
        let hex_hash = "a".repeat(64);
        let target = parse_write_target(VALID_ID, Some(hex_hash.clone())).unwrap();
        assert_eq!(target.expected_hash, Some(hex_hash));
    }

    #[test]
    fn paths_are_lookup_only() {
        assert!(is_lookup_only_path("/AI/Memory/note"));
        // A bare ID is not a path.
        assert!(!is_lookup_only_path(VALID_ID));
    }
}
