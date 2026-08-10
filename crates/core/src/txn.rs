//! SafeWriteTxn — the unified secure write-transaction state machine.
//!
//! Every write (document-level or block-level) must travel this state
//! machine. The semantics here are the single source of truth; the
//! TypeScript plugin implements the same protocol against real SiYuan
//! writes, and the gateway/CLI exercise this exact machine.
//!
//! Invariants enforced by construction:
//! - `snapshot_failure_stops`: a failed snapshot is terminal (`failed`).
//! - `exactly_once`: a finalized transaction rejects every further event;
//!   confirming an already-confirmed transaction is rejected.
//! - `no_auto_retry_on_uncertain`: `unknown` is terminal; the machine
//!   offers no retry path.
//! - `state_or_hash_check_required`: `execute` is only reachable from
//!   `confirmed`, and the driver must send `state_mismatch` (terminal)
//!   when the re-read state does not match the snapshot.
//! - `readback_required`: `committed` is only reachable from `executing`
//!   via `readback_ok`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

static TXN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Transaction states. The set must match
/// `catalog/capabilities.json -> writeTransaction.states` (asserted in
/// tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxnState {
    Previewed,
    AwaitingConfirmation,
    Confirmed,
    Executing,
    Verifying,
    Committed,
    Failed,
    Unknown,
}

impl TxnState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TxnState::Previewed => "previewed",
            TxnState::AwaitingConfirmation => "awaiting_confirmation",
            TxnState::Confirmed => "confirmed",
            TxnState::Executing => "executing",
            TxnState::Verifying => "verifying",
            TxnState::Committed => "committed",
            TxnState::Failed => "failed",
            TxnState::Unknown => "unknown",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TxnState::Committed | TxnState::Failed | TxnState::Unknown
        )
    }
}

/// Transaction events. The set must match
/// `catalog/capabilities.json -> writeTransaction.events` (asserted in
/// tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxnEvent {
    Prepare,
    SnapshotFailed,
    SnapshotOk,
    Confirm,
    StateMismatch,
    Execute,
    ReadbackOk,
    ReadbackFailed,
    Uncertain,
}

impl TxnEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            TxnEvent::Prepare => "prepare",
            TxnEvent::SnapshotFailed => "snapshot_failed",
            TxnEvent::SnapshotOk => "snapshot_ok",
            TxnEvent::Confirm => "confirm",
            TxnEvent::StateMismatch => "state_mismatch",
            TxnEvent::Execute => "execute",
            TxnEvent::ReadbackOk => "readback_ok",
            TxnEvent::ReadbackFailed => "readback_failed",
            TxnEvent::Uncertain => "uncertain",
        }
    }
}

/// Why a transaction failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxnFailureKind {
    SnapshotFailed,
    StateChanged,
    AlreadyFinalized,
    ReadbackMismatch,
    ReferenceProtected,
}

/// A transaction record. `state == None` means "created, prepare pending".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxnRecord {
    pub id: String,
    pub kind: String,
    pub state: Option<TxnState>,
    pub snapshot_hash: Option<String>,
    pub current_hash: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub failure: Option<TxnFailureKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnError {
    /// The transaction is finalized (or already confirmed); no further
    /// events are accepted. Violates `exactly_once`.
    AlreadyFinalized { id: String, state: TxnState },
    /// The event is not valid for the current state.
    InvalidTransition {
        id: String,
        from: Option<TxnState>,
        event: TxnEvent,
    },
}

impl std::fmt::Display for TxnError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TxnError::AlreadyFinalized { id, state } => {
                write!(
                    formatter,
                    "transaction '{id}' is already finalized in state {}",
                    state.as_str()
                )
            }
            TxnError::InvalidTransition { id, from, event } => {
                let from = from.map(|state| state.as_str()).unwrap_or("created");
                write!(
                    formatter,
                    "transaction '{id}' cannot accept event '{}' from state '{from}'",
                    event.as_str()
                )
            }
        }
    }
}

impl std::error::Error for TxnError {}

impl TxnRecord {
    /// Creates a new transaction in the "created" (pre-prepare) state.
    pub fn new(id: impl Into<String>, kind: impl Into<String>, now: u64) -> TxnRecord {
        TxnRecord {
            id: id.into(),
            kind: kind.into(),
            state: None,
            snapshot_hash: None,
            current_hash: None,
            created_at: now,
            updated_at: now,
            failure: None,
        }
    }

    /// Applies an event, enforcing the transition table and invariants.
    pub fn transition(&mut self, event: TxnEvent) -> Result<(), TxnError> {
        let id = self.id.clone();
        let from = self.state;

        if let Some(state) = from {
            if state.is_terminal() {
                return Err(TxnError::AlreadyFinalized { id, state });
            }
        }

        let next = match (from, event) {
            (None, TxnEvent::Prepare) => Some(TxnState::Previewed),
            (Some(TxnState::Previewed), TxnEvent::SnapshotFailed) => {
                self.failure = Some(TxnFailureKind::SnapshotFailed);
                Some(TxnState::Failed)
            }
            (Some(TxnState::Previewed), TxnEvent::SnapshotOk) => {
                Some(TxnState::AwaitingConfirmation)
            }
            (Some(TxnState::AwaitingConfirmation), TxnEvent::Confirm) => Some(TxnState::Confirmed),
            // A second confirm on an already-confirmed transaction is a
            // duplicate of a finalized decision (exactly-once).
            (Some(TxnState::Confirmed), TxnEvent::Confirm) => {
                return Err(TxnError::AlreadyFinalized {
                    id,
                    state: TxnState::Confirmed,
                });
            }
            (Some(TxnState::Confirmed), TxnEvent::StateMismatch) => {
                self.failure = Some(TxnFailureKind::StateChanged);
                Some(TxnState::Failed)
            }
            (Some(TxnState::Confirmed), TxnEvent::Execute) => Some(TxnState::Executing),
            (Some(TxnState::Executing), TxnEvent::ReadbackOk) => Some(TxnState::Committed),
            (Some(TxnState::Executing), TxnEvent::ReadbackFailed) => {
                self.failure = Some(TxnFailureKind::ReadbackMismatch);
                Some(TxnState::Failed)
            }
            (Some(TxnState::Executing), TxnEvent::Uncertain) => Some(TxnState::Unknown),
            _ => {
                return Err(TxnError::InvalidTransition { id, from, event });
            }
        };

        self.state = next;
        self.updated_at = now_unix_seconds_fallback(self.updated_at);
        Ok(())
    }

    /// Records the snapshot hash (driver calls this after capturing the
    /// pre-write state and before `SnapshotOk`).
    pub fn set_snapshot_hash(&mut self, hash: String) {
        self.snapshot_hash = Some(hash);
    }

    /// Records the current hash observed at execution time.
    pub fn set_current_hash(&mut self, hash: String) {
        self.current_hash = Some(hash);
    }

    /// Convenience: run a full driver sequence for a transaction that does
    /// not require confirmation. Returns the final state.
    pub fn run_auto(
        &mut self,
        snapshot_hash: String,
        current_hash: String,
        readback_hash: String,
    ) -> Result<TxnState, TxnError> {
        self.transition(TxnEvent::Prepare)?;
        self.set_snapshot_hash(snapshot_hash);
        self.transition(TxnEvent::SnapshotOk)?;
        self.transition(TxnEvent::Confirm)?;
        self.set_current_hash(current_hash.clone());
        if self.snapshot_hash.as_deref() != Some(current_hash.as_str()) {
            self.transition(TxnEvent::StateMismatch)?;
            return Ok(self.state.unwrap());
        }
        self.transition(TxnEvent::Execute)?;
        if self.snapshot_hash.as_deref() == Some(readback_hash.as_str()) {
            self.transition(TxnEvent::ReadbackOk)?;
        } else {
            self.transition(TxnEvent::ReadbackFailed)?;
        }
        Ok(self.state.unwrap())
    }
}

/// Fallback clock for tests that construct records without a real clock.
fn now_unix_seconds_fallback(fallback: u64) -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(fallback)
}

/// Generates a unique transaction id (timestamp + process-local counter).
pub fn generate_txn_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let counter = TXN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("txn-{now:x}-{counter}")
}

/// In-memory transaction store; can be persisted to a JSON file for the
/// CLI's `txn` subcommands.
#[derive(Debug, Default, Clone)]
pub struct TxnStore {
    txns: HashMap<String, TxnRecord>,
}

impl TxnStore {
    pub fn new() -> TxnStore {
        TxnStore::default()
    }

    pub fn insert(&mut self, record: TxnRecord) {
        self.txns.insert(record.id.clone(), record);
    }

    pub fn get(&self, id: &str) -> Option<&TxnRecord> {
        self.txns.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut TxnRecord> {
        self.txns.get_mut(id)
    }

    pub fn all(&self) -> Vec<&TxnRecord> {
        let mut records: Vec<&TxnRecord> = self.txns.values().collect();
        records.sort_by_key(|record| record.created_at);
        records
    }

    pub fn len(&self) -> usize {
        self.txns.len()
    }

    pub fn is_empty(&self) -> bool {
        self.txns.is_empty()
    }

    pub fn save_json(&self, path: &std::path::Path) -> Result<(), String> {
        let payload =
            serde_json::to_string_pretty(&self.txns).map_err(|error| error.to_string())?;
        std::fs::write(path, payload).map_err(|error| error.to_string())
    }

    pub fn load_json(path: &std::path::Path) -> Result<TxnStore, String> {
        if !path.exists() {
            return Ok(TxnStore::new());
        }
        let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        let txns: HashMap<String, TxnRecord> =
            serde_json::from_str(&content).map_err(|error| error.to_string())?;
        Ok(TxnStore { txns })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> TxnRecord {
        TxnRecord::new("txn-1", "edit_block", 1_000)
    }

    #[test]
    fn happy_path_commits() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        assert_eq!(txn.state, Some(TxnState::AwaitingConfirmation));
        txn.transition(TxnEvent::Confirm).unwrap();
        assert_eq!(txn.state, Some(TxnState::Confirmed));
        txn.set_current_hash("snap".to_string());
        txn.transition(TxnEvent::Execute).unwrap();
        assert_eq!(txn.state, Some(TxnState::Executing));
        txn.transition(TxnEvent::ReadbackOk).unwrap();
        assert_eq!(txn.state, Some(TxnState::Committed));
        assert!(txn.state.unwrap().is_terminal());
    }

    #[test]
    fn snapshot_failure_is_terminal_and_blocks_everything() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.transition(TxnEvent::SnapshotFailed).unwrap();
        assert_eq!(txn.state, Some(TxnState::Failed));
        assert_eq!(txn.failure, Some(TxnFailureKind::SnapshotFailed));
        // No event may follow a failed snapshot.
        for event in [
            TxnEvent::SnapshotOk,
            TxnEvent::Confirm,
            TxnEvent::Execute,
            TxnEvent::ReadbackOk,
        ] {
            let error = txn.transition(event).unwrap_err();
            assert!(
                matches!(error, TxnError::AlreadyFinalized { .. }),
                "event {:?} must be rejected after snapshot failure",
                event
            );
        }
    }

    #[test]
    fn double_confirm_is_rejected_exactly_once() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        txn.transition(TxnEvent::Confirm).unwrap();
        let error = txn.transition(TxnEvent::Confirm).unwrap_err();
        assert!(matches!(error, TxnError::AlreadyFinalized { .. }));
    }

    #[test]
    fn state_mismatch_aborts_before_execute() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        txn.transition(TxnEvent::Confirm).unwrap();
        // Re-read shows a different hash (concurrent change).
        txn.set_current_hash("changed".to_string());
        txn.transition(TxnEvent::StateMismatch).unwrap();
        assert_eq!(txn.state, Some(TxnState::Failed));
        assert_eq!(txn.failure, Some(TxnFailureKind::StateChanged));
        // Execute after abort is rejected.
        let error = txn.transition(TxnEvent::Execute).unwrap_err();
        assert!(matches!(error, TxnError::AlreadyFinalized { .. }));
    }

    #[test]
    fn readback_failure_marks_failed() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        txn.transition(TxnEvent::Confirm).unwrap();
        txn.set_current_hash("snap".to_string());
        txn.transition(TxnEvent::Execute).unwrap();
        txn.transition(TxnEvent::ReadbackFailed).unwrap();
        assert_eq!(txn.state, Some(TxnState::Failed));
        assert_eq!(txn.failure, Some(TxnFailureKind::ReadbackMismatch));
    }

    #[test]
    fn uncertain_outcome_is_terminal_without_retry_path() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        txn.transition(TxnEvent::Confirm).unwrap();
        txn.set_current_hash("snap".to_string());
        txn.transition(TxnEvent::Execute).unwrap();
        txn.transition(TxnEvent::Uncertain).unwrap();
        assert_eq!(txn.state, Some(TxnState::Unknown));
        // The machine offers no retry: every subsequent event is rejected.
        let error = txn.transition(TxnEvent::Execute).unwrap_err();
        assert!(matches!(error, TxnError::AlreadyFinalized { .. }));
    }

    #[test]
    fn execute_without_confirm_is_rejected() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        let error = txn.transition(TxnEvent::Execute).unwrap_err();
        assert!(matches!(error, TxnError::InvalidTransition { .. }));
    }

    #[test]
    fn execute_on_finalized_transaction_is_rejected() {
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.set_snapshot_hash("snap".to_string());
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        txn.transition(TxnEvent::Confirm).unwrap();
        txn.set_current_hash("snap".to_string());
        txn.transition(TxnEvent::Execute).unwrap();
        txn.transition(TxnEvent::ReadbackOk).unwrap();
        let error = txn.transition(TxnEvent::Execute).unwrap_err();
        assert!(matches!(error, TxnError::AlreadyFinalized { .. }));
    }

    #[test]
    fn auto_driver_sequence() {
        let mut txn = record();
        let state = txn.run_auto("snap".to_string(), "snap".to_string(), "snap".to_string());
        assert_eq!(state.unwrap(), TxnState::Committed);
    }

    #[test]
    fn auto_driver_aborts_on_state_drift() {
        let mut txn = record();
        let state = txn.run_auto("snap".to_string(), "other".to_string(), "snap".to_string());
        assert_eq!(state.unwrap(), TxnState::Failed);
        assert_eq!(txn.failure, Some(TxnFailureKind::StateChanged));
    }

    #[test]
    fn store_persists_and_loads() {
        let mut store = TxnStore::new();
        let mut txn = record();
        txn.transition(TxnEvent::Prepare).unwrap();
        txn.transition(TxnEvent::SnapshotOk).unwrap();
        store.insert(txn);
        let path = std::env::temp_dir().join(format!("smt-txn-test-{}.json", std::process::id()));
        store.save_json(&path).unwrap();
        let loaded = TxnStore::load_json(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        let restored = loaded.get("txn-1").unwrap();
        assert_eq!(restored.state, Some(TxnState::AwaitingConfirmation));
        let _ = std::fs::remove_file(&path);
    }
}
