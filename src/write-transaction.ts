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

// ---------------------------------------------------------------------------
// Pure TypeScript UTF-8 + SHA-256
//
// SiYuan's kernel JS runtime does not provide TextEncoder and may lack Web
// Crypto. Hashing must work without TextEncoder, Buffer, Node crypto, Web
// Crypto, DOM APIs, or external packages.
// ---------------------------------------------------------------------------

/**
 * Encode a JS string as UTF-8 bytes, matching standard TextEncoder rules:
 * valid code points use their UTF-8 form; unpaired UTF-16 surrogates become
 * U+FFFD (0xEF 0xBF 0xBD).
 */
function encodeUtf8(input: string): Uint8Array {
  const length = input.length;
  let byteLength = 0;
  for (let i = 0; i < length; i += 1) {
    const unit = input.charCodeAt(i);
    if (unit < 0x80) {
      byteLength += 1;
    } else if (unit < 0x800) {
      byteLength += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < length ? input.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteLength += 4;
        i += 1;
      } else {
        // Unpaired high surrogate → U+FFFD (3 UTF-8 bytes).
        byteLength += 3;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // Unpaired low surrogate → U+FFFD.
      byteLength += 3;
    } else {
      byteLength += 3;
    }
  }

  const out = new Uint8Array(byteLength);
  let offset = 0;
  for (let i = 0; i < length; i += 1) {
    const unit = input.charCodeAt(i);
    if (unit < 0x80) {
      out[offset] = unit;
      offset += 1;
    } else if (unit < 0x800) {
      out[offset] = 0xc0 | (unit >> 6);
      out[offset + 1] = 0x80 | (unit & 0x3f);
      offset += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < length ? input.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint =
          0x10000 + (((unit - 0xd800) << 10) | (next - 0xdc00));
        out[offset] = 0xf0 | (codePoint >> 18);
        out[offset + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
        out[offset + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
        out[offset + 3] = 0x80 | (codePoint & 0x3f);
        offset += 4;
        i += 1;
      } else {
        out[offset] = 0xef;
        out[offset + 1] = 0xbf;
        out[offset + 2] = 0xbd;
        offset += 3;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out[offset] = 0xef;
      out[offset + 1] = 0xbf;
      out[offset + 2] = 0xbd;
      offset += 3;
    } else {
      out[offset] = 0xe0 | (unit >> 12);
      out[offset + 1] = 0x80 | ((unit >> 6) & 0x3f);
      out[offset + 2] = 0x80 | (unit & 0x3f);
      offset += 3;
    }
  }
  return out;
}

/** SHA-256 round constants (FIPS 180-4). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Pure TypeScript SHA-256 over raw bytes. Allocates one padded block buffer
 * plus a 64-word schedule reused across chunks.
 */
function sha256Bytes(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  // Total length: message + 0x80 + zero padding + 8-byte length, multiple of 64.
  const totalLength = (((message.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(totalLength);
  padded.set(message);
  padded[message.length] = 0x80;
  // Big-endian 64-bit bit-length at the end (JS strings stay well below 2^53 bits).
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(totalLength - 8, highBits, false);
  view.setUint32(totalLength - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      schedule[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = schedule[i - 15]!;
      const w2 = schedule[i - 2]!;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      schedule[i] =
        (schedule[i - 16]! + s0 + schedule[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + schedule[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, h0, false);
  digestView.setUint32(4, h1, false);
  digestView.setUint32(8, h2, false);
  digestView.setUint32(12, h3, false);
  digestView.setUint32(16, h4, false);
  digestView.setUint32(20, h5, false);
  digestView.setUint32(24, h6, false);
  digestView.setUint32(28, h7, false);
  return digest;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * SHA-256 hex digest of content.
 *
 * Pure TypeScript implementation for SiYuan kernel JS (no TextEncoder /
 * Web Crypto / Buffer / Node crypto). Kept `async` so existing callers
 * need no change.
 */
export async function computeContentHash(content: string): Promise<string> {
  return bytesToHex(sha256Bytes(encodeUtf8(content)));
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
