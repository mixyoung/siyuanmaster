// edit_block core: expected-state + reference checks, then either atomic
// validateOnly (never writes) or SafeWriteTxn execute-once.

import {
  classifyReferenceRisk,
  parseWriteTarget,
  referenceAllows,
  type ReferenceProtectionMode,
  type ReferenceRisk,
  type ReferencingBlock,
} from "./document-access";
import type { OperationDecision } from "./types";
import {
  computeContentHash,
  runWriteTransaction,
  type WriteTransactionResult,
} from "./write-transaction";

export type EditBlockErrorCode =
  | "operation_denied"
  | "confirmation_required"
  | "state_changed"
  | "invalid_request";

export class EditBlockError extends Error {
  constructor(
    readonly code: EditBlockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditBlockError";
  }
}

export interface EditBlockPolicySlice {
  operations: { update: OperationDecision };
  safety: {
    blockEdit: {
      requireExpectedState: boolean;
      defaultConfirm: boolean;
    };
    referenceProtection: ReferenceProtectionMode;
  };
}

export interface EditBlockIo {
  getBlockKramdown: (blockId: string) => Promise<string>;
  listReferencingBlocks: (blockId: string) => Promise<ReferencingBlock[]>;
  updateBlockMarkdown: (blockId: string, markdown: string) => Promise<void>;
  /** Injected for tests; defaults to production SafeWriteTxn runner. */
  runWriteTransaction?: typeof runWriteTransaction;
  /** Injected for tests; defaults to production pure SHA-256. */
  computeContentHash?: (content: string) => Promise<string>;
}

export interface EditBlockContext {
  /** Exact requested block id (must equal blockId). */
  requestedId: string;
  documentId: string;
  notebookId: string;
  /** Optional kernel `updated` stamp used only in write snapshots. */
  updated?: string;
}

export interface EditBlockInput {
  blockId: string;
  markdown: string;
  expectedContent?: string;
  expectedHash?: string;
  confirmed: boolean;
  validateOnly: boolean;
}

export interface EditBlockReferenceView {
  blockId: string;
  documentId: string;
  notebookId: string;
  contentSnippet: string;
}

export interface EditBlockValidatedResult {
  mode: "validated";
  validated: true;
  writeExecuted: false;
  blockId: string;
  documentId: string;
  notebookId: string;
  referenceRisk: ReferenceRisk;
  referencingCount: number;
  referencing: EditBlockReferenceView[];
}

export interface EditBlockCommittedResult {
  blockId: string;
  documentId: string;
  notebookId: string;
  updatedCharacters: number;
  referenceRisk: ReferenceRisk;
  referencingCount: number;
  referencing: EditBlockReferenceView[];
  txnId: string;
  txnState: WriteTransactionResult["state"];
  verified: true;
}

export type EditBlockResult =
  | EditBlockValidatedResult
  | EditBlockCommittedResult;

function mapReferencing(
  referencing: readonly ReferencingBlock[],
): EditBlockReferenceView[] {
  return referencing.map((item) => ({
    blockId: item.blockId,
    documentId: item.documentId,
    notebookId: item.notebookId,
    contentSnippet: item.contentSnippet,
  }));
}

function isIalWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function isIalKeyStart(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    ch === "_"
  );
}

function isIalKeyContinue(ch: string): boolean {
  return (
    isIalKeyStart(ch) ||
    (ch >= "0" && ch <= "9") ||
    ch === "-" ||
    ch === "_"
  );
}

/**
 * Strict cursor tokenizer for one SiYuan root IAL: `{: key="value" ...}`.
 *
 * Fail-closed:
 * - Entire string must be exactly one well-formed IAL (no leftover text).
 * - Double-quoted values only; only `\"` and `\\` escapes are accepted.
 * - At least one whitespace separator is required between attributes.
 * - Any duplicate key (including repeated `id`, any order/value) is rejected.
 * - Uses Map (no prototype-key hazards). Arbitrary unique legitimate keys OK.
 *
 * @returns attribute Map when valid; otherwise null.
 */
function parseRootIalAttributes(ial: string): Map<string, string> | null {
  if (typeof ial !== "string" || ial.length < 4) {
    return null;
  }
  if (ial[0] !== "{" || ial[1] !== ":") {
    return null;
  }
  if (ial[ial.length - 1] !== "}") {
    return null;
  }

  const end = ial.length - 1; // exclusive of closing `}`
  let i = 2;
  const attrs = new Map<string, string>();

  // Optional whitespace after `{:` before the first attribute.
  while (i < end && isIalWhitespace(ial[i]!)) {
    i += 1;
  }
  if (i >= end) {
    return null;
  }

  while (i < end) {
    // key
    if (!isIalKeyStart(ial[i]!)) {
      return null;
    }
    const keyStart = i;
    i += 1;
    while (i < end && isIalKeyContinue(ial[i]!)) {
      i += 1;
    }
    const key = ial.slice(keyStart, i);
    if (attrs.has(key)) {
      return null; // duplicate key — fail closed (incl. repeated id)
    }

    if (i >= end || ial[i] !== "=") {
      return null;
    }
    i += 1;
    if (i >= end || ial[i] !== '"') {
      return null;
    }
    i += 1; // open quote

    // value with \" and \\ only
    let value = "";
    let closed = false;
    while (i < end) {
      const ch = ial[i]!;
      if (ch === '"') {
        i += 1;
        closed = true;
        break;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= end) {
          return null;
        }
        const esc = ial[i]!;
        if (esc === '"' || esc === "\\") {
          value += esc;
          i += 1;
          continue;
        }
        return null; // malformed escape
      }
      // IAL is a single line; CR/LF inside values or attrs is invalid here.
      if (ch === "\n" || ch === "\r") {
        return null;
      }
      value += ch;
      i += 1;
    }
    if (!closed) {
      return null;
    }
    attrs.set(key, value);

    // After an attribute: optional trailing whitespace, or required whitespace
    // before the next attribute. Missing separator (id="a"foo="b") fails.
    if (i >= end) {
      break;
    }
    if (isIalWhitespace(ial[i]!)) {
      while (i < end && isIalWhitespace(ial[i]!)) {
        i += 1;
      }
      // After whitespace: either next attribute or closing `}`.
      continue;
    }
    // Non-whitespace before closing `}` means jammed next key / junk.
    return null;
  }

  if (attrs.size === 0) {
    return null;
  }
  // Cursor must land exactly on the final `}` with nothing unparsed.
  if (i !== end) {
    return null;
  }
  return attrs;
}

/**
 * Consume exactly one LF (`\n`) or CRLF (`\r\n`) at the start of `text`.
 * @returns remainder after the separator, or null if missing/malformed.
 */
function consumeOneLineEndingPrefix(text: string): string | null {
  if (text.startsWith("\r\n")) {
    return text.slice(2);
  }
  if (text.startsWith("\n")) {
    return text.slice(1);
  }
  return null;
}

/**
 * Peel at most one LF or CRLF terminator from the end of `text`.
 * Lone CR is left in place (caller will reject non-IAL residue).
 */
function peelOptionalLineEndingSuffix(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n")) {
    return text.slice(0, -1);
  }
  return text;
}

/**
 * Target-ID-aware normalizer used ONLY for edit_block successful-write
 * readback verification.
 *
 * SiYuan `getBlockKramdown` returns the replacement body plus exactly one
 * trailing root block IAL such as `{: id="TARGET_ID" ...}`. Do not compare
 * raw `input.markdown` to raw kramdown by hashing either side.
 *
 * Accepts (fail-closed, no retry):
 * - Exact submitted markdown byte-for-byte as a prefix (never stripped).
 * - Body→root-IAL boundary is either:
 *   (A) rest after the prefix begins with exactly one LF or CRLF separator; or
 *   (B) expectedMarkdown itself ends with LF or CRLF and rest begins immediately
 *       with the single root IAL (the submitted trailing line ending is the
 *       body-to-IAL separator — do not require or synthesize another).
 * - Then exactly one well-formed root IAL whose `id` equals the target block ID.
 * - Optionally exactly one LF or CRLF after the IAL.
 * - Arbitrary additional unique legitimate attributes when syntax is valid.
 *
 * Rejects: wrong/missing id, duplicate keys, missing attribute whitespace,
 * malformed escapes, same-line second IAL, multi-line IAL, extra/unknown text,
 * immediate IAL when expectedMarkdown does not end with a line ending, or body
 * that is not an exact prefix. No substring marker checks.
 *
 * @returns the body (=== expectedMarkdown) when valid; otherwise null
 */
export function normalizeEditBlockReadback(
  observedKramdown: string,
  expectedMarkdown: string,
  targetBlockId: string,
): string | null {
  if (
    typeof observedKramdown !== "string" ||
    typeof expectedMarkdown !== "string" ||
    typeof targetBlockId !== "string" ||
    targetBlockId.length === 0
  ) {
    return null;
  }
  // Preserve submitted markdown byte-for-byte (including trailing LF/CRLF/blanks).
  if (!observedKramdown.startsWith(expectedMarkdown)) {
    return null;
  }
  let rest = observedKramdown.slice(expectedMarkdown.length);

  // Body→IAL boundary after the exact prefix:
  // (A) rest begins with exactly one LF or CRLF separator; or
  // (B) expectedMarkdown ends with LF/CRLF and rest begins immediately with IAL
  //     (trailing line ending of the body is the separator).
  const afterSeparator = consumeOneLineEndingPrefix(rest);
  if (afterSeparator !== null) {
    rest = afterSeparator;
  } else {
    const expectedEndsWithLineEnding =
      expectedMarkdown.endsWith("\r\n") || expectedMarkdown.endsWith("\n");
    if (!expectedEndsWithLineEnding) {
      // No separator and body has no trailing line ending → reject.
      return null;
    }
    // Case B: leave rest as-is (must be the single root IAL, possibly with
    // optional terminator peeled below). Do not consume or synthesize another.
  }

  // Optional: exactly one LF or CRLF terminator after the IAL.
  rest = peelOptionalLineEndingSuffix(rest);

  // Remainder must be exactly one single-line root IAL (no further newlines).
  if (rest.length === 0 || rest.includes("\n") || rest.includes("\r")) {
    return null;
  }

  const attrs = parseRootIalAttributes(rest);
  if (attrs === null) {
    return null;
  }
  if (attrs.get("id") !== targetBlockId) {
    return null;
  }
  return expectedMarkdown;
}

/**
 * Full edit_block server path after access-boundary resolution.
 *
 * Always runs: deny check surface, exact block id, getBlockKramdown expected
 * state, reference query + referenceProtection.
 *
 * When validateOnly=true: returns mode=validated and never calls
 * runWriteTransaction / updateBlockMarkdown, for any confirmed/policy combo.
 *
 * When validateOnly=false: existing SafeWriteTxn behavior (confirm gate,
 * snapshot, recheck, execute once, readback with target-ID-aware normalizer).
 */
export async function performEditBlock(
  input: EditBlockInput,
  context: EditBlockContext,
  policy: EditBlockPolicySlice,
  io: EditBlockIo,
): Promise<EditBlockResult> {
  // Defense in depth: kernel must deny earlier, but core still hard-stops.
  if (policy.operations.update === "deny") {
    throw new EditBlockError(
      "operation_denied",
      "Operation 'update' is denied by the active policy",
    );
  }

  let writeTarget;
  try {
    writeTarget = parseWriteTarget(input.blockId, input.expectedHash);
  } catch (error) {
    throw new EditBlockError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Exact block identity: resolved access context must match the requested id.
  if (context.requestedId !== writeTarget.id) {
    throw new EditBlockError(
      "invalid_request",
      "blockId must identify an exact existing block",
    );
  }

  const hashFn = io.computeContentHash ?? computeContentHash;
  const currentKramdown = await io.getBlockKramdown(writeTarget.id);
  // Snapshot / expectedHash path: hash RAW getBlockKramdown so expectedHash
  // stays compatible with read_note_segments includeStateHash.
  const currentHash = await hashFn(currentKramdown);

  // requireExpectedState only gates "must supply expected state".
  // Once the caller provides expectedContent or expectedHash, always compare
  // strictly — policy false must not skip an explicit state check.
  const expectedContent =
    typeof input.expectedContent === "string"
      ? input.expectedContent
      : undefined;
  const hasExpectedState =
    expectedContent !== undefined || Boolean(writeTarget.expectedHash);

  if (policy.safety.blockEdit.requireExpectedState && !hasExpectedState) {
    throw new EditBlockError(
      "invalid_request",
      "edit_block requires expectedContent or expectedHash when requireExpectedState is true",
    );
  }
  if (
    expectedContent !== undefined &&
    expectedContent !== currentKramdown
  ) {
    throw new EditBlockError(
      "state_changed",
      "expectedContent does not match the current block content",
    );
  }
  if (
    writeTarget.expectedHash &&
    writeTarget.expectedHash !== currentHash
  ) {
    throw new EditBlockError(
      "state_changed",
      "expectedHash does not match the current block content hash",
    );
  }

  const referencing = await io.listReferencingBlocks(writeTarget.id);
  const risk = classifyReferenceRisk(referencing, context.documentId);
  if (!referenceAllows(referencing, policy.safety.referenceProtection)) {
    throw new EditBlockError(
      "operation_denied",
      `Block is referenced by ${referencing.length} block(s); referenceProtection=deny blocks the edit`,
    );
  }

  const referencingView = mapReferencing(referencing);

  // Atomic validateOnly: after full preflight, never write — even when
  // confirmed=true and policy would allow execute without confirmation.
  if (input.validateOnly) {
    return {
      mode: "validated",
      validated: true,
      writeExecuted: false,
      blockId: writeTarget.id,
      documentId: context.documentId,
      notebookId: context.notebookId,
      referenceRisk: risk,
      referencingCount: referencing.length,
      referencing: referencingView,
    };
  }

  const requireConfirmation =
    policy.operations.update === "confirm" ||
    policy.safety.blockEdit.defaultConfirm ||
    (policy.safety.referenceProtection === "warn" && referencing.length > 0);

  const runTxn = io.runWriteTransaction ?? runWriteTransaction;
  const txn = await runTxn({
    kind: "edit_block",
    confirmed: input.confirmed,
    requireConfirmation,
    // Do not hash raw input.markdown against raw getBlockKramdown.
    // Readback returns raw kramdown; verify via target-ID-aware normalizer.
    verifyReadback: (observed) =>
      normalizeEditBlockReadback(
        observed,
        input.markdown,
        writeTarget.id,
      ) !== null,
    io: {
      snapshot: async () => {
        const kramdown = await io.getBlockKramdown(writeTarget.id);
        return {
          // Raw getBlockKramdown hash (compatible with includeStateHash).
          hash: await hashFn(kramdown),
          updated: context.updated,
        };
      },
      verifyCurrent: async () => {
        const kramdown = await io.getBlockKramdown(writeTarget.id);
        return hashFn(kramdown);
      },
      execute: async () => {
        await io.updateBlockMarkdown(writeTarget.id, input.markdown);
      },
      readback: async () => {
        // Raw kramdown for the normalizer — not a hash of either side.
        return io.getBlockKramdown(writeTarget.id);
      },
    },
  });

  if (txn.state === "awaiting_confirmation") {
    throw new EditBlockError(
      "confirmation_required",
      txn.notice ??
        `edit_block requires confirmed=true (referenceRisk=${risk}, refs=${referencing.length})`,
    );
  }
  if (txn.state !== "committed") {
    throw new EditBlockError(
      txn.error === "state_changed" ? "state_changed" : "invalid_request",
      txn.notice ?? `Safe Write Transaction ended in state ${txn.state}`,
    );
  }

  return {
    blockId: writeTarget.id,
    documentId: context.documentId,
    notebookId: context.notebookId,
    updatedCharacters: input.markdown.length,
    referenceRisk: risk,
    referencingCount: referencing.length,
    referencing: referencingView,
    txnId: txn.record.id,
    txnState: txn.state,
    verified: true,
  };
}
