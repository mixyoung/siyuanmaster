//! Long-document segmented reading (outline + full-block windows).
//!
//! Pure functions over block rows so the windowing semantics are shared
//! and testable. The TypeScript plugin mirrors these limits from the
//! capability catalog / safety policy.

/// A minimal block row used for segmentation (subset of the SiYuan
/// `blocks` table columns).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRow {
    pub block_id: String,
    pub block_type: String,
    pub content: String,
    pub markdown: Option<String>,
    pub sort: i64,
}

impl BlockRow {
    /// Display text: prefer markdown (full block display), fall back to
    /// plain content.
    pub fn display_text(&self) -> &str {
        self.markdown
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(&self.content)
    }
}

/// One outline item (a heading block).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineItem {
    pub block_id: String,
    /// Heading level extracted from the block type (`h1`..`h6`).
    pub level: u8,
    pub text: String,
}

/// Extracts the heading level from a SiYuan block type like `h1`.
pub fn heading_level(block_type: &str) -> Option<u8> {
    let level = block_type.strip_prefix('h')?;
    let parsed: u8 = level.parse().ok()?;
    if (1..=6).contains(&parsed) {
        Some(parsed)
    } else {
        None
    }
}

/// Builds the document outline from heading blocks (assumed already
/// ordered by `sort`).
pub fn build_outline(headings: &[BlockRow]) -> Vec<OutlineItem> {
    headings
        .iter()
        .filter_map(|row| {
            heading_level(&row.block_type).map(|level| OutlineItem {
                block_id: row.block_id.clone(),
                level,
                text: row.display_text().trim().to_string(),
            })
        })
        .collect()
}

/// Windows over an ordered block list. Returns the selected slice and the
/// next offset (or `None` when there is no further page).
pub fn window(blocks: &[BlockRow], offset: usize, limit: usize) -> (Vec<&BlockRow>, Option<usize>) {
    let safe_offset = offset.min(blocks.len());
    let end = (safe_offset + limit).min(blocks.len());
    let page: Vec<&BlockRow> = blocks[safe_offset..end].iter().collect();
    let next = if end < blocks.len() { Some(end) } else { None };
    (page, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, block_type: &str, content: &str, sort: i64) -> BlockRow {
        BlockRow {
            block_id: id.to_string(),
            block_type: block_type.to_string(),
            content: content.to_string(),
            markdown: None,
            sort,
        }
    }

    #[test]
    fn heading_level_parses() {
        assert_eq!(heading_level("h1"), Some(1));
        assert_eq!(heading_level("h6"), Some(6));
        assert_eq!(heading_level("h7"), None);
        assert_eq!(heading_level("p"), None);
        assert_eq!(heading_level("tbl"), None);
    }

    #[test]
    fn outline_is_built_from_headings_in_order() {
        let rows = [
            row("h1-id", "h1", "第一章", 1),
            row("p1-id", "p", "正文", 2),
            row("h2-id", "h2", "第一节", 3),
        ];
        let outline = build_outline(&rows);
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0].block_id, "h1-id");
        assert_eq!(outline[0].level, 1);
        assert_eq!(outline[0].text, "第一章");
        assert_eq!(outline[1].level, 2);
    }

    #[test]
    fn windows_are_bounded_and_pageable() {
        let rows: Vec<BlockRow> = (0..7)
            .map(|index| row(&format!("b{index}"), "p", &format!("内容{index}"), index))
            .collect();
        let (first, next) = window(&rows, 0, 3);
        assert_eq!(first.len(), 3);
        assert_eq!(next, Some(3));
        let (second, next) = window(&rows, 3, 3);
        assert_eq!(second.len(), 3);
        assert_eq!(next, Some(6));
        let (third, next) = window(&rows, 6, 3);
        assert_eq!(third.len(), 1);
        assert_eq!(next, None);
    }

    #[test]
    fn offset_beyond_end_yields_empty_page() {
        let rows = [row("b0", "p", "x", 0)];
        let (page, next) = window(&rows, 5, 3);
        assert!(page.is_empty());
        assert_eq!(next, None);
    }

    #[test]
    fn display_text_prefers_markdown() {
        let mut rich = row("b0", "p", "plain", 0);
        rich.markdown = Some("**rich**".to_string());
        assert_eq!(rich.display_text(), "**rich**");
        let plain = row("b0", "p", "plain", 0);
        assert_eq!(plain.display_text(), "plain");
    }
}
