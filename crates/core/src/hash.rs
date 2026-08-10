//! Content hashing used by SafeWriteTxn snapshots and read-back verification.

use sha2::{Digest, Sha256};

/// SHA-256 hex digest of raw bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// SHA-256 hex digest of a UTF-8 string.
pub fn content_hash(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_digest_length() {
        let first = content_hash("hello 思源");
        let second = content_hash("hello 思源");
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn different_content_hashes_differ() {
        assert_ne!(content_hash("a"), content_hash("b"));
    }

    #[test]
    fn matches_known_sha256_vector() {
        // SHA-256("abc") is a well-known test vector.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
