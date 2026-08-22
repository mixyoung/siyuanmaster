//! Single machine-readable capability catalog.
//!
//! `catalog/capabilities.json` at the workspace root is the single source
//! of truth for product identity, the current technical ID, bare tool
//! names, gateway endpoints, token scopes, and the safe write-transaction
//! state machine.
//!
//! The catalog stores only *bare* tool names and capability metadata.
//! Fully-qualified MCP names are computed from the current technical ID
//! ([`Catalog::tool_fq_name`]); the SiYuan kernel derives the namespace
//! from plugin.json name (verified in kernel source
//! `plugin/api_mcp.go` at v3.8.0-alpha.2), so a single plugin cannot
//! register a second native namespace and the catalog must not claim one.
//!
//! The TypeScript side is *generated* from the same file
//! (`scripts/generate-capabilities.mjs` -> `src/generated/capabilities.ts`)
//! and a cross-language freshness test guards against drift.

use serde::Deserialize;
use std::collections::HashSet;

/// The catalog JSON embedded at compile time. The path is relative to
/// `crates/core/` and reaches the workspace-root `catalog/` directory.
pub const CATALOG_JSON: &str = include_str!("../../../catalog/capabilities.json");

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u32,
    pub product: Product,
    pub namespaces: Namespaces,
    pub plugin_tools: Vec<PluginTool>,
    pub gateway: Gateway,
    pub write_transaction: WriteTransaction,
    pub security: Security,
    pub compatibility: Compatibility,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub technical_id: String,
    pub display_name: DisplayName,
    pub version: String,
    pub min_app_version: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayName {
    pub default: String,
    #[serde(rename = "zh-CN")]
    pub zh_cn: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Namespaces {
    /// MCP namespace derived from the current technical ID.
    pub plugin: String,
    pub gateway: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginTool {
    pub name: String,
    pub category: String,
    pub read_only: bool,
    pub confirm_default: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Gateway {
    pub endpoints: Vec<GatewayEndpoint>,
    pub token: TokenSpec,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayEndpoint {
    pub path: String,
    pub method: String,
    pub auth: String,
    pub audited: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenSpec {
    pub format: String,
    pub algorithm: String,
    pub default_ttl_seconds: u64,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriteTransaction {
    pub name: String,
    pub max_preview_age_seconds: u64,
    pub states: Vec<String>,
    pub events: Vec<String>,
    pub terminal_states: Vec<String>,
    pub invariants: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub default_deny: bool,
    pub admin_token_stays_in_trusted_boundary: bool,
    pub audit_body_redaction: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub original_tool_count: u32,
    pub technical_id_policy: String,
    pub note: String,
}

/// Tool-name pattern enforced by [`Catalog::validate`].
const TOOL_NAME_PATTERN: &str = "^[a-z][a-z0-9_]*$";

/// Mirrors the SiYuan kernel's sanitization of plugin/tool names
/// (`util.SanitizeName`, e.g. `siyuan-agent-access` -> `siyuan_agent_access`,
/// `siyuanmaster` stays `siyuanmaster`): lowercase ASCII alphanumerics are
/// kept, any other character becomes `_`.
pub fn sanitize_name(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            result.push(character);
        } else if character.is_ascii_uppercase() {
            result.push(character.to_ascii_lowercase());
        } else {
            result.push('_');
        }
    }
    result
}

impl Catalog {
    /// Parses the embedded catalog. Panics are avoided; errors are returned
    /// as human-readable strings so binaries can fail loudly on startup.
    pub fn load() -> Result<Catalog, String> {
        serde_json::from_str(CATALOG_JSON).map_err(|error| format!("catalog parse failed: {error}"))
    }

    /// The namespace prefix the kernel will produce for the current
    /// technical ID: `plugin__<sanitized-technical-id>__`.
    pub fn derived_plugin_namespace(technical_id: &str) -> String {
        format!("plugin__{}__", sanitize_name(technical_id))
    }

    /// Structural validation. Returns an error string describing the first
    /// violation found. Called from tests and from binary startup.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version == 0 {
            return Err("catalog schemaVersion must be >= 1".to_string());
        }
        if self.product.technical_id.is_empty() {
            return Err("catalog product.technicalId must not be empty".to_string());
        }
        // The catalog namespace must match the namespace the kernel derives
        // from the current technical ID; catalog and technical ID may not
        // drift apart.
        let expected = Self::derived_plugin_namespace(&self.product.technical_id);
        if self.namespaces.plugin != expected {
            return Err(format!(
                "namespaces.plugin '{}' does not match the namespace derived from technicalId '{}' ({})",
                self.namespaces.plugin, self.product.technical_id, expected
            ));
        }
        let mut seen = HashSet::new();
        for tool in &self.plugin_tools {
            if !is_valid_tool_name(&tool.name) {
                return Err(format!(
                    "tool name '{}' does not match {TOOL_NAME_PATTERN}",
                    tool.name
                ));
            }
            if !seen.insert(tool.name.as_str()) {
                return Err(format!("duplicate tool name '{}'", tool.name));
            }
        }
        if seen.is_empty() {
            return Err("catalog must declare at least one plugin tool".to_string());
        }
        let original = original_tool_names();
        for name in &original {
            if !seen.contains(name.as_str()) {
                return Err(format!(
                    "original tool '{name}' is missing from the catalog"
                ));
            }
        }
        if self.compatibility.original_tool_count as usize != original.len() {
            return Err(format!(
                "compatibility.originalToolCount {} does not match the original tool set size {}",
                self.compatibility.original_tool_count,
                original.len()
            ));
        }
        if self.write_transaction.states.is_empty()
            || self.write_transaction.events.is_empty()
            || self.write_transaction.terminal_states.is_empty()
        {
            return Err(
                "write transaction states/events/terminalStates must be non-empty".to_string(),
            );
        }
        for terminal in &self.write_transaction.terminal_states {
            if !self.write_transaction.states.contains(terminal) {
                return Err(format!(
                    "terminal state '{terminal}' is not a declared state"
                ));
            }
        }
        if !self.security.default_deny {
            return Err("security.defaultDeny must be true".to_string());
        }
        if !self.security.audit_body_redaction {
            return Err("security.auditBodyRedaction must be true".to_string());
        }
        Ok(())
    }

    /// Fully-qualified MCP name for a tool under the current technical ID
    /// namespace (the only namespace this plugin can register).
    pub fn tool_fq_name(&self, tool: &PluginTool) -> String {
        format!("{}{}", self.namespaces.plugin, tool.name)
    }

    /// All fully-qualified tool names that must be registered.
    pub fn all_tool_fq_names(&self) -> Vec<String> {
        self.plugin_tools
            .iter()
            .map(|tool| self.tool_fq_name(tool))
            .collect()
    }

    /// Finds the gateway endpoint definition for a path+method pair.
    pub fn endpoint(&self, method: &str, path: &str) -> Option<&GatewayEndpoint> {
        self.gateway
            .endpoints
            .iter()
            .find(|endpoint| endpoint.method.eq_ignore_ascii_case(method) && endpoint.path == path)
    }
}

/// The original 16 bare tool names shipped by `siyuan-agent-access` v0.3.0.
/// Since 0.5.0 they are fully qualified under `plugin__siyuanmaster__*`.
pub fn original_tool_names() -> Vec<String> {
    [
        "get_policy",
        "list_accessible_notebooks",
        "list_document_tree",
        "search_notes",
        "read_note",
        "create_note",
        "append_note",
        "update_note",
        "rename_note",
        "move_note",
        "delete_note",
        "suggest_tags",
        "apply_tags",
        "prepare_summary",
        "save_memory",
        "get_audit_log",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect()
}

fn is_valid_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_and_validates() {
        let catalog = Catalog::load().expect("catalog must parse");
        catalog.validate().expect("catalog must validate");
    }

    #[test]
    fn catalog_matches_spec_identity() {
        let catalog = Catalog::load().unwrap();
        assert_eq!(catalog.product.id, "siyuanmaster");
        assert_eq!(catalog.product.technical_id, "siyuanmaster");
        assert_eq!(catalog.product.version, "0.6.1");
        assert_eq!(catalog.product.display_name.zh_cn, "思源大师");
        assert_eq!(catalog.product.display_name.default, "SiYuanMaster");
        assert_eq!(catalog.namespaces.plugin, "plugin__siyuanmaster__");
        assert_eq!(
            Catalog::derived_plugin_namespace("siyuanmaster"),
            "plugin__siyuanmaster__"
        );
    }

    #[test]
    fn sanitize_matches_kernel_behavior() {
        assert_eq!(sanitize_name("siyuan-agent-access"), "siyuan_agent_access");
        assert_eq!(sanitize_name("SiYuanMaster"), "siyuanmaster");
        assert_eq!(sanitize_name("get_policy"), "get_policy");
    }

    #[test]
    fn tool_names_are_unique_and_well_formed() {
        let catalog = Catalog::load().unwrap();
        let mut seen = HashSet::new();
        for tool in &catalog.plugin_tools {
            assert!(is_valid_tool_name(&tool.name), "bad name {}", tool.name);
            assert!(seen.insert(tool.name.as_str()), "duplicate {}", tool.name);
        }
    }

    #[test]
    fn twenty_eight_tools_include_the_original_sixteen() {
        let catalog = Catalog::load().unwrap();
        assert_eq!(catalog.plugin_tools.len(), 28);
        assert_eq!(catalog.compatibility.original_tool_count, 16);
        let names: HashSet<&str> = catalog
            .plugin_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect();
        for name in original_tool_names() {
            assert!(
                names.contains(name.as_str()),
                "missing original tool {name}"
            );
        }
        for name in [
            "resolve_document",
            "read_note_segments",
            "edit_block",
            "register_knowledge_source",
            "register_wiki_authority",
            "knowledge_status",
            "find_wiki_candidates",
            "list_wiki_templates",
            "render_wiki_template",
            "validate_wiki_template",
            "validate_pdf_conversion",
            "plan_source_ingest",
        ] {
            assert!(names.contains(name), "missing new tool {name}");
        }
    }

    #[test]
    fn fq_names_are_computed_from_the_current_technical_id_only() {
        let catalog = Catalog::load().unwrap();
        let fq = catalog.all_tool_fq_names();
        assert_eq!(fq.len(), 28);
        for name in &fq {
            assert!(
                name.starts_with("plugin__siyuanmaster__"),
                "unexpected namespace in {name}"
            );
            assert!(
                !name.contains("siyuan_agent_access"),
                "legacy namespace leaked into {name}"
            );
        }
        // Bare original 16 tools are fully qualified under the current technical id.
        for name in original_tool_names() {
            let expected = format!("plugin__siyuanmaster__{name}");
            assert!(fq.contains(&expected), "missing current fq name {expected}");
        }
    }

    #[test]
    fn txn_state_machine_definition_is_sane() {
        let catalog = Catalog::load().unwrap();
        let txn = &catalog.write_transaction;
        assert_eq!(txn.states.len(), 8);
        assert_eq!(txn.events.len(), 9);
        for terminal in &txn.terminal_states {
            assert!(txn.states.contains(terminal));
        }
        assert!(txn
            .invariants
            .contains(&"snapshot_failure_stops".to_string()));
        assert!(txn.invariants.contains(&"exactly_once".to_string()));
        assert!(txn
            .invariants
            .contains(&"no_auto_retry_on_uncertain".to_string()));
    }

    #[test]
    fn gateway_endpoints_cover_the_spec_surface() {
        let catalog = Catalog::load().unwrap();
        for (method, path) in [
            ("GET", "/healthz"),
            ("GET", "/v1/capabilities"),
            ("POST", "/v1/token/verify"),
            ("GET", "/v1/audit"),
            ("POST", "/v1/txn/preview"),
            ("POST", "/v1/txn/confirm"),
        ] {
            assert!(
                catalog.endpoint(method, path).is_some(),
                "missing {method} {path}"
            );
        }
        // The impossible second namespace alias endpoint must not exist.
        assert!(catalog.endpoint("GET", "/v1/tools/aliases").is_none());
    }
}
