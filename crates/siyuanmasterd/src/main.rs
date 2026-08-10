//! `siyuanmasterd` — SiYuanMaster local gateway.
//!
//! A minimal HTTP/1.1 server (stdlib only) that exposes:
//!
//! - `GET /healthz` — liveness (no auth)
//! - `GET /v1/capabilities` — the single capability catalog (no auth)
//! - `POST /v1/token/verify` — scoped-token verification (audited)
//! - `GET /v1/audit` — audit entries (requires `audit:read`)
//! - `POST /v1/txn/preview|confirm` — SafeWriteTxn transaction lifecycle
//!   (requires `txn:write`)
//!
//! Security posture: default deny. Every data endpoint requires a valid
//! scoped token with the scope declared in the catalog. The administrator
//! SiYuan API token and the gateway HMAC secret stay inside the trusted
//! boundary; responses and audit entries never contain them.

use serde::{Deserialize, Serialize};
use siyuanmaster_core::audit::{AuditEntry, AuditOutcome};
use siyuanmaster_core::catalog::Catalog;
use siyuanmaster_core::secret::{SecretKind, SecretRef};
use siyuanmaster_core::token::{TokenEngine, TokenError};
use siyuanmaster_core::txn::{generate_txn_id, TxnEvent, TxnRecord, TxnState, TxnStore};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

const DEFAULT_LISTEN: &str = "127.0.0.1:7806";

/// Shared gateway state. `Mutex` guards are short-lived; the server is a
/// local single-user tool.
struct GatewayState {
    engine: TokenEngine,
    store: Mutex<TxnStore>,
    audit: Mutex<Vec<AuditEntry>>,
    admin_token_configured: bool,
    catalog: Catalog,
}

#[derive(Clone, Copy)]
struct CliConfig {
    listen: &'static str,
    secret_env: Option<&'static str>,
    secret_file: Option<&'static str>,
    admin_env: Option<&'static str>,
    admin_file: Option<&'static str>,
}

fn print_usage() {
    eprintln!(
        "siyuanmasterd — SiYuanMaster local gateway\n\
         \n\
         USAGE:\n\
         \x20 siyuanmasterd [--listen 127.0.0.1:7806]\n\
         \x20   [--secret-env SIYUANMASTER_SECRET | --secret-file <path>]   (required)\n\
         \x20   [--admin-token-env SIYUANMASTER_ADMIN_TOKEN | --admin-token-file <path>]\n\
         \n\
         The HMAC secret signs client scoped tokens. The admin token is held\n\
         for the future outbound SiYuan-kernel proxy and is never exposed."
    );
}

fn main() {
    if let Err(error) = run() {
        eprintln!("siyuanmasterd: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut config = CliConfig {
        listen: DEFAULT_LISTEN,
        secret_env: None,
        secret_file: None,
        admin_env: None,
        admin_file: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--listen" => {
                let value = args.next().ok_or("--listen requires a value")?;
                config.listen = Box::leak(value.into_boxed_str());
            }
            "--secret-env" => {
                let value = args.next().ok_or("--secret-env requires a value")?;
                config.secret_env = Some(Box::leak(value.into_boxed_str()));
            }
            "--secret-file" => {
                let value = args.next().ok_or("--secret-file requires a value")?;
                config.secret_file = Some(Box::leak(value.into_boxed_str()));
            }
            "--admin-token-env" => {
                let value = args.next().ok_or("--admin-token-env requires a value")?;
                config.admin_env = Some(Box::leak(value.into_boxed_str()));
            }
            "--admin-token-file" => {
                let value = args.next().ok_or("--admin-token-file requires a value")?;
                config.admin_file = Some(Box::leak(value.into_boxed_str()));
            }
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            other => return Err(format!("unknown argument '{other}'")),
        }
    }

    let secret_ref = match (config.secret_env, config.secret_file) {
        (Some(variable), None) => SecretRef::from_env(SecretKind::GatewayHmac, variable),
        (None, Some(path)) => SecretRef::from_file(SecretKind::GatewayHmac, path),
        (None, None) => {
            return Err("a gateway secret is required (--secret-env or --secret-file)".to_string())
        }
        (Some(_), Some(_)) => {
            return Err("choose exactly one of --secret-env or --secret-file".to_string())
        }
    };
    let secret = secret_ref.resolve()?;
    if secret.is_empty() {
        return Err("gateway secret must not be empty".to_string());
    }

    // The admin token is *checked for presence only*; its value is never
    // read into memory by this process in P0.
    let admin_token_configured = match (config.admin_env, config.admin_file) {
        (Some(variable), None) => std::env::var_os(variable).is_some(),
        (None, Some(path)) => std::path::Path::new(path).exists(),
        _ => false,
    };

    let catalog = Catalog::load()?;
    catalog.validate()?;

    let listener = TcpListener::bind(config.listen)
        .map_err(|error| format!("cannot bind {}: {error}", config.listen))?;
    let actual = listener
        .local_addr()
        .map_err(|error| format!("cannot read listen address: {error}"))?;

    let version = catalog.product.version.clone();
    let admin_configured = admin_token_configured;
    let state = Arc::new(GatewayState {
        engine: TokenEngine::new(&secret),
        store: Mutex::new(TxnStore::new()),
        audit: Mutex::new(Vec::new()),
        admin_token_configured,
        catalog,
    });

    eprintln!(
        "siyuanmasterd {} listening on http://{actual} (admin token {} configured)",
        version,
        if admin_configured { "is" } else { "is NOT" }
    );

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let _ = std::thread::spawn(move || {
                    let _ = handle_connection(stream, &state);
                });
            }
            Err(error) => eprintln!("siyuanmasterd: accept error: {error}"),
        }
    }
    Ok(())
}

/// Parsed HTTP request (the subset this gateway understands).
struct HttpRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        if let Some((key, value)) = pair.split_once('=') {
            map.insert(key.to_string(), value.to_string());
        }
    }
    map
}

fn read_request(reader: &mut BufReader<TcpStream>) -> Result<HttpRequest, String> {
    let mut request_line = String::new();
    if reader
        .read_line(&mut request_line)
        .map_err(|error| error.to_string())?
        == 0
    {
        return Err("empty request".to_string());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing method")?.to_string();
    let target = parts.next().ok_or("missing path")?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), parse_query(query)),
        None => (target, HashMap::new()),
    };

    let mut headers = HashMap::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            return Err("unexpected end of headers".to_string());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.trim_end().split_once(':') {
            let key = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if key == "content-length" {
                content_length = value
                    .parse::<usize>()
                    .map_err(|_| "invalid content-length".to_string())?;
            }
            headers.insert(key, value);
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("cannot read body: {error}"))?;
    }

    Ok(HttpRequest {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn json_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    body: &str,
) -> std::io::Result<()> {
    write_response(
        stream,
        status,
        status_text,
        "application/json",
        body.as_bytes(),
    )
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    status_text: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn handle_connection(mut stream: TcpStream, state: &GatewayState) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let request = match read_request(&mut reader) {
        Ok(request) => request,
        Err(_) => {
            let _ = write_response(
                &mut stream,
                400,
                "Bad Request",
                "application/json",
                b"{\"error\":\"bad_request\"}",
            );
            return Ok(());
        }
    };
    route(&mut stream, state, request)
}

fn route(stream: &mut TcpStream, state: &GatewayState, request: HttpRequest) -> Result<(), String> {
    let catalog = &state.catalog;
    let endpoint = catalog.endpoint(&request.method, &request.path);
    let Some(endpoint) = endpoint else {
        return deny(stream, 404, "not_found");
    };

    if endpoint.auth == "none" {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/healthz") => return health(stream, state),
            ("GET", "/v1/capabilities") => return capabilities(stream),
            ("POST", "/v1/token/verify") => return verify_token(stream, state, &request),
            _ => return deny(stream, 405, "method_not_allowed"),
        }
    }

    // Everything below requires a bearer token with the endpoint's scope.
    let required_scope = endpoint
        .auth
        .strip_prefix("scope:")
        .ok_or("invalid auth spec")?;
    let bearer = bearer_token(&request.headers);
    let Some(token) = bearer else {
        return deny(stream, 401, "unauthorized");
    };
    let now = siyuanmaster_core::token::now_unix_seconds();
    let verified = state.engine.verify(&token, Some(required_scope), now);
    let verified = match verified {
        Ok(verified) => verified,
        Err(error) => {
            let subject = state
                .engine
                .verify_signature(&token)
                .map(|claims| claims.sub)
                .unwrap_or_else(|_| "unknown".to_string());
            let outcome = match error {
                TokenError::ScopeDenied { .. } | TokenError::Expired => AuditOutcome::Denied,
                _ => AuditOutcome::Failed,
            };
            audit(
                state,
                AuditEntry::new("token_verify", outcome)
                    .with_subject(subject)
                    .with_message(format!("{:?}", error))
                    .with_timestamp(iso_now()),
            );
            return deny(stream, 403, "forbidden");
        }
    };

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/audit") => audit_entries(stream, state, &request, &verified.claims.sub),
        ("POST", "/v1/txn/preview") => txn_preview(stream, state, &request, &verified.claims.sub),
        ("POST", "/v1/txn/confirm") => txn_confirm(stream, state, &request, &verified.claims.sub),
        _ => deny(stream, 404, "not_found"),
    }
}

fn health(stream: &mut TcpStream, state: &GatewayState) -> Result<(), String> {
    let body = serde_json::json!({
        "ok": true,
        "service": "siyuanmasterd",
        "version": state.catalog.product.version,
        "catalogSchema": state.catalog.schema_version,
        "adminTokenConfigured": state.admin_token_configured,
        "pendingTxns": state.store.lock().map(|store| store.len()).unwrap_or(0),
    });
    json_response(stream, 200, "OK", &body.to_string()).map_err(|error| error.to_string())
}

fn capabilities(stream: &mut TcpStream) -> Result<(), String> {
    json_response(stream, 200, "OK", siyuanmaster_core::catalog::CATALOG_JSON)
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct VerifyRequest {
    token: String,
    #[serde(rename = "requiredScope")]
    required_scope: Option<String>,
}

fn verify_token(
    stream: &mut TcpStream,
    state: &GatewayState,
    request: &HttpRequest,
) -> Result<(), String> {
    let parsed: Result<VerifyRequest, _> = serde_json::from_slice(&request.body);
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(_) => return deny(stream, 400, "bad_request"),
    };
    let now = siyuanmaster_core::token::now_unix_seconds();
    match state
        .engine
        .verify(&parsed.token, parsed.required_scope.as_deref(), now)
    {
        Ok(verified) => {
            audit(
                state,
                AuditEntry::new("token_verify", AuditOutcome::Allowed)
                    .with_subject(verified.claims.sub.clone())
                    .with_timestamp(iso_now()),
            );
            let body = serde_json::json!({
                "valid": true,
                "subject": verified.claims.sub,
                "scopes": verified.claims.scopes,
                "expiresAt": verified.claims.exp,
            });
            json_response(stream, 200, "OK", &body.to_string()).map_err(|error| error.to_string())
        }
        Err(error) => {
            // The token string itself is never audited; only the subject
            // (when the signature happens to decode) and the error kind.
            let subject = state
                .engine
                .verify_signature(&parsed.token)
                .map(|claims| claims.sub)
                .unwrap_or_else(|_| "unknown".to_string());
            let outcome = match error {
                TokenError::ScopeDenied { .. } | TokenError::Expired => AuditOutcome::Denied,
                _ => AuditOutcome::Failed,
            };
            audit(
                state,
                AuditEntry::new("token_verify", outcome)
                    .with_subject(subject)
                    .with_message(format!("{:?}", error))
                    .with_timestamp(iso_now()),
            );
            let message = match error {
                TokenError::ScopeDenied { .. } => "scope_denied",
                TokenError::Expired => "token_expired",
                _ => "invalid_token",
            };
            let body = serde_json::json!({ "valid": false, "error": message });
            json_response(stream, 403, "Forbidden", &body.to_string())
                .map_err(|error| error.to_string())
        }
    }
}

#[derive(Serialize)]
struct AuditResponse {
    count: usize,
    entries: Vec<AuditEntry>,
}

fn audit_entries(
    stream: &mut TcpStream,
    state: &GatewayState,
    request: &HttpRequest,
    subject: &str,
) -> Result<(), String> {
    let limit: usize = request
        .query
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(50)
        .min(200);
    let entries = {
        let audit = state
            .audit
            .lock()
            .map_err(|_| "audit lock poisoned".to_string())?;
        audit.iter().rev().take(limit).cloned().collect::<Vec<_>>()
    };
    let body = AuditResponse {
        count: entries.len(),
        entries,
    };
    audit(
        state,
        AuditEntry::new("audit_read", AuditOutcome::Allowed)
            .with_subject(subject.to_string())
            .with_timestamp(iso_now()),
    );
    json_response(
        stream,
        200,
        "OK",
        &serde_json::to_string(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct TxnPreviewRequest {
    kind: String,
    #[serde(rename = "targetId")]
    target_id: String,
    #[serde(rename = "expectedHash")]
    expected_hash: Option<String>,
}

#[derive(Serialize)]
struct TxnResponse {
    txn_id: String,
    state: String,
    snapshot_hash: Option<String>,
    requires_confirmation: bool,
    notice: Option<String>,
    failure: Option<String>,
}

fn txn_preview(
    stream: &mut TcpStream,
    state: &GatewayState,
    request: &HttpRequest,
    subject: &str,
) -> Result<(), String> {
    let parsed: Result<TxnPreviewRequest, _> = serde_json::from_slice(&request.body);
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(_) => return deny(stream, 400, "bad_request"),
    };
    let mut record = TxnRecord::new(
        generate_txn_id(),
        parsed.kind,
        siyuanmaster_core::token::now_unix_seconds(),
    );
    if let Err(error) = record.transition(TxnEvent::Prepare) {
        audit(
            state,
            AuditEntry::new("txn_preview", AuditOutcome::Failed)
                .with_subject(subject.to_string())
                .with_document(parsed.target_id.clone())
                .with_message(error.to_string())
                .with_timestamp(iso_now()),
        );
        return deny(stream, 409, "conflict");
    }
    let Some(snapshot_hash) = parsed.expected_hash else {
        // A missing snapshot is a snapshot failure: the transaction stops
        // and nothing is written (invariant: snapshot_failure_stops).
        let _ = record.transition(TxnEvent::SnapshotFailed);
        audit(
            state,
            AuditEntry::new("txn_preview", AuditOutcome::Failed)
                .with_subject(subject.to_string())
                .with_document(parsed.target_id.clone())
                .with_message("snapshot_failed")
                .with_timestamp(iso_now()),
        );
        let body = TxnResponse {
            txn_id: record.id.clone(),
            state: "failed".to_string(),
            snapshot_hash: None,
            requires_confirmation: false,
            notice: Some(
                "snapshot_failed: expectedHash is required; no write was issued".to_string(),
            ),
            failure: Some("snapshot_failed".to_string()),
        };
        return json_response(
            stream,
            409,
            "Conflict",
            &serde_json::to_string(&body).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string());
    };
    record.set_snapshot_hash(snapshot_hash.clone());
    if let Err(error) = record.transition(TxnEvent::SnapshotOk) {
        return Err(format!("internal transaction error: {error}"));
    }
    let txn_id = record.id.clone();
    {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "store lock poisoned".to_string())?;
        store.insert(record);
    }
    audit(
        state,
        AuditEntry::new("txn_preview", AuditOutcome::Allowed)
            .with_subject(subject.to_string())
            .with_document(parsed.target_id)
            .with_txn(txn_id.clone())
            .with_timestamp(iso_now()),
    );
    let body = TxnResponse {
        txn_id,
        state: "awaiting_confirmation".to_string(),
        snapshot_hash: Some(snapshot_hash),
        requires_confirmation: true,
        notice: Some("preview accepted; call txn/confirm with the same target hash".to_string()),
        failure: None,
    };
    json_response(
        stream,
        200,
        "OK",
        &serde_json::to_string(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct TxnConfirmRequest {
    #[serde(rename = "txnId")]
    txn_id: String,
    confirmed: bool,
    #[serde(rename = "currentHash")]
    current_hash: String,
}

fn txn_confirm(
    stream: &mut TcpStream,
    state: &GatewayState,
    request: &HttpRequest,
    subject: &str,
) -> Result<(), String> {
    let parsed: Result<TxnConfirmRequest, _> = serde_json::from_slice(&request.body);
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(_) => return deny(stream, 400, "bad_request"),
    };

    let (response, status) = {
        let mut store = state
            .store
            .lock()
            .map_err(|_| "store lock poisoned".to_string())?;
        let Some(record) = store.get_mut(&parsed.txn_id) else {
            return deny(stream, 404, "txn_not_found");
        };
        if !parsed.confirmed {
            let body = TxnResponse {
                txn_id: record.id.clone(),
                state: TxnState::AwaitingConfirmation.as_str().to_string(),
                snapshot_hash: record.snapshot_hash.clone(),
                requires_confirmation: true,
                notice: Some(
                    "confirmation_required: retry with confirmed=true after user approval"
                        .to_string(),
                ),
                failure: None,
            };
            (body, 409)
        } else if let Err(error) = record.transition(TxnEvent::Confirm) {
            let body = TxnResponse {
                txn_id: record.id.clone(),
                state: record
                    .state
                    .map(|txn_state| txn_state.as_str())
                    .unwrap_or("created")
                    .to_string(),
                snapshot_hash: record.snapshot_hash.clone(),
                requires_confirmation: false,
                notice: Some(error.to_string()),
                failure: Some("already_finalized".to_string()),
            };
            (body, 409)
        } else {
            // State check: the caller re-read the target and supplied its
            // current hash; any drift aborts before execution.
            record.set_current_hash(parsed.current_hash.clone());
            let drifted = record.snapshot_hash.as_deref() != Some(parsed.current_hash.as_str());
            if drifted {
                let _ = record.transition(TxnEvent::StateMismatch);
                let body = TxnResponse {
                    txn_id: record.id.clone(),
                    state: TxnState::Failed.as_str().to_string(),
                    snapshot_hash: record.snapshot_hash.clone(),
                    requires_confirmation: false,
                    notice: Some(
                        "state_changed: target changed after preview; request a new preview"
                            .to_string(),
                    ),
                    failure: Some("state_changed".to_string()),
                };
                (body, 409)
            } else {
                // Execution requires the gateway -> SiYuan-kernel proxy,
                // which is a P2 item. The transaction is parked in the
                // `confirmed` state; nothing was written.
                let body = TxnResponse {
                    txn_id: record.id.clone(),
                    state: TxnState::Confirmed.as_str().to_string(),
                    snapshot_hash: record.snapshot_hash.clone(),
                    requires_confirmation: false,
                    notice: Some("confirmed and state-verified; execution requires the SiYuan kernel proxy (P2); no write was issued".to_string()),
                    failure: None,
                };
                (body, 200)
            }
        }
    };

    audit(
        state,
        AuditEntry::new(
            "txn_confirm",
            if status == 200 {
                AuditOutcome::Allowed
            } else {
                AuditOutcome::Failed
            },
        )
        .with_subject(subject.to_string())
        .with_txn(parsed.txn_id)
        .with_message(response.notice.clone().unwrap_or_default())
        .with_timestamp(iso_now()),
    );
    json_response(
        stream,
        status,
        if status == 200 { "OK" } else { "Conflict" },
        &serde_json::to_string(&response).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn bearer_token(headers: &HashMap<String, String>) -> Option<String> {
    let authorization = headers.get("authorization")?;
    let token = authorization.strip_prefix("Bearer ")?;
    Some(token.to_string())
}

fn deny(stream: &mut TcpStream, status: u16, reason: &str) -> Result<(), String> {
    let body = serde_json::json!({ "error": reason });
    json_response(stream, status, status_text(status), &body.to_string())
        .map_err(|error| error.to_string())
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        _ => "Error",
    }
}

/// ISO-8601 UTC timestamp without external dependencies.
fn iso_now() -> String {
    let seconds = siyuanmaster_core::token::now_unix_seconds();
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let (hour, minute, second) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since 1970-01-01 to (year, month, day); Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

fn audit(state: &GatewayState, entry: AuditEntry) {
    if let Ok(mut entries) = state.audit.lock() {
        entries.push(entry);
        if entries.len() > 2000 {
            let excess = entries.len() - 2000;
            entries.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    struct TestServer {
        addr: std::net::SocketAddr,
        secret: String,
    }

    fn spawn_server(admin_env_name: &str, admin_env_value: Option<&str>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let addr = listener.local_addr().unwrap();
        let secret = "test-hmac-secret".to_string();
        let catalog = Catalog::load().unwrap();
        let state = Arc::new(GatewayState {
            engine: TokenEngine::new(secret.as_bytes()),
            store: Mutex::new(TxnStore::new()),
            audit: Mutex::new(Vec::new()),
            admin_token_configured: admin_env_value.is_some(),
            catalog,
        });
        let _handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if let Ok(stream) = stream {
                    let state = Arc::clone(&state);
                    let _ = std::thread::spawn(move || {
                        let _ = handle_connection(stream, &state);
                    });
                }
            }
        });
        let _ = (admin_env_name, admin_env_value);
        TestServer { addr, secret }
    }

    fn raw_request(server: &TestServer, request: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(server.addr).expect("connect");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        let mut reader = BufReader::new(stream);
        reader.read_to_string(&mut response).unwrap();
        let status_line = response.lines().next().unwrap_or_default().to_string();
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let body = response
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or_default()
            .to_string();
        (status, body)
    }

    fn get(server: &TestServer, path: &str, bearer: Option<&str>) -> (u16, String) {
        let authorization = match bearer {
            Some(token) => format!("Authorization: Bearer {token}\r\n"),
            None => String::new(),
        };
        raw_request(
            server,
            &format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Connection: close\r\n\r\n"),
        )
    }

    fn post(server: &TestServer, path: &str, body: &str, bearer: Option<&str>) -> (u16, String) {
        let authorization = match bearer {
            Some(token) => format!("Authorization: Bearer {token}\r\n"),
            None => String::new(),
        };
        raw_request(
            server,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    fn issue_token(server: &TestServer, scopes: &[&str]) -> String {
        let engine = TokenEngine::new(server.secret.as_bytes());
        engine
            .issue(
                "test-agent",
                scopes,
                3600,
                siyuanmaster_core::token::now_unix_seconds(),
            )
            .unwrap()
    }

    #[test]
    fn healthz_reports_ok_and_never_leaks_admin_token() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", Some("admin-token-value"));
        let (status, body) = get(&server, "/healthz", None);
        assert_eq!(status, 200);
        assert!(body.contains("\"ok\":true"));
        assert!(body.contains("siyuanmasterd"));
        assert!(body.contains("\"adminTokenConfigured\":true"));
        assert!(
            !body.contains("admin-token-value"),
            "admin token must never appear"
        );
    }

    #[test]
    fn capabilities_returns_the_catalog() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let (status, body) = get(&server, "/v1/capabilities", None);
        assert_eq!(status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["product"]["id"], "siyuanmaster");
        assert_eq!(parsed["product"]["technicalId"], "siyuanmaster");
        assert_eq!(parsed["namespaces"]["plugin"], "plugin__siyuanmaster__");
        assert_eq!(parsed["pluginTools"].as_array().unwrap().len(), 19);
    }

    #[test]
    fn unknown_path_is_default_denied() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let (status, body) = get(&server, "/v1/secret-stuff", None);
        assert_eq!(status, 404);
        assert!(body.contains("not_found"));
    }

    #[test]
    fn protected_endpoint_without_token_is_rejected() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let (status, body) = get(&server, "/v1/audit", None);
        assert_eq!(status, 401);
        assert!(body.contains("unauthorized"));
    }

    #[test]
    fn protected_endpoint_with_insufficient_scope_is_rejected() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let token = issue_token(&server, &["op:read"]);
        let (status, _) = get(&server, "/v1/audit", Some(&token));
        assert_eq!(status, 403);
    }

    #[test]
    fn token_verify_accepts_valid_token_and_audits() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let token = issue_token(&server, &["op:read", "audit:read"]);
        let body = serde_json::json!({ "token": token, "requiredScope": "op:read" });
        let (status, response) = post(&server, "/v1/token/verify", &body.to_string(), None);
        assert_eq!(status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(parsed["valid"], true);
        assert_eq!(parsed["subject"], "test-agent");
        assert!(!response.contains(&token), "token must never be echoed");
    }

    #[test]
    fn token_verify_rejects_expired_and_tampered_tokens() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let expired = {
            let engine = TokenEngine::new(server.secret.as_bytes());
            engine
                .issue(
                    "test-agent",
                    &["op:read"],
                    1,
                    siyuanmaster_core::token::now_unix_seconds() - 100,
                )
                .unwrap()
        };
        let body = serde_json::json!({ "token": expired });
        let (status, response) = post(&server, "/v1/token/verify", &body.to_string(), None);
        assert_eq!(status, 403);
        assert!(response.contains("token_expired"));

        let tampered = format!("{}x", issue_token(&server, &["op:read"]));
        let body = serde_json::json!({ "token": tampered });
        let (status, response) = post(&server, "/v1/token/verify", &body.to_string(), None);
        assert_eq!(status, 403);
        assert!(response.contains("invalid_token"));
    }

    #[test]
    fn audit_endpoint_returns_metadata_only() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let token = issue_token(&server, &["op:read", "audit:read"]);
        // Trigger one audited verify.
        let body = serde_json::json!({ "token": token, "requiredScope": "op:read" });
        post(&server, "/v1/token/verify", &body.to_string(), None);
        // Trigger one denied verify.
        let bad = serde_json::json!({ "token": "smt1.not-a-valid-token" });
        post(&server, "/v1/token/verify", &bad.to_string(), None);

        let (status, response) = get(&server, "/v1/audit?limit=10", Some(&token));
        assert_eq!(status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert!(parsed["count"].as_u64().unwrap() >= 2);
        let serialized = parsed.to_string();
        assert!(
            !serialized.contains("not-a-valid-token"),
            "tokens must not be audited"
        );
        assert!(!serialized.contains("admin-token-value"));
    }

    #[test]
    fn txn_lifecycle_preview_confirm_and_exactly_once() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let token = issue_token(&server, &["txn:write"]);

        // Preview without expectedHash is a snapshot failure: no write.
        let bad_preview =
            serde_json::json!({ "kind": "edit_block", "targetId": "20260101000000-abcdefg" });
        let (status, response) = post(
            &server,
            "/v1/txn/preview",
            &bad_preview.to_string(),
            Some(&token),
        );
        assert_eq!(status, 409);
        assert!(response.contains("snapshot_failed"));

        // Valid preview.
        let preview = serde_json::json!({
            "kind": "edit_block",
            "targetId": "20260101000000-abcdefg",
            "expectedHash": "a".repeat(64)
        });
        let (status, response) = post(
            &server,
            "/v1/txn/preview",
            &preview.to_string(),
            Some(&token),
        );
        assert_eq!(status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(parsed["state"], "awaiting_confirmation");
        let txn_id = parsed["txn_id"].as_str().unwrap().to_string();

        // Confirm without user approval is rejected.
        let no_confirm = serde_json::json!({
            "txnId": txn_id,
            "confirmed": false,
            "currentHash": "a".repeat(64)
        });
        let (status, response) = post(
            &server,
            "/v1/txn/confirm",
            &no_confirm.to_string(),
            Some(&token),
        );
        assert_eq!(status, 409);
        assert!(response.contains("confirmation_required"));

        // Confirm with a drifted hash aborts (state_changed).
        let drifted = serde_json::json!({
            "txnId": txn_id,
            "confirmed": true,
            "currentHash": "b".repeat(64)
        });
        let (status, response) = post(
            &server,
            "/v1/txn/confirm",
            &drifted.to_string(),
            Some(&token),
        );
        assert_eq!(status, 409);
        assert!(response.contains("state_changed"));
        assert!(response.contains("\"state\":\"failed\""));

        // A new preview, then confirm with matching hash.
        let (_, response) = post(
            &server,
            "/v1/txn/preview",
            &preview.to_string(),
            Some(&token),
        );
        let parsed: serde_json::Value = serde_json::from_str(&response).unwrap();
        let txn_id = parsed["txn_id"].as_str().unwrap().to_string();
        let matching = serde_json::json!({
            "txnId": txn_id,
            "confirmed": true,
            "currentHash": "a".repeat(64)
        });
        let (status, response) = post(
            &server,
            "/v1/txn/confirm",
            &matching.to_string(),
            Some(&token),
        );
        assert_eq!(status, 200);
        assert!(response.contains("\"state\":\"confirmed\""));

        // Exactly-once: re-confirming the same transaction is rejected.
        let (status, response) = post(
            &server,
            "/v1/txn/confirm",
            &matching.to_string(),
            Some(&token),
        );
        assert_eq!(status, 409);
        assert!(response.contains("already_finalized"));
    }

    #[test]
    fn txn_endpoints_require_txn_write_scope() {
        let server = spawn_server("SIYUANMASTER_ADMIN_TOKEN", None);
        let token = issue_token(&server, &["op:read"]);
        let preview = serde_json::json!({
            "kind": "edit_block",
            "targetId": "20260101000000-abcdefg",
            "expectedHash": "a".repeat(64)
        });
        let (status, _) = post(
            &server,
            "/v1/txn/preview",
            &preview.to_string(),
            Some(&token),
        );
        assert_eq!(status, 403);
    }
}
