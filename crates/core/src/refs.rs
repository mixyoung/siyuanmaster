//! Block reference breakage impact.
//!
//! Before a block-level edit or deletion, SafeWriteTxn previews which blocks
//! reference the target. A `deny` reference-protection mode refuses the
//! write when any referencing block exists; `warn` surfaces the impact and
//! requires confirmation.

/// A block that references the target block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferencingBlock {
    pub block_id: String,
    pub document_id: String,
    pub notebook_id: String,
    /// Short content snippet for the preview (bounded).
    pub content_snippet: String,
}

/// Impact of changing/deleting a block on its references.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReferenceImpact {
    pub target_block_id: String,
    pub referencing_blocks: Vec<ReferencingBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    /// No referencing blocks.
    None,
    /// References exist, all inside the same document.
    Some,
    /// References exist from other documents (deleting the target would
    /// leave dangling cross-document links).
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceMode {
    Warn,
    Deny,
}

impl ReferenceImpact {
    pub fn new(target_block_id: impl Into<String>) -> ReferenceImpact {
        ReferenceImpact {
            target_block_id: target_block_id.into(),
            referencing_blocks: Vec::new(),
        }
    }

    pub fn add(&mut self, block: ReferencingBlock) {
        self.referencing_blocks.push(block);
    }

    /// Classifies breakage risk: cross-document references are critical,
    /// same-document references are "some", none is "none".
    pub fn risk(&self, target_document_id: &str) -> Risk {
        if self.referencing_blocks.is_empty() {
            return Risk::None;
        }
        if self
            .referencing_blocks
            .iter()
            .any(|block| block.document_id != target_document_id)
        {
            Risk::Critical
        } else {
            Risk::Some
        }
    }

    /// Whether the write is allowed under the given protection mode.
    /// `deny` refuses whenever any referencing block exists.
    pub fn allows(&self, mode: ReferenceMode) -> bool {
        match mode {
            ReferenceMode::Warn => true,
            ReferenceMode::Deny => self.referencing_blocks.is_empty(),
        }
    }

    /// Bounded snippet used in previews/audit (never the full body).
    pub fn snippet_count(&self) -> usize {
        self.referencing_blocks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn referencing(block_id: &str, document_id: &str) -> ReferencingBlock {
        ReferencingBlock {
            block_id: block_id.to_string(),
            document_id: document_id.to_string(),
            notebook_id: "20260101000000-abcdefg".to_string(),
            content_snippet: "see [ref]".to_string(),
        }
    }

    #[test]
    fn no_references_is_safe() {
        let impact = ReferenceImpact::new("block-a");
        assert_eq!(impact.risk("doc-1"), Risk::None);
        assert!(impact.allows(ReferenceMode::Deny));
        assert!(impact.allows(ReferenceMode::Warn));
    }

    #[test]
    fn same_document_references_are_some_risk() {
        let mut impact = ReferenceImpact::new("block-a");
        impact.add(referencing("block-b", "doc-1"));
        assert_eq!(impact.risk("doc-1"), Risk::Some);
        // Warn allows, deny refuses.
        assert!(impact.allows(ReferenceMode::Warn));
        assert!(!impact.allows(ReferenceMode::Deny));
    }

    #[test]
    fn cross_document_references_are_critical() {
        let mut impact = ReferenceImpact::new("block-a");
        impact.add(referencing("block-b", "doc-1"));
        impact.add(referencing("block-c", "doc-2"));
        assert_eq!(impact.risk("doc-1"), Risk::Critical);
        assert!(!impact.allows(ReferenceMode::Deny));
    }

    #[test]
    fn deny_mode_refuses_when_any_reference_exists() {
        let mut impact = ReferenceImpact::new("block-a");
        impact.add(referencing("block-b", "doc-1"));
        assert!(!impact.allows(ReferenceMode::Deny));
    }
}
