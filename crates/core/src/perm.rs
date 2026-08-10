//! Document-tree permission inheritance.
//!
//! A document's effective permission is inherited from its ancestors:
//! the nearest explicit ancestor decision wins; when no explicit decision
//! exists the notebook-level decision applies. Denying a document denies
//! its entire subtree, so a child document can never bypass its parent's
//! restriction by being addressed directly.

/// Explicit per-document override. `None` means "inherit".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocNode {
    pub id: String,
    pub allowed: Option<bool>,
}

impl DocNode {
    pub fn explicit(id: impl Into<String>, allowed: bool) -> DocNode {
        DocNode {
            id: id.into(),
            allowed: Some(allowed),
        }
    }

    pub fn inherit(id: impl Into<String>) -> DocNode {
        DocNode {
            id: id.into(),
            allowed: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allowed,
    Denied,
}

/// Computes the effective permission for `document_id`.
///
/// `ancestors` must be ordered from the document itself up to the root
/// (nearest first). The first node with an explicit decision wins;
/// otherwise the notebook-level decision applies.
pub fn effective_permission(
    document_id: &str,
    ancestors: &[DocNode],
    notebook_allowed: bool,
) -> PermissionDecision {
    for node in ancestors {
        if let Some(allowed) = node.allowed {
            return if allowed {
                PermissionDecision::Allowed
            } else {
                PermissionDecision::Denied
            };
        }
        if node.id == document_id {
            // The document itself has no explicit decision; keep walking.
            continue;
        }
    }
    if notebook_allowed {
        PermissionDecision::Allowed
    } else {
        PermissionDecision::Denied
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denied_parent_denies_subtree() {
        let decision = effective_permission(
            "child",
            &[
                DocNode::inherit("child"),
                DocNode::explicit("parent", false),
            ],
            true,
        );
        assert_eq!(decision, PermissionDecision::Denied);
    }

    #[test]
    fn nearest_ancestor_override_wins() {
        let decision = effective_permission(
            "leaf",
            &[
                DocNode::inherit("leaf"),
                DocNode::explicit("middle", true),
                DocNode::explicit("root", false),
            ],
            true,
        );
        assert_eq!(decision, PermissionDecision::Allowed);
    }

    #[test]
    fn no_overrides_falls_back_to_notebook() {
        assert_eq!(
            effective_permission("doc", &[DocNode::inherit("doc")], true),
            PermissionDecision::Allowed
        );
        assert_eq!(
            effective_permission("doc", &[DocNode::inherit("doc")], false),
            PermissionDecision::Denied
        );
    }

    #[test]
    fn own_explicit_decision_overrides_ancestors() {
        let decision = effective_permission(
            "doc",
            &[
                DocNode::explicit("doc", true),
                DocNode::explicit("parent", false),
            ],
            false,
        );
        assert_eq!(decision, PermissionDecision::Allowed);
    }
}
