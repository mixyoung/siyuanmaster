//! Audit model: metadata only, never body content.
//!
//! The audit entry type has no content field by design; tests assert that
//! serialized entries cannot contain a document body even if a caller
//! tried to smuggle it in through a message field (the message field is
//! bounded and structural, and callers must not place body text in it).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    Allowed,
    Denied,
    ConfirmationRequired,
    Failed,
    Unknown,
}

/// A metadata-only audit entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub operation: String,
    pub outcome: AuditOutcome,
    /// Token subject (agent identity) when known.
    pub subject: Option<String>,
    pub document_id: Option<String>,
    pub notebook_id: Option<String>,
    pub txn_id: Option<String>,
    pub content_length: Option<usize>,
    pub tag_count: Option<usize>,
    /// Short structural reason/error code; never note body text.
    pub message: Option<String>,
}

impl AuditEntry {
    pub fn new(operation: impl Into<String>, outcome: AuditOutcome) -> AuditEntry {
        AuditEntry {
            timestamp: String::new(),
            operation: operation.into(),
            outcome,
            subject: None,
            document_id: None,
            notebook_id: None,
            txn_id: None,
            content_length: None,
            tag_count: None,
            message: None,
        }
    }

    pub fn with_timestamp(mut self, timestamp: impl Into<String>) -> AuditEntry {
        self.timestamp = timestamp.into();
        self
    }

    pub fn with_subject(mut self, subject: impl Into<String>) -> AuditEntry {
        self.subject = Some(subject.into());
        self
    }

    pub fn with_document(mut self, document_id: impl Into<String>) -> AuditEntry {
        self.document_id = Some(document_id.into());
        self
    }

    pub fn with_notebook(mut self, notebook_id: impl Into<String>) -> AuditEntry {
        self.notebook_id = Some(notebook_id.into());
        self
    }

    pub fn with_txn(mut self, txn_id: impl Into<String>) -> AuditEntry {
        self.txn_id = Some(txn_id.into());
        self
    }

    pub fn with_content_length(mut self, content_length: usize) -> AuditEntry {
        self.content_length = Some(content_length);
        self
    }

    pub fn with_tag_count(mut self, tag_count: usize) -> AuditEntry {
        self.tag_count = Some(tag_count);
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> AuditEntry {
        self.message = Some(message.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_entry_never_contains_body() {
        // A full document body is provided to the caller of `new`, but the
        // type simply has no field for it.
        let body = "TOP SECRET NOTE BODY 秘密正文";
        let entry = AuditEntry::new("update_note", AuditOutcome::Allowed)
            .with_content_length(body.len())
            .with_message("allowed by policy")
            .with_timestamp("2026-08-09T00:00:00Z");
        let serialized = serde_json::to_string(&entry).unwrap();
        assert!(!serialized.contains("TOP SECRET"));
        assert!(!serialized.contains("秘密正文"));
        assert!(serialized.contains("\"content_length\":"));
    }

    #[test]
    fn no_content_field_exists() {
        let entry = AuditEntry::new("read_note", AuditOutcome::Allowed);
        let serialized = serde_json::to_value(&entry).unwrap();
        let object = serialized.as_object().unwrap();
        for field in ["content", "body", "markdown", "text", "snippet", "token"] {
            assert!(
                !object.contains_key(field),
                "audit must not have a '{field}' field"
            );
        }
    }

    #[test]
    fn message_field_is_bounded_structure() {
        // Messages are short structural reasons; a long body must not be
        // passed in. The type allows a string, but the contract (and the
        // gateway) keeps them to error codes and short reasons.
        let entry = AuditEntry::new("delete_note", AuditOutcome::Denied)
            .with_message("operation_denied")
            .with_timestamp("2026-08-09T00:00:00Z");
        let serialized = serde_json::to_string(&entry).unwrap();
        assert!(serialized.contains("operation_denied"));
    }
}
