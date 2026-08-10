//! Lightweight line-level diff summary used for SafeWriteTxn previews.
//!
//! The preview does not need a full patch; it needs an honest,
//! deterministic answer to "how much would change?". We compute the common
//! prefix and suffix of the old and new line sequences and report the
//! middle as changed.

/// Deterministic summary of the difference between two texts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSummary {
    pub total_old_lines: usize,
    pub total_new_lines: usize,
    pub same_prefix_lines: usize,
    pub same_suffix_lines: usize,
    pub removed_lines: usize,
    pub added_lines: usize,
    pub hash_old: String,
    pub hash_new: String,
    pub identical: bool,
}

fn split_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    content.split('\n').collect()
}

/// Computes a diff summary. `hash_old`/`hash_new` are supplied so callers
/// control the hashing (they may already have the snapshot hash).
pub fn diff_summary(old: &str, new: &str, hash_old: &str, hash_new: &str) -> DiffSummary {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);

    let mut prefix = 0;
    let max_prefix = old_lines.len().min(new_lines.len());
    while prefix < max_prefix && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }

    let mut suffix = 0;
    let max_suffix = old_lines.len().min(new_lines.len()) - prefix;
    while suffix < max_suffix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let identical = old == new;
    DiffSummary {
        total_old_lines: old_lines.len(),
        total_new_lines: new_lines.len(),
        same_prefix_lines: prefix,
        same_suffix_lines: suffix,
        removed_lines: old_lines.len() - prefix - suffix,
        added_lines: new_lines.len() - prefix - suffix,
        hash_old: hash_old.to_string(),
        hash_new: hash_new.to_string(),
        identical,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_has_no_changes() {
        let summary = diff_summary("a\nb\nc", "a\nb\nc", "h1", "h1");
        assert!(summary.identical);
        assert_eq!(summary.added_lines, 0);
        assert_eq!(summary.removed_lines, 0);
        assert_eq!(summary.same_prefix_lines, 3);
    }

    #[test]
    fn middle_change_is_reported() {
        let summary = diff_summary("a\nb\nc", "a\nX\nc", "h1", "h2");
        assert!(!summary.identical);
        assert_eq!(summary.same_prefix_lines, 1);
        assert_eq!(summary.same_suffix_lines, 1);
        assert_eq!(summary.removed_lines, 1);
        assert_eq!(summary.added_lines, 1);
    }

    #[test]
    fn append_only_change() {
        let summary = diff_summary("a\nb", "a\nb\nc\nd", "h1", "h2");
        assert_eq!(summary.removed_lines, 0);
        assert_eq!(summary.added_lines, 2);
    }
}
