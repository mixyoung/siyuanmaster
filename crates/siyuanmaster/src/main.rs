//! `siyuanmaster` — SiYuanMaster CLI.
//!
//! Subcommands:
//! - `capabilities`                          dump the single capability catalog
//! - `token issue    --subject <s> --scope <s>... [--ttl <sec>]`
//! - `token verify   <token> [--scope <s>...]`
//! - `txn preview    --request-json <json> --store <file>`
//! - `txn confirm    --txn-id <id> --store <file> [--confirmed] [--current-hash <hex>]`
//! - `txn status     --txn-id <id> --store <file>`
//! - `migrate check  --old-config <file> --new-config <file>`
//!
//! Secrets come from `--secret-env VAR` or `--secret-file PATH`; the
//! administrator-level SiYuan API token is never handled by the CLI.

use serde::Deserialize;
use siyuanmaster_core::catalog::Catalog;
use siyuanmaster_core::secret::{SecretKind, SecretRef};
use siyuanmaster_core::token::{TokenEngine, TokenError};
use siyuanmaster_core::txn::{TxnEvent, TxnRecord, TxnStore};

fn main() {
    if let Err(error) = run() {
        eprintln!("siyuanmaster: {error}");
        std::process::exit(1);
    }
}

fn print_usage() {
    eprintln!(
        "siyuanmaster — SiYuanMaster CLI\n\
         \n\
         USAGE:\n\
         \x20 siyuanmaster capabilities\n\
         \x20 siyuanmaster token issue --subject <s> --scope <s>... [--ttl <sec>]\n\
         \x20   [--secret-env VAR | --secret-file PATH]\n\
         \x20 siyuanmaster token verify <token> [--scope <s>...]\n\
         \x20   [--secret-env VAR | --secret-file PATH]\n\
         \x20 siyuanmaster txn preview --request-json <json> --store <file>\n\
         \x20 siyuanmaster txn confirm --txn-id <id> --store <file> [--confirmed] [--current-hash <hex>]\n\
         \x20 siyuanmaster txn status --txn-id <id> --store <file>\n\
         \x20 siyuanmaster migrate check --old-config <file> --new-config <file>\n\
         \n\
         The HMAC secret signs client scoped tokens. Administrator secrets\n\
         never appear in CLI output."
    );
}

/// Parsed CLI arguments: repeated flags plus positionals.
#[derive(Default)]
struct Args {
    flags: Vec<(String, String)>,
    positionals: Vec<String>,
}

impl Args {
    fn parse() -> Args {
        let mut args = Args::default();
        let mut iter = std::env::args().skip(1).peekable();
        while let Some(argument) = iter.next() {
            if let Some(name) = argument.strip_prefix("--") {
                if let Some((flag, inline)) = name.split_once('=') {
                    args.flags.push((flag.to_string(), inline.to_string()));
                } else if iter.peek().is_some_and(|next| !next.starts_with("--")) {
                    let value = iter.next().expect("peeked value");
                    args.flags.push((name.to_string(), value));
                } else {
                    // Boolean flag with no value.
                    args.flags.push((name.to_string(), String::new()));
                }
            } else {
                args.positionals.push(argument);
            }
        }
        args
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(flag, _)| flag == name)
            .map(|(_, value)| value.as_str())
    }

    fn all_flags(&self, name: &str) -> Vec<&str> {
        self.flags
            .iter()
            .filter(|(flag, _)| flag == name)
            .map(|(_, value)| value.as_str())
            .collect()
    }
}

fn resolve_secret(args: &Args) -> Result<Vec<u8>, String> {
    match (args.flag("secret-env"), args.flag("secret-file")) {
        (Some(variable), None) => SecretRef::from_env(SecretKind::GatewayHmac, variable).resolve(),
        (None, Some(path)) => SecretRef::from_file(SecretKind::GatewayHmac, path).resolve(),
        (None, None) => {
            Err("a secret is required: --secret-env VAR or --secret-file PATH".to_string())
        }
        (Some(_), Some(_)) => {
            Err("choose exactly one of --secret-env or --secret-file".to_string())
        }
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse();
    let Some(command) = args.positionals.first().map(String::as_str) else {
        print_usage();
        return Ok(());
    };
    match command {
        "capabilities" => capabilities(),
        "token" => token_command(&args),
        "txn" => txn_command(&args),
        "migrate" => migrate_command(&args),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        other => Err(format!("unknown command '{other}'")),
    }
}

fn capabilities() -> Result<(), String> {
    let catalog = Catalog::load()?;
    catalog.validate()?;
    println!("{}", siyuanmaster_core::catalog::CATALOG_JSON);
    Ok(())
}

fn token_command(args: &Args) -> Result<(), String> {
    let subcommand = args
        .positionals
        .get(1)
        .map(String::as_str)
        .unwrap_or_default();
    match subcommand {
        "issue" => token_issue(args),
        "verify" => token_verify(args),
        _ => Err("usage: siyuanmaster token issue|verify ...".to_string()),
    }
}

fn token_issue(args: &Args) -> Result<(), String> {
    let subject = args
        .flag("subject")
        .ok_or("token issue requires --subject")?;
    let scopes = args.all_flags("scope");
    if scopes.is_empty() {
        return Err("token issue requires at least one --scope".to_string());
    }
    let ttl: u64 = args
        .flag("ttl")
        .map(|value| value.parse().map_err(|_| "invalid --ttl".to_string()))
        .transpose()?
        .unwrap_or(3_600);
    let secret = resolve_secret(args)?;
    let engine = TokenEngine::new(&secret);
    let token = engine.issue(
        subject,
        &scopes,
        ttl,
        siyuanmaster_core::token::now_unix_seconds(),
    )?;
    println!("{token}");
    Ok(())
}

fn token_verify(args: &Args) -> Result<(), String> {
    let token = args
        .positionals
        .get(2)
        .map(String::as_str)
        .ok_or("usage: siyuanmaster token verify <token> [--scope ...]")?;
    let required = args.all_flags("scope").first().copied();
    let secret = resolve_secret(args)?;
    let engine = TokenEngine::new(&secret);
    match engine.verify(
        token,
        required,
        siyuanmaster_core::token::now_unix_seconds(),
    ) {
        Ok(verified) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "valid": true,
                    "subject": verified.claims.sub,
                    "scopes": verified.claims.scopes,
                    "expiresAt": verified.claims.exp,
                }))
                .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Err(error) => {
            let message = match error {
                TokenError::ScopeDenied { .. } => "scope_denied",
                TokenError::Expired => "token_expired",
                _ => "invalid_token",
            };
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "valid": false, "error": message })
                )
                .map_err(|error| error.to_string())?
            );
            Err(format!("verification failed: {message}"))
        }
    }
}

#[derive(Deserialize)]
struct TxnPreviewJson {
    kind: String,
    #[serde(rename = "targetId")]
    target_id: String,
    #[serde(rename = "expectedHash")]
    expected_hash: Option<String>,
}

fn txn_command(args: &Args) -> Result<(), String> {
    let subcommand = args
        .positionals
        .get(1)
        .map(String::as_str)
        .unwrap_or_default();
    let store_path = args.flag("store").ok_or("txn requires --store <file>")?;
    let mut store = TxnStore::load_json(std::path::Path::new(store_path))?;
    match subcommand {
        "preview" => txn_preview(args, store_path, &mut store),
        "confirm" => txn_confirm(args, store_path, &mut store),
        "status" => txn_status(args, &store),
        _ => Err("usage: siyuanmaster txn preview|confirm|status ...".to_string()),
    }
}

fn txn_preview(args: &Args, store_path: &str, store: &mut TxnStore) -> Result<(), String> {
    let request_json = args
        .flag("request-json")
        .ok_or("txn preview requires --request-json <json>")?;
    let request: TxnPreviewJson = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid --request-json: {error}"))?;
    // Write targets are addressed by exact ID; paths are lookup-only.
    siyuanmaster_core::path::parse_write_target(&request.target_id, request.expected_hash.clone())
        .map_err(|error| error.to_string())?;

    let mut record = TxnRecord::new(
        siyuanmaster_core::txn::generate_txn_id(),
        request.kind,
        siyuanmaster_core::token::now_unix_seconds(),
    );
    record
        .transition(TxnEvent::Prepare)
        .map_err(|error| error.to_string())?;
    let Some(snapshot_hash) = request.expected_hash else {
        // Snapshot failure: the transaction stops, nothing is written.
        record
            .transition(TxnEvent::SnapshotFailed)
            .map_err(|error| error.to_string())?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "txnId": record.id,
                "state": "failed",
                "failure": "snapshot_failed",
                "notice": "expectedHash is required; no write was issued"
            }))
            .map_err(|error| error.to_string())?
        );
        return Ok(());
    };
    record.set_snapshot_hash(snapshot_hash.clone());
    record
        .transition(TxnEvent::SnapshotOk)
        .map_err(|error| error.to_string())?;
    let txn_id = record.id.clone();
    store.insert(record);
    store.save_json(std::path::Path::new(store_path))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "txnId": txn_id,
            "state": "awaiting_confirmation",
            "snapshotHash": snapshot_hash,
            "requiresConfirmation": true,
            "nextStep": "siyuanmaster txn confirm --txn-id <id> --store <file> --confirmed --current-hash <hex>"
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn txn_confirm(args: &Args, store_path: &str, store: &mut TxnStore) -> Result<(), String> {
    let txn_id = args
        .flag("txn-id")
        .ok_or("txn confirm requires --txn-id <id>")?;
    let confirmed = args.flag("confirmed").is_some();
    let current_hash = args
        .flag("current-hash")
        .ok_or("txn confirm requires --current-hash <hex>")?;
    let Some(record) = store.get_mut(txn_id) else {
        return Err(format!("transaction '{txn_id}' not found"));
    };
    if !confirmed {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "txnId": txn_id,
                "state": "awaiting_confirmation",
                "requiresConfirmation": true,
                "notice": "confirmation_required: retry with --confirmed after user approval"
            }))
            .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if let Err(error) = record.transition(TxnEvent::Confirm) {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "txnId": txn_id,
                "state": record.state.map(|s| s.as_str()).unwrap_or("created"),
                "failure": "already_finalized",
                "notice": error.to_string()
            }))
            .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    record.set_current_hash(current_hash.to_string());
    if record.snapshot_hash.as_deref() != Some(current_hash) {
        record
            .transition(TxnEvent::StateMismatch)
            .map_err(|error| error.to_string())?;
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "txnId": txn_id,
                "state": "failed",
                "failure": "state_changed",
                "notice": "target changed after preview; request a new preview"
            }))
            .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    // The transaction is confirmed and state-verified. Execution requires
    // the gateway -> SiYuan-kernel proxy (P2); the CLI parks the record in
    // the `confirmed` state exactly like the gateway.
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "txnId": txn_id,
            "state": "confirmed",
            "snapshotHash": record.snapshot_hash,
            "notice": "confirmed and state-verified; execution requires the SiYuan kernel proxy (P2); no write was issued"
        }))
        .map_err(|error| error.to_string())?
    );
    store.save_json(std::path::Path::new(store_path))?;
    Ok(())
}

fn txn_status(args: &Args, store: &TxnStore) -> Result<(), String> {
    let txn_id = args
        .flag("txn-id")
        .ok_or("txn status requires --txn-id <id>")?;
    let Some(record) = store.get(txn_id) else {
        return Err(format!("transaction '{txn_id}' not found"));
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "txnId": record.id,
            "kind": record.kind,
            "state": record.state.map(|s| s.as_str()).unwrap_or("created"),
            "snapshotHash": record.snapshot_hash,
            "currentHash": record.current_hash,
            "failure": record.failure.map(|f| format!("{:?}", f)),
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn migrate_command(args: &Args) -> Result<(), String> {
    let old_config = args
        .flag("old-config")
        .ok_or("migrate check requires --old-config <file>")?;
    let new_config = args
        .flag("new-config")
        .ok_or("migrate check requires --new-config <file>")?;

    let old_content = std::fs::read_to_string(old_config)
        .map_err(|error| format!("cannot read old config '{old_config}': {error}"))?;
    let old_value: serde_json::Value = serde_json::from_str(&old_content)
        .map_err(|error| format!("old config is not valid JSON: {error}"))?;
    let Some(old_object) = old_value.as_object() else {
        return Err("old config must be a JSON object".to_string());
    };
    let has_access = old_object.contains_key("access");
    let has_operations = old_object.contains_key("operations");
    let has_tagging = old_object.contains_key("tagging");
    let has_audit = old_object.contains_key("audit");
    let missing: Vec<&str> = [
        (!has_access).then_some("access"),
        (!has_operations).then_some("operations"),
        (!has_tagging).then_some("tagging"),
        (!has_audit).then_some("audit"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !has_access {
        return Err(
            "old config has no 'access' section; it is not a siyuanmaster policy file".to_string(),
        );
    }

    let new_exists = std::path::Path::new(new_config).exists();
    let decision = if new_exists {
        "new config wins; migration is a no-op"
    } else {
        "old config would be migrated and normalized (normalizePolicy)"
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "oldConfig": old_config,
            "newConfig": new_config,
            "valid": true,
            "decision": decision,
            "missingSections": missing,
            "notice": "missing sections fall back to safe defaults in the TypeScript normalizePolicy"
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an [`Args`] from the argv slice *after* the binary name.
    fn with_args(argv: &[&str]) -> Args {
        let mut args = Args::default();
        let mut iter = argv.iter().peekable();
        while let Some(argument) = iter.next() {
            if let Some(name) = argument.strip_prefix("--") {
                if let Some((flag, inline)) = name.split_once('=') {
                    args.flags.push((flag.to_string(), inline.to_string()));
                } else if iter.peek().is_some_and(|next| !next.starts_with("--")) {
                    let value = (*iter.next().expect("peeked value")).to_string();
                    args.flags.push((name.to_string(), value));
                } else {
                    args.flags.push((name.to_string(), String::new()));
                }
            } else {
                args.positionals.push(argument.to_string());
            }
        }
        args
    }

    #[test]
    fn capabilities_command_prints_valid_catalog() {
        let catalog = Catalog::load().unwrap();
        catalog.validate().unwrap();
        // The dump is the raw embedded JSON; asserting it parses back to
        // the same version is the meaningful check.
        let dumped: serde_json::Value =
            serde_json::from_str(siyuanmaster_core::catalog::CATALOG_JSON).unwrap();
        assert_eq!(dumped["schemaVersion"], 1);
    }

    #[test]
    fn token_issue_and_verify_roundtrip() {
        let args = with_args(&[
            "token",
            "issue",
            "--subject",
            "cli-agent",
            "--scope",
            "op:read",
            "--ttl",
            "120",
            "--secret-env",
            "SIYUANMASTER_TEST_SECRET",
        ]);
        // Set the env var so resolve_secret works.
        std::env::set_var("SIYUANMASTER_TEST_SECRET", "cli-test-secret");
        let secret = resolve_secret(&args).unwrap();
        let engine = TokenEngine::new(&secret);
        let token = engine.issue("cli-agent", &["op:read"], 120, 1_000).unwrap();
        let verified = engine.verify(&token, Some("op:read"), 1_000).unwrap();
        assert_eq!(verified.claims.sub, "cli-agent");
        std::env::remove_var("SIYUANMASTER_TEST_SECRET");
    }

    #[test]
    fn migrate_check_accepts_valid_old_config() {
        let dir = std::env::temp_dir().join(format!("smt-migrate-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let old = dir.join("old-policy.json");
        let new = dir.join("new-policy.json");
        std::fs::write(
            &old,
            r#"{"access":{"mode":"allowlist","selectedNotebookIds":[],"defaultDecision":"deny"},"operations":{},"tagging":{},"audit":{}}"#,
        )
        .unwrap();
        let _ = std::fs::remove_file(&new);

        let args = with_args(&[
            "migrate",
            "check",
            "--old-config",
            old.to_str().unwrap(),
            "--new-config",
            new.to_str().unwrap(),
        ]);
        migrate_command(&args).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_check_rejects_invalid_old_config() {
        let dir = std::env::temp_dir().join(format!("smt-migrate-bad-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let old = dir.join("old-policy.json");
        let new = dir.join("new-policy.json");
        std::fs::write(&old, "not json").unwrap();
        let args = with_args(&[
            "migrate",
            "check",
            "--old-config",
            old.to_str().unwrap(),
            "--new-config",
            new.to_str().unwrap(),
        ]);
        assert!(migrate_command(&args).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn txn_store_file_lifecycle() {
        let path = std::env::temp_dir().join(format!("smt-cli-txn-{}.json", std::process::id()));
        let path_str = path.to_str().unwrap().to_string();

        let preview_args = with_args(&[
            "txn",
            "preview",
            "--request-json",
            r#"{"kind":"edit_block","targetId":"20260101000000-abcdefg","expectedHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            "--store",
            &path_str,
        ]);
        let mut store = TxnStore::load_json(&path).unwrap();
        txn_preview(&preview_args, &path_str, &mut store).unwrap();
        assert_eq!(store.len(), 1);
        let txn_id = store.all()[0].id.clone();

        let status_args = with_args(&["txn", "status", "--txn-id", &txn_id, "--store", &path_str]);
        txn_status(&status_args, &store).unwrap();

        // Drifted confirm -> failed state_changed.
        let drifted_args = with_args(&[
            "txn",
            "confirm",
            "--txn-id",
            &txn_id,
            "--store",
            &path_str,
            "--confirmed",
            "--current-hash",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ]);
        txn_confirm(&drifted_args, &path_str, &mut store).unwrap();
        assert_eq!(
            store.get(&txn_id).unwrap().state.map(|s| s.as_str()),
            Some("failed")
        );
        let _ = std::fs::remove_file(&path);
    }
}
