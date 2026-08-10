// Safe Write Transaction — unified secure write skeleton (TypeScript side).
//
// Internal name: SafeWriteTxn (catalog writeTransaction.name). The
// transition table mirrors `crates/core/src/txn.rs`; tests assert both
// agree with `catalog/capabilities.json -> writeTransaction`.
//
// Invariants (same as the Rust core):
// - snapshot_failure_stops: a failed snapshot is terminal; no write follows.
// - exactly_once: a finalized transaction rejects every further event.
// - no_auto_retry_on_uncertain: `unknown` is terminal.
// - state_or_hash_check_required: execute only from `confirmed`, after the
//   pre-execute re-read matches the snapshot.
// - readback_required: `committed` only via `readback_ok` from `executing`.

import { TXN_EVENTS, TXN_STATES } from "./generated/capabilities";

export type TxnState = (typeof TXN_STATES)[number];
export type TxnEvent = (typeof TXN_EVENTS)[number];

export type TxnFailureKind =
  | "snapshot_failed"
  | "state_changed"
  | "already_finalized"
  | "readback_mismatch"
  | "reference_protected";

export const TERMINAL_STATES: readonly TxnState[] = [
  "committed",
  "failed",
  "unknown",
];

export interface TxnRecord {
  id: string;
  kind: string;
  /** null = created (prepare pending). */
  state: TxnState | null;
  snapshotHash?: string;
  currentHash?: string;
  createdAt: number;
  updatedAt: number;
  failure?: TxnFailureKind;
}

export class TxnError extends Error {
  constructor(
    readonly code: "already_finalized" | "invalid_transition",
    readonly record: TxnRecord,
    readonly event: TxnEvent,
  ) {
    super(
      code === "already_finalized"
        ? `transaction '${record.id}' is already finalized in state ${record.state ?? "created"}`
        : `transaction '${record.id}' cannot accept event '${event}' from state ${record.state ?? "created"}`,
    );
  }
}

export function isTerminal(state: TxnState | null): boolean {
  return state !== null && TERMINAL_STATES.includes(state);
}

/**
 * Applies one event to a transaction record, enforcing the Safe Write
 * Transaction table. Returns the new state or throws [`TxnError`].
 */
export function transition(
  record: TxnRecord,
  event: TxnEvent,
): TxnState {
  const id = record.id;
  if (isTerminal(record.state)) {
    throw new TxnError("already_finalized", record, event);
  }
  const from = record.state;

  const apply = (next: TxnState | null, failure?: TxnFailureKind): TxnState => {
    record.state = next;
    record.updatedAt = Date.now();
    if (failure) {
      record.failure = failure;
    }
    return next as TxnState;
  };

  switch (event) {
    case "prepare":
      if (from === null) {
        return apply("previewed");
      }
      break;
    case "snapshot_failed":
      if (from === "previewed") {
        return apply("failed", "snapshot_failed");
      }
      break;
    case "snapshot_ok":
      if (from === "previewed") {
        return apply("awaiting_confirmation");
      }
      break;
    case "confirm":
      if (from === "awaiting_confirmation") {
        return apply("confirmed");
      }
      if (from === "confirmed") {
        throw new TxnError("already_finalized", record, event);
      }
      break;
    case "state_mismatch":
      if (from === "confirmed") {
        return apply("failed", "state_changed");
      }
      break;
    case "execute":
      if (from === "confirmed") {
        return apply("executing");
      }
      break;
    case "readback_ok":
      if (from === "executing") {
        return apply("committed");
      }
      break;
    case "readback_failed":
      if (from === "executing") {
        return apply("failed", "readback_mismatch");
      }
      break;
    case "uncertain":
      if (from === "executing") {
        return apply("unknown");
      }
      break;
  }
  throw new TxnError("invalid_transition", record, event);
}

export function newTxnRecord(
  id: string,
  kind: string,
  now = Date.now(),
): TxnRecord {
  return {
    id,
    kind,
    state: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** SHA-256 hex digest via Web Crypto. */
export async function computeContentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface DiffSummary {
  totalOldLines: number;
  totalNewLines: number;
  samePrefixLines: number;
  sameSuffixLines: number;
  removedLines: number;
  addedLines: number;
  hashOld: string;
  hashNew: string;
  identical: boolean;
}

/** Line-level diff summary (mirrors `core::diff`). */
export function diffSummary(
  oldText: string,
  newText: string,
  hashOld: string,
  hashNew: string,
): DiffSummary {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    totalOldLines: oldLines.length,
    totalNewLines: newLines.length,
    samePrefixLines: prefix,
    sameSuffixLines: suffix,
    removedLines: oldLines.length - prefix - suffix,
    addedLines: newLines.length - prefix - suffix,
    hashOld,
    hashNew,
    identical: oldText === newText,
  };
}

/** Pre-write snapshot produced by the caller's IO layer. */
export interface Snapshot {
  /** SHA-256 of the current content. */
  hash: string;
  /** Updated timestamp when known (for human display). */
  updated?: string;
}

/**
 * IO boundary injected by the plugin kernel. All SiYuan side effects live
 * behind these functions so the skeleton is fully unit-testable.
 */
export interface WriteIo {
  /** Captures the pre-write state. Throws to trigger snapshot failure. */
  snapshot(): Promise<Snapshot>;
  /** Re-reads the target immediately before execution. */
  verifyCurrent(): Promise<string>;
  /** The actual write. Must not be called when verification fails. */
  execute(): Promise<void>;
  /** Re-reads the target after execution for read-back verification. */
  readback(): Promise<string>;
}

export interface WriteTransactionOptions {
  kind: string;
  io: WriteIo;
  /** Explicit user approval (policy `confirm` or always-confirm tools). */
  confirmed: boolean;
  /** Policy decision: whether confirmation is required. */
  requireConfirmation: boolean;
  /** Exact post-write hash when byte-exact comparison is meaningful. */
  expectedReadbackHash?: string;
  /** Predicate used when exact comparison is impossible (SiYuan may
   * normalize markdown). Defaults to `false` -> unverifiable -> unknown. */
  verifyReadback?: (observed: string) => boolean;
  now?: number;
}

export interface WriteTransactionResult {
  state: TxnState;
  record: TxnRecord;
  /** Error code for failed/unknown outcomes. */
  error?: string;
  /** Human-readable notice for confirmation-required outcomes. */
  notice?: string;
}

/**
 * Runs one Safe Write Transaction end to end.
 *
 * Failure semantics:
 * - snapshot failure -> `failed(snapshot_failed)`, execute is never called.
 * - confirmation required and not provided -> `awaiting_confirmation`.
 * - pre-execute state drift -> `failed(state_changed)`, execute never called.
 * - read-back mismatch -> `failed(readback_mismatch)`.
 * - unverifiable read-back -> `unknown` (never auto-retried).
 */
export async function runWriteTransaction(
  options: WriteTransactionOptions,
): Promise<WriteTransactionResult> {
  const now = options.now ?? Date.now();
  const record = newTxnRecord(
    `ts-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    options.kind,
    now,
  );

  transition(record, "prepare");

  let snapshot: Snapshot;
  try {
    snapshot = await options.io.snapshot();
  } catch (error) {
    transition(record, "snapshot_failed");
    return {
      state: record.state as TxnState,
      record,
      error: "snapshot_failed",
      notice: `写前快照失败，已停止，未执行写入：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  record.snapshotHash = snapshot.hash;
  transition(record, "snapshot_ok");

  if (options.requireConfirmation && !options.confirmed) {
    return {
      state: record.state as TxnState,
      record,
      notice: "confirmation_required: 请先获得用户确认，再以 confirmed=true 重试",
    };
  }
  transition(record, "confirm");

  let currentHash: string;
  try {
    currentHash = await options.io.verifyCurrent();
  } catch {
    transition(record, "state_mismatch");
    return {
      state: record.state as TxnState,
      record,
      error: "state_changed",
      notice: "执行前状态读取失败，视为状态漂移，已中止",
    };
  }
  record.currentHash = currentHash;
  if (currentHash !== snapshot.hash) {
    transition(record, "state_mismatch");
    return {
      state: record.state as TxnState,
      record,
      error: "state_changed",
      notice: "目标在预览后发生变化（并发写入），已中止，请重新预览",
    };
  }

  transition(record, "execute");
  try {
    await options.io.execute();
  } catch (error) {
    transition(record, "uncertain");
    return {
      state: record.state as TxnState,
      record,
      error: "outcome_unknown",
      notice: `写入调用返回错误，结果不确定，未自动重试：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let observed: string;
  try {
    observed = await options.io.readback();
  } catch {
    transition(record, "uncertain");
    return {
      state: record.state as TxnState,
      record,
      error: "outcome_unknown",
      notice: "写入后回读失败，结果不确定，未自动重试，请人工核查",
    };
  }

  const verified =
    options.expectedReadbackHash !== undefined
      ? observed === options.expectedReadbackHash
      : options.verifyReadback
        ? options.verifyReadback(observed)
        : false;
  if (verified) {
    transition(record, "readback_ok");
    return { state: record.state as TxnState, record };
  }
  transition(record, "readback_failed");
  return {
    state: record.state as TxnState,
    record,
    error: "readback_mismatch",
    notice: "执行后回读验证不一致，写入结果与预期不符",
  };
}
