// Explicit destructive MCP write smoke against SiYuan's loopback Streamable HTTP endpoint.
//
// Protocol: MCP 2025-03-26
//   initialize → (Mcp-Session-Id) → notifications/initialized → tools/list + catalog
//   → get_policy → list_accessible_notebooks → preflight
//   → create_note → visibility read_note (bounded poll; capture hPath)
//   → resolve_document → read_note_segments (over-limit clamp + includeStateHash)
//   → edit_block validateOnly=true (atomic server validation; never writes)
//   → edit_block validateOnly=false confirmed=true exactly once
//   → post-edit read_note (prove edit marker BEFORE update)
//   → update_note exactly once → final read_note (prove update marker/body + identity)
//   → delete_note cleanup
//
// Safety:
// - Requires BOTH --notebook-id and --confirm-destructive-smoke
// - notebookId / create documentId / blockId must match SiYuan id form /^\d{14}-[a-z0-9]{7}$/
// - Loopback hosts only; token only from SIYUAN_API_TOKEN (never printed)
// - Plugin tools only (plugin__siyuanmaster__*); no native API / bypass / policy mutation
// - get_policy: MCP result.structuredContent is the policy object directly
//   (kernel registers a direct-return handler, not runTool envelope)
// - list_accessible_notebooks + lifecycle write/read tools: require envelope
//   structuredContent { ok: true, result: <object> } (runTool path)
// - After create: bounded READ-ONLY visibility wait via plugin read_note only
//   (default ~5s: 20 attempts × 250ms). {ok:false} = not-yet-visible until bound;
//   malformed MCP/structuredContent = hard failure. Never retry writes
//   (create/update/edit_block/delete).
// - Lifecycle order avoids editing a just-updated new block: create → visibility
//   (hPath) → resolve → segments → validateOnly → actual edit once → post-edit
//   read (edit marker) → update once → final read (update body/identity) → delete.
// - edit_block: segments SQL text is NOT used as expectedContent. Marker blocks
//   must carry unique truncated=false + 64-char lowercase stateHash from
//   includeStateHash=true (getBlockKramdown-backed). validateOnly proves
//   expectedHash/refs without write; actual write uses the same expectedHash
//   once under --confirm-destructive-smoke. No confirmation_required probe
//   (TOCTOU-unsafe; removed).
// - Preflight: notebook accessible; create/update/read/delete not deny
//   (operations.update must not be deny so edit path can run).
// - tagging always exact { decision: "skip", tags: [] } on create/update
// - Known-ID post-create failure: exactly one finally cleanup via plugin delete_note
// - Unknown create outcome (timeout / malformed envelope / ok:false / missing or invalid
//   documentId): no cleanup; error appends artifactPossiblyCreated=true + manual
//   inspection in the selected disposable notebook (never notebookId/title/body/token)
// - Success logs never include token/session/raw responses/policy/notebook names or
//   IDs/title/body/marker/hPath/txnId/hash/reference snippets. Cleanup failure may show
//   validated documentId only.
//
// Does not start/stop SiYuan; does not touch auth config.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCatalogMatch,
  assertJsonRpcSuccess,
  assertLoopbackUrl,
  assertNoJsonRpcErrors,
  countToolNamespaces,
  extractToolNames,
  loadCatalog,
  mcpPost,
  pickJsonRpcResponse,
  redactSecrets,
  validateAgainstCatalog,
} from "./mcp-smoke.mjs";

const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_MCP_URL = "http://127.0.0.1:6806/mcp";
const DEFAULT_TIMEOUT_MS = 10_000;
const CLIENT_INFO = {
  name: "siyuanmaster-mcp-write-smoke",
  version: "0.5.1",
};

/** SiYuan block/doc/notebook id: 14-digit timestamp + 7 lowercase alnum. */
export const SIYUAN_ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;

/** Fixed recovery signal when create was dispatched but no known documentId exists. */
export const ARTIFACT_POSSIBLY_CREATED_SIGNAL =
  "artifactPossiblyCreated=true; manual inspection required in the selected disposable notebook";

/**
 * Bounded create→index visibility wait (read_note only). Default ~5s window.
 * Inject maxAttempts / delayMs / sleep in unit tests for speed and determinism.
 */
export const DEFAULT_VISIBILITY_MAX_ATTEMPTS = 20;
export const DEFAULT_VISIBILITY_DELAY_MS = 250;

/** Fixed safe message when the new document never becomes readable within the bound. */
export const VISIBILITY_TIMEOUT_MESSAGE =
  "created document not visible to read_note within the bounded wait window";

/**
 * Over-limit block window request for read_note_segments clamp proof.
 * Must exceed any reasonable safety.longDocument.maxBlocksPerWindow.
 */
export const SEGMENTS_OVER_LIMIT_REQUEST = 10_000;

/** Fixed safe message when post-edit replacement marker never becomes readable. */
export const POST_EDIT_VISIBILITY_TIMEOUT_MESSAGE =
  "edited marker not visible to read_note within the bounded wait window";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Strict SiYuan id check. Never treats arbitrary nonempty strings as valid.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSiyuanId(value) {
  return typeof value === "string" && SIYUAN_ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @param {string} [context]
 * @returns {string}
 */
export function assertSiyuanId(value, context = "id") {
  if (!isSiyuanId(value)) {
    throw new Error(`${context}: invalid SiYuan id format`);
  }
  return value;
}

/**
 * Shared MCP tools/call result gate: object result, isError !== true, and
 * structuredContent is a plain object (not null/array). Never reads content.text.
 * @returns {object} structuredContent
 */
function requirePlainStructuredContent(mcpResult, context = "tools/call") {
  if (!mcpResult || typeof mcpResult !== "object") {
    throw new Error(`${context}: missing result`);
  }
  if (mcpResult.isError === true) {
    throw new Error(`${context}: MCP result.isError=true`);
  }
  const sc = mcpResult.structuredContent;
  if (sc == null || typeof sc !== "object" || Array.isArray(sc)) {
    throw new Error(
      `${context}: missing or malformed structuredContent`,
    );
  }
  return sc;
}

/**
 * Direct-return plugin tools (get_policy): MCP result.structuredContent is the
 * tool payload itself — not { ok, result }. Never parses content.text and never
 * unwraps an envelope (enveloped payloads fail later as malformed policy).
 * @returns {object} structuredContent
 */
export function assertPluginDirectStructuredContent(
  mcpResult,
  context = "tools/call",
) {
  return requirePlainStructuredContent(mcpResult, context);
}

/**
 * runTool plugin tools/call success requires MCP result.structuredContent shaped
 * { ok: true, result: <object> }. Never parses content.text.
 * @returns {object} structuredContent.result
 */
export function assertPluginOkEnvelope(mcpResult, context = "tools/call") {
  const sc = requirePlainStructuredContent(mcpResult, context);
  if (sc.ok === false) {
    throw new Error(`${context}: structuredContent.ok=false`);
  }
  if (sc.ok !== true) {
    throw new Error(
      `${context}: missing or malformed structuredContent envelope`,
    );
  }
  if (
    sc.result == null ||
    typeof sc.result !== "object" ||
    Array.isArray(sc.result)
  ) {
    throw new Error(
      `${context}: structuredContent.result must be an object`,
    );
  }
  return sc.result;
}

/**
 * Ensure create/update/read/delete are not deny (allow or confirm ok).
 * Delete must not be deny so cleanup is possible.
 */
export function assertWriteOpsPermitted(operations, context = "preflight") {
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) {
    throw new Error(`${context}: policy operations missing or malformed`);
  }
  for (const op of ["create", "update", "read", "delete"]) {
    const decision = operations[op];
    if (decision === "deny") {
      if (op === "delete") {
        throw new Error(
          `${context}: operations.delete is deny — cleanup not permitted; refuse create`,
        );
      }
      throw new Error(
        `${context}: operations.${op} is deny — refuse write smoke`,
      );
    }
    if (decision !== "allow" && decision !== "confirm") {
      throw new Error(
        `${context}: operations.${op} missing or unknown decision`,
      );
    }
  }
}

/** Strict 64-char lowercase hex SHA-256 (stateHash / expectedHash). */
export const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isStateHash(value) {
  return typeof value === "string" && STATE_HASH_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @param {string} [context]
 * @returns {string}
 */
export function assertStateHash(value, context = "stateHash") {
  if (!isStateHash(value)) {
    throw new Error(`${context}: must be a 64-character lowercase hex SHA-256 digest`);
  }
  return value;
}

/**
 * Prove target notebookId is listed as accessible (id match only; never log names).
 */
export function assertNotebookAccessible(listResult, notebookId, context = "preflight") {
  if (typeof notebookId !== "string" || notebookId.trim().length === 0) {
    throw new Error(`${context}: notebookId is required`);
  }
  const notebooks = listResult?.notebooks;
  if (!Array.isArray(notebooks)) {
    throw new Error(`${context}: list_accessible_notebooks.result.notebooks must be an array`);
  }
  const found = notebooks.some(
    (nb) => nb && typeof nb === "object" && nb.id === notebookId,
  );
  if (!found) {
    throw new Error(
      `${context}: target notebook is not accessible (not listed by list_accessible_notebooks)`,
    );
  }
}

/**
 * Generate unique title + body + edit markers (caller must not log them on success).
 */
export function generateSmokeIdentity(now = Date.now(), entropy = randomBytes) {
  const suffix = entropy(8).toString("hex");
  return {
    title: `mcp-write-smoke-${now}-${suffix}`,
    bodyMarker: `mcp-write-smoke-marker-${now}-${suffix}`,
    editMarker: `mcp-write-smoke-edit-marker-${now}-${suffix}`,
  };
}

/**
 * Build lifecycle tool arguments (exact contract).
 * create/update tagging is exactly { decision: "skip", tags: [] } — no other shape
 * (ask-mode tag policy must not block after visibility).
 */
export function buildLifecycleArgs({
  notebookId,
  title,
  bodyMarker,
  documentId,
  hPath,
  blockId,
  expectedHash,
  editMarker,
}) {
  const createMarkdown = `# mcp-write-smoke\n\n${bodyMarker}\n`;
  const updateMarkdown = `# mcp-write-smoke\n\n${bodyMarker}\n\nupdated\n`;
  const taggingSkip = { decision: "skip", tags: [] };
  return {
    create: {
      notebookId,
      title,
      markdown: createMarkdown,
      tagging: taggingSkip,
      confirmed: true,
    },
    update: {
      documentId,
      markdown: updateMarkdown,
      tagging: taggingSkip,
      confirmed: true,
    },
    read: {
      documentId,
      confirmed: true,
    },
    resolve: {
      notebookId,
      hPath,
      confirmed: true,
    },
    segments: {
      documentId,
      offset: 0,
      limit: SEGMENTS_OVER_LIMIT_REQUEST,
      includeStateHash: true,
      confirmed: true,
    },
    /** Atomic server validation — never writes regardless of confirmed. */
    editValidate: {
      blockId,
      markdown: editMarker,
      expectedHash,
      validateOnly: true,
      confirmed: false,
    },
    /** Single destructive write under --confirm-destructive-smoke. */
    edit: {
      blockId,
      markdown: editMarker,
      expectedHash,
      validateOnly: false,
      confirmed: true,
    },
    delete: {
      documentId,
      expectedTitle: title,
      confirmed: true,
    },
  };
}

/**
 * After create_note: documentId is a strict SiYuan id AND notebookId/title
 * exactly equal the values requested. Throws fixed messages (never logs title/body).
 * Returns documentId when all checks pass.
 */
export function assertCreateResultMatch(
  createResult,
  { notebookId, title },
  context = "create_note",
) {
  if (!createResult || typeof createResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (
    typeof createResult.documentId !== "string" ||
    createResult.documentId.length === 0
  ) {
    throw new Error(`${context}: result.documentId missing`);
  }
  if (!isSiyuanId(createResult.documentId)) {
    throw new Error(`${context}: result.documentId invalid format`);
  }
  if (createResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (createResult.title !== title) {
    throw new Error(`${context}: result.title mismatch`);
  }
  return createResult.documentId;
}

/**
 * Verify update_note envelope result fields (txn committed + verified).
 */
export function assertUpdateCommitted(updateResult, context = "update_note") {
  if (!updateResult || typeof updateResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (updateResult.txnState !== "committed") {
    throw new Error(`${context}: txnState is not committed`);
  }
  if (updateResult.verified !== true) {
    throw new Error(`${context}: verified is not true`);
  }
}

/**
 * Verify read_note content contains body marker (internal only; never log content).
 */
export function assertReadContainsMarker(readResult, bodyMarker, context = "read_note") {
  if (!readResult || typeof readResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  const content = readResult.content;
  if (typeof content !== "string") {
    throw new Error(`${context}: result.content missing or not a string`);
  }
  if (typeof bodyMarker !== "string" || bodyMarker.length === 0) {
    throw new Error(`${context}: bodyMarker is required for verification`);
  }
  if (!content.includes(bodyMarker)) {
    throw new Error(`${context}: body marker not found in content`);
  }
}

/**
 * After a visibility/read success: documentId, notebookId, title must match the
 * created note and content must contain the unique body marker. Never logs values.
 */
export function assertReadVisibleMatch(
  readResult,
  { documentId, notebookId, title, bodyMarker },
  context = "visibility read_note",
) {
  if (!readResult || typeof readResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (readResult.documentId !== documentId) {
    throw new Error(`${context}: result.documentId mismatch`);
  }
  if (readResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (readResult.title !== title) {
    throw new Error(`${context}: result.title mismatch`);
  }
  assertReadContainsMarker(readResult, bodyMarker, context);
}

/**
 * Strict runTool envelope parse for visibility polling.
 * - { ok: false } → not yet visible (retry until bound)
 * - missing/malformed structuredContent / non-envelope → hard failure
 * - { ok: true, result: object } → visible (caller verifies fields)
 * Never reads content.text or error message/data.
 *
 * @returns {{ status: "not_yet_visible" } | { status: "visible", result: object }}
 */
export function parseVisibilityReadEnvelope(
  mcpResult,
  context = "visibility read_note",
) {
  const sc = requirePlainStructuredContent(mcpResult, context);
  if (sc.ok === false) {
    return { status: "not_yet_visible" };
  }
  if (sc.ok !== true) {
    throw new Error(
      `${context}: missing or malformed structuredContent envelope`,
    );
  }
  if (
    sc.result == null ||
    typeof sc.result !== "object" ||
    Array.isArray(sc.result)
  ) {
    throw new Error(
      `${context}: structuredContent.result must be an object`,
    );
  }
  return { status: "visible", result: sc.result };
}

/**
 * Default sleep used by visibility polling (injectable in tests).
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Verify delete_note result.deleted === true.
 */
export function assertDeleted(deleteResult, context = "delete_note") {
  if (!deleteResult || typeof deleteResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (deleteResult.deleted !== true) {
    throw new Error(`${context}: deleted is not true`);
  }
}

/**
 * Require a non-empty hPath string from a verification read (never logged).
 * @returns {string}
 */
export function assertReadHasHPath(readResult, context = "read_note") {
  if (!readResult || typeof readResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (typeof readResult.hPath !== "string" || readResult.hPath.trim().length === 0) {
    throw new Error(`${context}: result.hPath missing or empty`);
  }
  return readResult.hPath.trim();
}

/**
 * Verify resolve_document envelope result fields (lookup-only path resolution).
 */
export function assertResolveDocumentMatch(
  resolveResult,
  { documentId, notebookId, title, hPath },
  context = "resolve_document",
) {
  if (!resolveResult || typeof resolveResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (resolveResult.documentId !== documentId) {
    throw new Error(`${context}: result.documentId mismatch`);
  }
  if (resolveResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (resolveResult.title !== title) {
    throw new Error(`${context}: result.title mismatch`);
  }
  if (resolveResult.hPath !== hPath) {
    throw new Error(`${context}: result.hPath mismatch`);
  }
  if (resolveResult.lookupOnly !== true) {
    throw new Error(`${context}: result.lookupOnly must be true`);
  }
  if (resolveResult.writeByPath !== false) {
    throw new Error(`${context}: result.writeByPath must be false`);
  }
}

/**
 * Verify read_note_segments envelope result: identity fields, hard clamp, block ids.
 * Does not select the marker target (see findUniqueExactMarkerBlock).
 * @returns {object} segments result when valid
 */
export function assertReadNoteSegmentsMatch(
  segmentsResult,
  { documentId, notebookId, title, hPath, requestedLimit },
  context = "read_note_segments",
) {
  if (!segmentsResult || typeof segmentsResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (segmentsResult.documentId !== documentId) {
    throw new Error(`${context}: result.documentId mismatch`);
  }
  if (segmentsResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (segmentsResult.title !== title) {
    throw new Error(`${context}: result.title mismatch`);
  }
  if (segmentsResult.hPath !== hPath) {
    throw new Error(`${context}: result.hPath mismatch`);
  }
  const limits = segmentsResult.limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`${context}: result.limits missing or malformed`);
  }
  if (
    typeof limits.maxBlocksPerWindow !== "number" ||
    !Number.isFinite(limits.maxBlocksPerWindow) ||
    limits.maxBlocksPerWindow < 1
  ) {
    throw new Error(`${context}: limits.maxBlocksPerWindow missing or invalid`);
  }
  if (
    typeof segmentsResult.limit !== "number" ||
    !Number.isFinite(segmentsResult.limit)
  ) {
    throw new Error(`${context}: result.limit missing or invalid`);
  }
  if (segmentsResult.limit > limits.maxBlocksPerWindow) {
    throw new Error(
      `${context}: result.limit exceeds limits.maxBlocksPerWindow`,
    );
  }
  if (
    typeof requestedLimit !== "number" ||
    !Number.isFinite(requestedLimit) ||
    requestedLimit <= limits.maxBlocksPerWindow
  ) {
    throw new Error(
      `${context}: requested limit must exceed maxBlocksPerWindow to prove clamp`,
    );
  }
  if (segmentsResult.limit !== limits.maxBlocksPerWindow) {
    throw new Error(
      `${context}: over-limit request was not clamped to maxBlocksPerWindow`,
    );
  }
  if (!Array.isArray(segmentsResult.blocks)) {
    throw new Error(`${context}: result.blocks must be an array`);
  }
  for (const block of segmentsResult.blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new Error(`${context}: block entry malformed`);
    }
    if (!isSiyuanId(block.blockId)) {
      throw new Error(`${context}: block.blockId invalid format`);
    }
  }
  return segmentsResult;
}

/**
 * Find the unique untruncated block whose trimmed text exactly equals marker
 * and whose stateHash is a strict 64-char lowercase hex digest.
 * Segments text is never used as expectedContent (SQL ≠ kramdown); stateHash
 * from includeStateHash=true is the only accepted expected state token.
 * @returns {{ blockId: string, text: string, truncated: false, stateHash: string }}
 */
export function findUniqueExactMarkerBlock(
  blocks,
  marker,
  context = "read_note_segments",
) {
  if (!Array.isArray(blocks)) {
    throw new Error(`${context}: blocks must be an array`);
  }
  if (typeof marker !== "string" || marker.length === 0) {
    throw new Error(`${context}: marker is required`);
  }
  /** @type {Array<{ blockId: string, text: string, truncated: false, stateHash: string }>} */
  const hits = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      throw new Error(`${context}: block entry malformed`);
    }
    if (!isSiyuanId(block.blockId)) {
      throw new Error(`${context}: block.blockId invalid format`);
    }
    if (typeof block.text !== "string") {
      continue;
    }
    if (block.truncated === true) {
      continue;
    }
    if (block.truncated !== false) {
      // Only accept explicit truncated=false for edit targets
      continue;
    }
    if (block.text.trim() !== marker) {
      continue;
    }
    if (!isStateHash(block.stateHash)) {
      throw new Error(
        `${context}: marker block missing or invalid stateHash (require includeStateHash=true)`,
      );
    }
    hits.push({
      blockId: block.blockId,
      text: block.text,
      truncated: false,
      stateHash: block.stateHash,
    });
  }
  if (hits.length === 0) {
    throw new Error(`${context}: unique exact marker block not found`);
  }
  if (hits.length > 1) {
    throw new Error(`${context}: marker block is not unique`);
  }
  return hits[0];
}

/**
 * Strict validateOnly=true edit_block success: mode=validated, no write,
 * exact ids, empty refs for the dedicated smoke block. Never logs values.
 */
export function assertEditBlockValidated(
  editResult,
  { blockId, documentId, notebookId },
  context = "edit_block validateOnly",
) {
  if (!editResult || typeof editResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (editResult.mode !== "validated") {
    throw new Error(`${context}: result.mode must be validated`);
  }
  if (editResult.validated !== true) {
    throw new Error(`${context}: validated is not true`);
  }
  if (editResult.writeExecuted !== false) {
    throw new Error(`${context}: writeExecuted must be false`);
  }
  if (editResult.blockId !== blockId) {
    throw new Error(`${context}: result.blockId mismatch`);
  }
  if (editResult.documentId !== documentId) {
    throw new Error(`${context}: result.documentId mismatch`);
  }
  if (editResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (editResult.referenceRisk !== "none") {
    throw new Error(`${context}: referenceRisk is not none`);
  }
  if (editResult.referencingCount !== 0) {
    throw new Error(`${context}: referencingCount must be 0`);
  }
  if (!Array.isArray(editResult.referencing)) {
    throw new Error(`${context}: result.referencing must be an array`);
  }
  if (editResult.referencing.length !== 0) {
    throw new Error(`${context}: referencing must be empty`);
  }
  // Fail closed if a write-shaped payload sneaks through
  if (editResult.txnState !== undefined || editResult.verified !== undefined) {
    throw new Error(`${context}: unexpected write txn fields on validateOnly result`);
  }
}

/**
 * Verify confirmed write edit_block result: exact ids, committed txn, verified,
 * and empty references for the dedicated test block.
 * Never logs ids, txnId, or reference snippets.
 */
export function assertEditBlockCommitted(
  editResult,
  { blockId, documentId, notebookId },
  context = "edit_block",
) {
  if (!editResult || typeof editResult !== "object") {
    throw new Error(`${context}: missing result object`);
  }
  if (editResult.blockId !== blockId) {
    throw new Error(`${context}: result.blockId mismatch`);
  }
  if (editResult.documentId !== documentId) {
    throw new Error(`${context}: result.documentId mismatch`);
  }
  if (editResult.notebookId !== notebookId) {
    throw new Error(`${context}: result.notebookId mismatch`);
  }
  if (editResult.txnState !== "committed") {
    throw new Error(`${context}: txnState is not committed`);
  }
  if (editResult.verified !== true) {
    throw new Error(`${context}: verified is not true`);
  }
  if (editResult.referenceRisk !== "none") {
    throw new Error(`${context}: referenceRisk is not none`);
  }
  if (editResult.referencingCount !== 0) {
    throw new Error(`${context}: referencingCount must be 0`);
  }
  if (!Array.isArray(editResult.referencing)) {
    throw new Error(`${context}: result.referencing must be an array`);
  }
  if (editResult.referencing.length !== 0) {
    throw new Error(`${context}: referencing must be empty`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse CLI argv. Requires --notebook-id and --confirm-destructive-smoke.
 * Optional --url. Unknown / missing values fail closed.
 */
export function parseCliArgs(argv) {
  const args = {
    notebookId: undefined,
    confirmDestructiveSmoke: false,
    url: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm-destructive-smoke") {
      args.confirmDestructiveSmoke = true;
    } else if (a === "--notebook-id") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--notebook-id requires a value");
      }
      args.notebookId = argv[++i];
    } else if (a.startsWith("--notebook-id=")) {
      const value = a.slice("--notebook-id=".length);
      if (!value) {
        throw new Error("--notebook-id requires a value");
      }
      args.notebookId = value;
    } else if (a === "--url") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--url requires a value");
      }
      args.url = argv[++i];
    } else if (a.startsWith("--url=")) {
      const value = a.slice("--url=".length);
      if (!value) {
        throw new Error("--url requires a value");
      }
      args.url = value;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (args.help) {
    return args;
  }
  if (!args.confirmDestructiveSmoke) {
    throw new Error(
      "missing required flag --confirm-destructive-smoke (explicit opt-in for destructive write smoke)",
    );
  }
  if (
    typeof args.notebookId !== "string" ||
    args.notebookId.trim().length === 0
  ) {
    throw new Error("missing required --notebook-id ID");
  }
  if (!isSiyuanId(args.notebookId)) {
    throw new Error(
      `invalid --notebook-id format (expected SiYuan id ${SIYUAN_ID_PATTERN})`,
    );
  }
  return args;
}

function printHelp(log = console.log) {
  log(`Usage: node scripts/mcp-write-smoke.mjs --notebook-id ID --confirm-destructive-smoke [--url URL]

DESTRUCTIVE write smoke (MCP ${PROTOCOL_VERSION}). Explicit opt-in only.
  initialize → session → tools/list + catalog
  → get_policy + list_accessible_notebooks (preflight)
  → create_note → visibility read_note (bounded poll; capture hPath)
  → resolve_document → read_note_segments (over-limit clamp + includeStateHash)
  → edit_block validateOnly=true (atomic server validation; never writes)
  → edit_block validateOnly=false confirmed=true exactly once
  → post-edit read_note (prove edit marker before update)
  → update_note exactly once → final read_note (prove update marker/body + identity)
  → delete_note
  (plugin__siyuanmaster__* only; no rename/move; no native bypass; no policy mutation)

After create, waits up to ~${DEFAULT_VISIBILITY_MAX_ATTEMPTS * DEFAULT_VISIBILITY_DELAY_MS}ms
(${DEFAULT_VISIBILITY_MAX_ATTEMPTS} × ${DEFAULT_VISIBILITY_DELAY_MS}ms) for SiYuan index
visibility via plugin read_note only. Post-edit uses the same bounded read_note poll
for the replacement marker before update_note. Only read polls may retry;
create/update/edit_block/delete never retry. edit_block write is never retried.

Requirements:
  --notebook-id ID              disposable allowed notebook (exact id)
  --confirm-destructive-smoke   required confirmation flag (this run's explicit write gate)
  policy: create/update/read/delete not deny (delete default deny — set allow/confirm)
  SIYUAN_API_TOKEN              required; never printed

Optional:
  --url URL                     loopback MCP URL (default ${DEFAULT_MCP_URL})
  SIYUAN_MCP_URL                used when --url omitted

Success leaves no note (lifecycle delete). Known-ID post-create failures get
exactly one plugin delete_note cleanup; cleanup failure may print only the
validated documentId. Unknown create outcome (timeout / malformed envelope /
ok:false / missing or invalid documentId) cannot cleanup safely and reports
artifactPossiblyCreated=true for manual inspection in the selected disposable
notebook (no documentId / title / body / token / session).

Exit codes:
  0  full lifecycle ok (and cleanup not needed or not reached)
  1  any CLI / preflight / HTTP / envelope / lifecycle / cleanup failure
`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Shared tools/call transport: JSON-RPC success only. Returns the raw MCP
 * CallToolResult (caller chooses direct vs envelope structuredContent extract).
 * @returns {Promise<object>} MCP result object
 */
async function callMcpToolResult({
  url,
  token,
  sessionId,
  fetchImpl,
  timeoutMs,
  nextId,
  toolName,
  arguments: toolArgs,
}) {
  const callId = nextId();
  const callRes = await mcpPost({
    url,
    token,
    sessionId,
    fetchImpl,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs ?? {},
      },
    },
  });
  const callMsg = pickJsonRpcResponse(callRes.messages, callId);
  return assertJsonRpcSuccess(callMsg, `tools/call ${toolName}`);
}

/**
 * Call a direct-return plugin tool (get_policy).
 * @returns {Promise<object>} structuredContent object
 */
async function callPluginDirectTool(opts) {
  const callResult = await callMcpToolResult(opts);
  return assertPluginDirectStructuredContent(
    callResult,
    `tools/call ${opts.toolName}`,
  );
}

/**
 * Call a runTool-envelope plugin tool (list/lifecycle).
 * @returns {Promise<object>} structuredContent.result
 */
async function callPluginTool(opts) {
  const callResult = await callMcpToolResult(opts);
  return assertPluginOkEnvelope(callResult, `tools/call ${opts.toolName}`);
}

/**
 * Bounded READ-ONLY wait until create is visible via plugin read_note.
 * Only read polls retry; never retries create/update/delete. Injectable
 * maxAttempts / delayMs / sleep for unit tests.
 *
 * @param {object} options
 * @returns {Promise<object>} verified read result (never logged)
 */
export async function waitForCreatedDocumentVisible(options) {
  const {
    callOpts,
    toolName,
    documentId,
    notebookId,
    title,
    bodyMarker,
    maxAttempts = DEFAULT_VISIBILITY_MAX_ATTEMPTS,
    delayMs = DEFAULT_VISIBILITY_DELAY_MS,
    sleep = defaultSleep,
    context = "visibility read_note",
    timeoutMessage = VISIBILITY_TIMEOUT_MESSAGE,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("visibility maxAttempts must be a positive integer");
  }
  if (typeof delayMs !== "number" || delayMs < 0 || !Number.isFinite(delayMs)) {
    throw new Error("visibility delayMs must be a non-negative finite number");
  }
  if (typeof sleep !== "function") {
    throw new Error("visibility sleep must be a function");
  }

  const readArgs = {
    documentId,
    confirmed: true,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const callResult = await callMcpToolResult({
      ...callOpts,
      toolName,
      arguments: readArgs,
    });
    const parsed = parseVisibilityReadEnvelope(callResult, context);
    if (parsed.status === "visible") {
      assertReadVisibleMatch(
        parsed.result,
        { documentId, notebookId, title, bodyMarker },
        context,
      );
      return parsed.result;
    }
    // not_yet_visible — poll again within bound; never log error payload
    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }
  throw new Error(timeoutMessage);
}

/**
 * Run destructive write smoke.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.notebookId
 * @param {boolean} options.confirmDestructiveSmoke
 * @param {string} [options.url]
 * @param {object} [options.catalog]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {(line: string) => void} [options.log]
 * @param {() => { title: string, bodyMarker: string }} [options.identityFactory]
 * @param {number} [options.visibilityMaxAttempts]
 * @param {number} [options.visibilityDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<object>} summary (no secrets / no notebook id / no title / no body)
 */
export async function runMcpWriteSmoke(options) {
  if (options?.confirmDestructiveSmoke !== true) {
    throw new Error(
      "confirmDestructiveSmoke must be true (explicit opt-in)",
    );
  }
  const token = options?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("SIYUAN_API_TOKEN is required (not printed)");
  }
  const notebookId = options?.notebookId;
  if (typeof notebookId !== "string" || notebookId.trim().length === 0) {
    throw new Error("notebookId is required");
  }
  // Validate before any network / write so invalid ids never reach MCP.
  assertSiyuanId(notebookId, "notebookId");

  const url = assertLoopbackUrl(options.url ?? DEFAULT_MCP_URL).toString();
  const log = options.log ?? ((line) => console.log(line));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const visibilityMaxAttempts =
    options.visibilityMaxAttempts ?? DEFAULT_VISIBILITY_MAX_ATTEMPTS;
  const visibilityDelayMs =
    options.visibilityDelayMs ?? DEFAULT_VISIBILITY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const catalog = options.catalog ?? (await loadCatalog());
  const pluginNamespace = catalog.namespaces.plugin;
  if (typeof pluginNamespace !== "string" || !pluginNamespace) {
    throw new Error("catalog.namespaces.plugin is required");
  }

  const tool = (bare) => `${pluginNamespace}${bare}`;

  let rpcId = 0;
  const nextId = () => {
    rpcId += 1;
    return rpcId;
  };

  // 1) initialize
  const initId = nextId();
  const initRes = await mcpPost({
    url,
    token,
    fetchImpl,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
  });
  const initMsg = pickJsonRpcResponse(initRes.messages, initId);
  const initResult = assertJsonRpcSuccess(initMsg, "initialize");
  if (
    initResult.protocolVersion === undefined ||
    initResult.protocolVersion === null ||
    initResult.protocolVersion === ""
  ) {
    throw new Error("initialize: protocolVersion missing");
  }
  if (initResult.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("initialize: protocolVersion mismatch");
  }
  const sessionId = initRes.sessionId;
  if (!sessionId) {
    throw new Error(
      "SiYuan MCP write-smoke prerequisite: initialize response missing Mcp-Session-Id",
    );
  }
  // session=yes only — never log the session id value
  log(`initialize ok http=${initRes.status} session=yes protocol=${PROTOCOL_VERSION}`);

  // 2) notifications/initialized (SiYuan: HTTP 202 + empty messages)
  const initializedRes = await mcpPost({
    url,
    token,
    sessionId,
    fetchImpl,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  });
  assertNoJsonRpcErrors(initializedRes.messages, "notifications/initialized");
  if (initializedRes.status !== 202) {
    throw new Error(
      `notifications/initialized: expected HTTP 202 (got ${initializedRes.status})`,
    );
  }
  if (initializedRes.messages.length !== 0) {
    throw new Error("notifications/initialized: expected empty messages");
  }
  log(`initialized notification sent http=${initializedRes.status}`);

  // 3) tools/list + catalog exact match
  const listId = nextId();
  const listRes = await mcpPost({
    url,
    token,
    sessionId,
    fetchImpl,
    timeoutMs,
    body: {
      jsonrpc: "2.0",
      id: listId,
      method: "tools/list",
      params: {},
    },
  });
  const listMsg = pickJsonRpcResponse(listRes.messages, listId);
  const listResult = assertJsonRpcSuccess(listMsg, "tools/list");
  const toolNames = extractToolNames(listResult);
  const counts = countToolNamespaces(toolNames, pluginNamespace);
  log(
    `tools/list ok total=${counts.total} plugin=${counts.plugin} legacy=${counts.legacy} other=${counts.other}`,
  );

  const validation = validateAgainstCatalog(toolNames, catalog);
  assertCatalogMatch(validation);
  log(
    `catalog match ok expected=${validation.expectedCount} actual=${validation.actualCount} legacy=0`,
  );

  const callOpts = {
    url,
    token,
    sessionId,
    fetchImpl,
    timeoutMs,
    nextId,
  };

  // 4) get_policy (direct structuredContent) then list_accessible_notebooks
  //    (runTool envelope). Strict order; never content.text.
  const policy = await callPluginDirectTool({
    ...callOpts,
    toolName: tool("get_policy"),
    arguments: {},
  });
  log("preflight get_policy ok");

  const notebooksResult = await callPluginTool({
    ...callOpts,
    toolName: tool("list_accessible_notebooks"),
    arguments: {},
  });
  log("preflight list_accessible_notebooks ok");

  // 5) Preflight — refuse create unless notebook accessible and ops permit
  //    create/update/read/delete (update must not deny so edit_block can run).
  // Enveloped get_policy cannot be misread as policy: operations is missing.
  assertWriteOpsPermitted(policy.operations, "preflight");
  assertNotebookAccessible(notebooksResult, notebookId, "preflight");
  log("preflight ops+notebook ok");

  // 6) Lifecycle identity (never logged on success)
  const identityFactory =
    options.identityFactory ?? (() => generateSmokeIdentity());
  const identity = identityFactory();
  const title = identity?.title;
  const bodyMarker = identity?.bodyMarker;
  const editMarker =
    typeof identity?.editMarker === "string" && identity.editMarker.length > 0
      ? identity.editMarker
      : typeof bodyMarker === "string" && bodyMarker.length > 0
        ? `${bodyMarker}-edit`
        : "";
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("identityFactory must return a non-empty title");
  }
  if (typeof bodyMarker !== "string" || bodyMarker.length === 0) {
    throw new Error("identityFactory must return a non-empty bodyMarker");
  }
  if (typeof editMarker !== "string" || editMarker.length === 0) {
    throw new Error("identityFactory must yield a non-empty editMarker");
  }

  let documentId = null;
  let created = false;
  /** True once create_note request has been dispatched (even if outcome unknown). */
  let createDispatched = false;
  let lifecycleDeleted = false;
  let cleanupAttempted = false;
  let cleanupOk = false;
  /** @type {Error | null} */
  let pendingError = null;

  const tryCleanup = async () => {
    // Only with a known validated documentId; never guess or search.
    if (
      !created ||
      lifecycleDeleted ||
      !isSiyuanId(documentId) ||
      cleanupAttempted
    ) {
      return;
    }
    cleanupAttempted = true;
    try {
      const deleteResult = await callPluginTool({
        ...callOpts,
        toolName: tool("delete_note"),
        arguments: {
          documentId,
          expectedTitle: title,
          confirmed: true,
        },
      });
      assertDeleted(deleteResult, "cleanup delete_note");
      cleanupOk = true;
      log("cleanup delete_note ok");
    } catch (cleanupErr) {
      cleanupOk = false;
      // Only a validated SiYuan documentId may be shown — never arbitrary strings.
      const notice = isSiyuanId(documentId)
        ? `cleanup failed; manual recovery may be required documentId=${documentId}`
        : "cleanup failed; manual recovery may be required";
      if (pendingError) {
        const original = pendingError.message || String(pendingError);
        pendingError = new Error(`${original}; ${notice}`);
      } else {
        pendingError = new Error(notice);
      }
    }
  };

  try {
    // create_note — only after preflight above; never write first
    const createArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId: null,
    }).create;
    // Mark dispatched before await so timeout/transport failures still count.
    createDispatched = true;
    const createResult = await callPluginTool({
      ...callOpts,
      toolName: tool("create_note"),
      arguments: createArgs,
    });
    // Known-created only with strict SiYuan id (cleanup-safe). Then require
    // exact notebookId/title match before continuing the lifecycle.
    if (isSiyuanId(createResult.documentId)) {
      documentId = createResult.documentId;
      created = true;
    }
    assertCreateResultMatch(createResult, { notebookId, title }, "create_note");
    log("create_note ok");

    // Bounded READ-ONLY visibility wait: plugin read_note only. {ok:false}
    // polls until bound; malformed envelope is a hard failure. Never retries
    // create/update/edit_block/delete. Capture hPath here (before any write).
    const visibilityRead = await waitForCreatedDocumentVisible({
      callOpts,
      toolName: tool("read_note"),
      documentId,
      notebookId,
      title,
      bodyMarker,
      maxAttempts: visibilityMaxAttempts,
      delayMs: visibilityDelayMs,
      sleep,
    });
    const verifiedHPath = assertReadHasHPath(
      visibilityRead,
      "visibility read_note",
    );
    log("visibility read_note ok");

    // resolve_document — lookup-only using visibility hPath (never write by path)
    const resolveArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
      hPath: verifiedHPath,
    }).resolve;
    const resolveResult = await callPluginTool({
      ...callOpts,
      toolName: tool("resolve_document"),
      arguments: resolveArgs,
    });
    assertResolveDocumentMatch(
      resolveResult,
      {
        documentId,
        notebookId,
        title,
        hPath: verifiedHPath,
      },
      "resolve_document",
    );
    log("resolve_document ok");

    // read_note_segments — over-limit + includeStateHash on the created body
    // (before update) so we do not edit a just-updated new block.
    const segmentsArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
    }).segments;
    const segmentsResult = await callPluginTool({
      ...callOpts,
      toolName: tool("read_note_segments"),
      arguments: segmentsArgs,
    });
    assertReadNoteSegmentsMatch(
      segmentsResult,
      {
        documentId,
        notebookId,
        title,
        hPath: verifiedHPath,
        requestedLimit: SEGMENTS_OVER_LIMIT_REQUEST,
      },
      "read_note_segments",
    );
    const targetBlock = findUniqueExactMarkerBlock(
      segmentsResult.blocks,
      bodyMarker,
      "read_note_segments",
    );
    const expectedHash = assertStateHash(
      targetBlock.stateHash,
      "read_note_segments target.stateHash",
    );
    log("read_note_segments ok");

    // edit_block validateOnly=true: full server preflight, never writes.
    // Fail closed before any real write if validation shape/IDs/refs wrong.
    const lifecycleEditArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
      blockId: targetBlock.blockId,
      expectedHash,
      editMarker,
    });
    const editValidateArgs = lifecycleEditArgs.editValidate;
    const editValidateResult = await callPluginTool({
      ...callOpts,
      toolName: tool("edit_block"),
      arguments: editValidateArgs,
    });
    assertEditBlockValidated(
      editValidateResult,
      {
        blockId: targetBlock.blockId,
        documentId,
        notebookId,
      },
      "edit_block validateOnly",
    );
    log("edit_block validateOnly ok");

    // Single destructive edit under --confirm-destructive-smoke.
    // Same blockId/markdown/expectedHash as validateOnly; never retry.
    const editArgs = lifecycleEditArgs.edit;
    if (editArgs.expectedHash !== editValidateArgs.expectedHash) {
      throw new Error("edit_block: expectedHash must match validateOnly call");
    }
    if (editArgs.blockId !== editValidateArgs.blockId) {
      throw new Error("edit_block: blockId must match validateOnly call");
    }
    if (editArgs.markdown !== editValidateArgs.markdown) {
      throw new Error("edit_block: markdown must match validateOnly call");
    }
    const editResult = await callPluginTool({
      ...callOpts,
      toolName: tool("edit_block"),
      arguments: editArgs,
    });
    assertEditBlockCommitted(
      editResult,
      {
        blockId: targetBlock.blockId,
        documentId,
        notebookId,
      },
      "edit_block",
    );
    log("edit_block ok");

    // Post-edit: bounded READ-ONLY poll for replacement marker BEFORE update.
    // Proves the edit landed; must not call update_note until this succeeds.
    await waitForCreatedDocumentVisible({
      callOpts,
      toolName: tool("read_note"),
      documentId,
      notebookId,
      title,
      bodyMarker: editMarker,
      maxAttempts: visibilityMaxAttempts,
      delayMs: visibilityDelayMs,
      sleep,
      context: "post-edit read_note",
      timeoutMessage: POST_EDIT_VISIBILITY_TIMEOUT_MESSAGE,
    });
    log("post-edit read_note ok");

    // update_note exactly once after edit proof (tagging skip so ask-mode cannot block)
    const updateArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
    }).update;
    const updateResult = await callPluginTool({
      ...callOpts,
      toolName: tool("update_note"),
      arguments: updateArgs,
    });
    assertUpdateCommitted(updateResult, "update_note");
    log("update_note ok");

    // Final read: prove update marker/body and identity (not part of post-edit poll)
    const readArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
    }).read;
    const finalReadResult = await callPluginTool({
      ...callOpts,
      toolName: tool("read_note"),
      arguments: readArgs,
    });
    assertReadVisibleMatch(
      finalReadResult,
      { documentId, notebookId, title, bodyMarker },
      "final read_note",
    );
    // update body also carries the fixed "updated" line from buildLifecycleArgs
    assertReadContainsMarker(finalReadResult, "updated", "final read_note");
    log("final read_note ok");

    // delete_note (lifecycle success path) — exactly once
    const deleteArgs = buildLifecycleArgs({
      notebookId,
      title,
      bodyMarker,
      documentId,
    }).delete;
    const deleteResult = await callPluginTool({
      ...callOpts,
      toolName: tool("delete_note"),
      arguments: deleteArgs,
    });
    assertDeleted(deleteResult, "delete_note");
    lifecycleDeleted = true;
    log("delete_note ok");
  } catch (err) {
    pendingError =
      err instanceof Error ? err : new Error(String(err ?? "unknown error"));
  } finally {
    // Exactly one plugin delete_note cleanup after known successful create
    // when lifecycle delete did not complete. No native API / bypass / search.
    await tryCleanup();
  }

  if (pendingError) {
    // Unknown create outcome: request may have created a note but we have no
    // cleanup-safe id. Do not claim cleanup was attempted; no retry/search.
    if (createDispatched && !created) {
      const original = pendingError.message || String(pendingError);
      if (!original.includes("artifactPossiblyCreated=true")) {
        pendingError = new Error(
          `${original}; ${ARTIFACT_POSSIBLY_CREATED_SIGNAL}`,
        );
      }
    }
    throw pendingError;
  }

  log("mcp-write-smoke PASS");
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    session: true,
    catalog: {
      expected: validation.expectedCount,
      actual: validation.actualCount,
      legacy: 0,
    },
    lifecycle: {
      create: true,
      resolve: true,
      segments: true,
      editValidation: true,
      edit: true,
      postEditRead: true,
      update: true,
      finalRead: true,
      delete: true,
    },
    cleanupAttempted,
    cleanupOk,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * CLI entry. Sets process.exitCode; does not call process.exit.
 *
 * @param {string[]} argv
 * @param {object} [deps]
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runMcpWriteSmoke;
  const log = deps.log ?? console.log.bind(console);
  const error = deps.error ?? console.error.bind(console);

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    error(`mcp-write-smoke FAIL: ${err?.message ?? err}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp(log);
    process.exitCode = 0;
    return;
  }

  const token = env.SIYUAN_API_TOKEN;
  const url = args.url ?? env.SIYUAN_MCP_URL ?? DEFAULT_MCP_URL;

  try {
    await run({
      token,
      url,
      notebookId: args.notebookId,
      confirmDestructiveSmoke: args.confirmDestructiveSmoke,
    });
    process.exitCode = 0;
  } catch (err) {
    const msg = redactSecrets(err?.message ?? err, token);
    error(`mcp-write-smoke FAIL: ${msg}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

if (isMain) {
  await main(process.argv.slice(2));
}
