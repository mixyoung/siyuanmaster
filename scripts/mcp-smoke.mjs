// Raw MCP discovery smoke against SiYuan's loopback Streamable HTTP endpoint.
//
// Protocol: MCP 2025-03-26
//   initialize → (Mcp-Session-Id) → notifications/initialized → tools/list
// Optional: --read-smoke → tools/call get_policy then list_accessible_notebooks
//   (isError / structuredContent presence / top-level keys / array counts only)
//
// Safety:
// - Loopback hosts only (127.0.0.1 / localhost / ::1); invalid IPv4 octets rejected
// - Token only from SIYUAN_API_TOKEN; never printed
// - Fail closed on HTTP, JSON-RPC error, or result.isError
// - Errors never include raw HTTP/SSE/JSON-RPC body text or fragments
// - Exact catalog match for 27 SiYuan 3.8.1 Agent capability tool names;
//   plugin__siyuanmaster__* prefix, stable hash suffix, legacy count = 0
//
// Default discovery: zero note writes.
// --read-smoke: two read-only tools; may produce metadata-only audit entries.
// Does not start/stop SiYuan; does not touch auth config.
// Script always sends Authorization: Token … (does not claim native auth is required).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_MCP_URL = "http://127.0.0.1:6806/mcp";
const DEFAULT_TIMEOUT_MS = 10_000;
const EXPECTED_PLUGIN_TOOL_COUNT = 27;
const MAX_AGENT_CAPABILITY_TOOL_NAME_LENGTH = 64;
const LEGACY_NAMESPACE = "plugin__siyuan_agent_access__";
const CLIENT_INFO = {
  name: "siyuanmaster-mcp-smoke",
  version: "0.6.1",
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
export const catalogPath = path.join(rootDir, "catalog", "capabilities.json");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Reproduce SiYuan 3.8.1 kernel/plugin/api_agent.go's stable model name.
 * The hash uses the unsanitized plugin/capability identity; the visible base
 * replaces every non-ASCII-alphanumeric character with an underscore.
 */
export function buildAgentCapabilityToolName(pluginName, capabilityName) {
  if (typeof pluginName !== "string" || pluginName.length === 0) {
    throw new Error("plugin technical id is required");
  }
  if (typeof capabilityName !== "string" || capabilityName.trim().length === 0) {
    throw new Error("capability name is required");
  }
  const localName = capabilityName.trim();
  const sanitize = (value) => value.replace(/[^0-9a-zA-Z]/g, "_");
  const suffix = `__${createHash("sha256")
    .update(`${pluginName}\0${localName}`, "utf8")
    .digest("hex")
    .slice(0, 12)}`;
  const base = `plugin__${sanitize(pluginName)}__${sanitize(localName)}`;
  return `${base.slice(0, MAX_AGENT_CAPABILITY_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** True when hostname is loopback (IPv4, IPv6, or localhost). */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") {
    return true;
  }
  // 127.0.0.0/8 with strict valid octets (0–255 only)
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/.test(host)) {
    return true;
  }
  return false;
}

/**
 * Parse and assert a loopback MCP URL. Throws on non-http(s) or non-loopback.
 * @returns {URL}
 */
export function assertLoopbackUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`invalid MCP URL: ${redactSecrets(String(urlString))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP URL must be http(s); got ${url.protocol}`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `MCP URL must be loopback only (127.0.0.1 / localhost / ::1); got host ${url.hostname}`,
    );
  }
  return url;
}

/**
 * Redact secrets and credential-like substrings for safe logging.
 * Never echoes SIYUAN_API_TOKEN or Authorization values.
 */
export function redactSecrets(input, token) {
  let text = typeof input === "string" ? input : String(input ?? "");
  if (token && token.length > 0) {
    text = text.split(token).join("[REDACTED_TOKEN]");
  }
  // Authorization: Token <value>  |  Bearer <value>
  text = text.replace(
    /(Authorization\s*[:=]\s*)(Token|Bearer)\s+\S+/gi,
    "$1$2 [REDACTED]",
  );
  // env-style dumps
  text = text.replace(
    /(SIYUAN_API_TOKEN\s*[=:]\s*)\S+/gi,
    "$1[REDACTED]",
  );
  // long opaque tokens (32+ alnum / - _)
  text = text.replace(
    /\b(?:Token|Bearer)\s+[A-Za-z0-9._\-]{16,}\b/gi,
    (m) => m.replace(/\s+\S+$/, " [REDACTED]"),
  );
  return text;
}

/**
 * Parse SSE body into JSON-RPC message objects (data: lines only).
 * Ignores comments and event: lines.
 * On invalid JSON: fixed error + length only (never payload text).
 */
export function parseSseJsonRpcMessages(bodyText) {
  if (typeof bodyText !== "string" || bodyText.length === 0) {
    return [];
  }
  const messages = [];
  // Split on blank lines (SSE event boundaries) or collect all data: lines.
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const event of events) {
    const dataLines = [];
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^\s/, ""));
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      messages.push(JSON.parse(payload));
    } catch {
      throw new Error(
        `SSE data is not valid JSON (dataLength=${payload.length})`,
      );
    }
  }
  return messages;
}

/**
 * Parse an MCP HTTP response body as either application/json or text/event-stream.
 * On illegal body: fixed error + metadata only (never body text).
 * @returns {{ messages: object[], contentType: string }}
 */
export function parseMcpHttpBody(bodyText, contentTypeHeader) {
  const contentType = String(contentTypeHeader ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const raw = String(bodyText ?? "");
  const bodyLength = raw.length;

  if (contentType.includes("text/event-stream")) {
    return {
      contentType: "text/event-stream",
      messages: parseSseJsonRpcMessages(raw),
    };
  }

  // Default / application/json / unknown with JSON body
  const trimmed = raw.trim();
  if (!trimmed) {
    return { contentType: contentType || "empty", messages: [] };
  }

  // Some servers may return SSE without declaring the content-type correctly.
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return {
      contentType: contentType || "text/event-stream",
      messages: parseSseJsonRpcMessages(raw),
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      contentType: contentType || "application/json",
      messages: Array.isArray(parsed) ? parsed : [parsed],
    };
  } catch {
    throw new Error(
      `MCP response is neither JSON nor SSE (content-type=${contentType || "unknown"}, bodyLength=${bodyLength})`,
    );
  }
}

/**
 * Pick the JSON-RPC response matching request id.
 * When requestId is provided: strict id match only — never fall back to another response.
 * Returns null when not found (caller reports fixed "missing response").
 * When requestId is omitted: first response-like message (result or error).
 */
export function pickJsonRpcResponse(messages, requestId) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  if (requestId !== undefined && requestId !== null) {
    const match = messages.find(
      (m) =>
        m &&
        typeof m === "object" &&
        "id" in m &&
        m.id === requestId &&
        (m.result !== undefined || m.error !== undefined),
    );
    return match ?? null;
  }
  const response = messages.find(
    (m) =>
      m &&
      typeof m === "object" &&
      (m.result !== undefined || m.error !== undefined),
  );
  return response ?? null;
}

/**
 * Fail closed on JSON-RPC error or MCP result.isError.
 * JSON-RPC errors expose code only (never message / data).
 * @returns {object} result
 */
export function assertJsonRpcSuccess(message, context = "rpc") {
  if (!message || typeof message !== "object") {
    throw new Error(`${context}: missing response`);
  }
  if (message.error != null) {
    const code = message.error?.code;
    throw new Error(`${context}: JSON-RPC error code=${code}`);
  }
  if (message.result == null) {
    throw new Error(`${context}: JSON-RPC response has no result`);
  }
  if (message.result.isError === true) {
    throw new Error(
      `${context}: MCP result.isError=true ${summarizeTopLevelFields(message.result)}`,
    );
  }
  return message.result;
}

/**
 * tools/call success payload must have non-empty content[] or structuredContent.
 * Fail closed otherwise (no body dump).
 */
export function assertToolCallResultShape(result, context = "tools/call") {
  if (!result || typeof result !== "object") {
    throw new Error(`${context}: missing result`);
  }
  if (result.isError === true) {
    throw new Error(
      `${context}: MCP result.isError=true ${summarizeTopLevelFields(result)}`,
    );
  }
  const hasContent =
    Array.isArray(result.content) && result.content.length > 0;
  const hasStructured =
    "structuredContent" in result && result.structuredContent != null;
  if (!hasContent && !hasStructured) {
    throw new Error(
      `${context}: tools/call result requires non-empty content[] or structuredContent`,
    );
  }
  return result;
}

/**
 * Reject any JSON-RPC error objects in a message list (code only, never message/data).
 */
export function assertNoJsonRpcErrors(messages, context = "rpc") {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  for (const message of messages) {
    if (message && typeof message === "object" && message.error != null) {
      const code = message.error?.code;
      throw new Error(`${context}: JSON-RPC error code=${code}`);
    }
  }
}

/** Extract tool name strings from a tools/list result. */
export function extractToolNames(toolsListResult) {
  const tools = toolsListResult?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools/list result.tools must be an array");
  }
  return tools.map((t, i) => {
    if (!t || typeof t.name !== "string" || t.name.length === 0) {
      throw new Error(`tools/list tools[${i}] missing name`);
    }
    return t.name;
  });
}

/**
 * Partition discovered tool names into current plugin, legacy, and other.
 */
export function partitionPluginTools(toolNames, pluginNamespace) {
  const plugin = [];
  const legacy = [];
  const other = [];
  for (const name of toolNames) {
    if (name.startsWith(pluginNamespace)) {
      plugin.push(name);
    } else if (name.startsWith(LEGACY_NAMESPACE)) {
      legacy.push(name);
    } else {
      other.push(name);
    }
  }
  return { plugin, legacy, other };
}

/**
 * Exact-set validation of plugin tools against catalog.
 * @returns {{ expected: string[], actual: string[], missing: string[], extra: string[], legacyCount: number }}
 */
export function validateAgainstCatalog(discoveredNames, catalog) {
  const pluginNamespace = catalog?.namespaces?.plugin;
  if (typeof pluginNamespace !== "string" || !pluginNamespace) {
    throw new Error("catalog.namespaces.plugin is required");
  }
  const bare = catalog?.pluginTools;
  if (!Array.isArray(bare) || bare.length === 0) {
    throw new Error("catalog.pluginTools must be a non-empty array");
  }
  if (bare.length !== EXPECTED_PLUGIN_TOOL_COUNT) {
    throw new Error(
      `catalog.pluginTools.length must be ${EXPECTED_PLUGIN_TOOL_COUNT} (got ${bare.length})`,
    );
  }
  const technicalId = catalog?.product?.technicalId;
  if (typeof technicalId !== "string" || !technicalId) {
    throw new Error("catalog.product.technicalId is required");
  }
  const expected = bare.map((t) => {
    if (!t?.name) {
      throw new Error("catalog pluginTools entry missing name");
    }
    return buildAgentCapabilityToolName(technicalId, t.name);
  });

  const { plugin, legacy } = partitionPluginTools(
    discoveredNames,
    pluginNamespace,
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(plugin);
  const missing = expected.filter((n) => !actualSet.has(n));
  const extra = plugin.filter((n) => !expectedSet.has(n));

  return {
    expected,
    actual: plugin,
    missing,
    extra,
    legacyCount: legacy.length,
    legacyNames: legacy,
    expectedCount: expected.length,
    actualCount: plugin.length,
  };
}

/**
 * Assert catalog validation result: exact match + zero legacy.
 * Throws with a concise message on failure.
 */
export function assertCatalogMatch(validation) {
  const problems = [];
  if (validation.legacyCount !== 0) {
    problems.push(
      `legacy namespace tools=${validation.legacyCount} (expected 0): ${validation.legacyNames?.join(", ") ?? ""}`,
    );
  }
  if (validation.missing.length > 0) {
    problems.push(`missing (${validation.missing.length}): ${validation.missing.join(", ")}`);
  }
  if (validation.extra.length > 0) {
    problems.push(`extra (${validation.extra.length}): ${validation.extra.join(", ")}`);
  }
  if (validation.actualCount !== validation.expectedCount) {
    problems.push(
      `count actual=${validation.actualCount} expected=${validation.expectedCount}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`catalog mismatch: ${problems.join("; ")}`);
  }
}

/**
 * Safe summary for tool results / logging:
 * isError, structuredContent presence, top-level keys, top-level array names+counts.
 * Never dumps nested content, array elements, or scalar field values.
 */
export function summarizeTopLevelFields(value) {
  if (value === null || value === undefined) {
    return "value=null";
  }
  if (Array.isArray(value)) {
    return `type=array length=${value.length}`;
  }
  if (typeof value !== "object") {
    return `type=${typeof value}`;
  }
  const keys = Object.keys(value).sort();
  const bits = [];
  if ("isError" in value) {
    bits.push(`isError=${value.isError}`);
  }
  bits.push(
    `structuredContent=${
      "structuredContent" in value && value.structuredContent != null
        ? "present"
        : "absent"
    }`,
  );
  for (const k of keys) {
    if (Array.isArray(value[k])) {
      bits.push(`${k}.length=${value[k].length}`);
    }
  }
  return `${bits.join(" ")} topLevelKeys=[${keys.join(", ")}]`;
}

/**
 * Count tools by namespace for status reporting.
 */
export function countToolNamespaces(toolNames, pluginNamespace) {
  const { plugin, legacy, other } = partitionPluginTools(
    toolNames,
    pluginNamespace,
  );
  return {
    total: toolNames.length,
    plugin: plugin.length,
    legacy: legacy.length,
    other: other.length,
  };
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function sessionHeaderName(headers) {
  // Fetch Headers are case-insensitive; try common casings.
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  return (
    headers.get("mcp-session-id") ||
    headers.get("Mcp-Session-Id") ||
    headers.get("MCP-Session-Id") ||
    null
  );
}

/**
 * One MCP HTTP POST. Fail closed on non-2xx.
 * HTTP errors: status, content-type, bodyLength only (never body text).
 * Timeout covers fetch + response.text(); fixed message only (never raw error / URL / token / body).
 * Non-timeout network failures: fixed "MCP HTTP request failed" only (never err.message / URL / token / body).
 * Does not return bodyText or raw headers.
 * @returns {Promise<{ status: number, messages: object[], sessionId: string|null, contentType: string }>}
 */
export async function mcpPost({
  url,
  token,
  body,
  sessionId,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available; Node >= 18 with built-in fetch required");
  }
  assertLoopbackUrl(url);

  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    Authorization: `Token ${token}`,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const ms =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  const isAbortError = (err) =>
    controller.signal.aborted ||
    err?.name === "AbortError" ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError");

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`MCP HTTP request timed out after ${ms}ms`);
      }
      throw new Error("MCP HTTP request failed");
    }

    const status = response.status;
    let bodyText;
    try {
      bodyText = await response.text();
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`MCP HTTP request timed out after ${ms}ms`);
      }
      throw new Error("MCP HTTP request failed");
    }

    const contentType = response.headers.get("content-type") ?? "";
    const newSession =
      sessionHeaderName(response.headers) || sessionId || null;

    if (status < 200 || status >= 300) {
      throw new Error(
        `MCP HTTP ${status}: content-type=${contentType || "unknown"} bodyLength=${bodyText.length}`,
      );
    }

    const { messages, contentType: parsedType } = parseMcpHttpBody(
      bodyText,
      contentType,
    );

    return {
      status,
      messages,
      sessionId: newSession,
      contentType: parsedType,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Load catalog JSON from disk (or inject for tests).
 */
export async function loadCatalog(filePath = catalogPath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * Run discovery smoke (and optional read smoke).
 *
 * @param {object} options
 * @param {string} options.token - SIYUAN_API_TOKEN
 * @param {string} [options.url]
 * @param {boolean} [options.readSmoke]
 * @param {object} [options.catalog]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs] - per-request timeout (default 10000)
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<object>} summary (no secrets)
 */
export async function runMcpSmoke(options) {
  const token = options?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("SIYUAN_API_TOKEN is required (not printed)");
  }
  const url = assertLoopbackUrl(options.url ?? DEFAULT_MCP_URL).toString();
  const log = options.log ?? ((line) => console.log(line));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const catalog = options.catalog ?? (await loadCatalog());
  const pluginNamespace = catalog.namespaces.plugin;
  const technicalId = catalog?.product?.technicalId;
  if (typeof technicalId !== "string" || !technicalId) {
    throw new Error("catalog.product.technicalId is required");
  }
  const readSmokeTools = [
    buildAgentCapabilityToolName(technicalId, "get_policy"),
    buildAgentCapabilityToolName(technicalId, "list_accessible_notebooks"),
  ];

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
  // Strict protocolVersion: must equal current PROTOCOL_VERSION; fixed errors only (never echo raw value/response)
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
      "SiYuan MCP smoke prerequisite: initialize response missing Mcp-Session-Id",
    );
  }
  // session=yes only — never log the session id value
  log(
    `initialize ok http=${initRes.status} session=yes protocol=${PROTOCOL_VERSION} ${summarizeTopLevelFields(initResult)}`,
  );

  // 2) notifications/initialized (SiYuan: strictly HTTP 202 + empty messages)
  // params: {}; prefer JSON-RPC error code-only; non-error non-empty → fixed error; other 2xx → fail
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
  assertNoJsonRpcErrors(
    initializedRes.messages,
    "notifications/initialized",
  );
  if (initializedRes.status !== 202) {
    throw new Error(
      `notifications/initialized: expected HTTP 202 (got ${initializedRes.status})`,
    );
  }
  if (initializedRes.messages.length !== 0) {
    throw new Error(
      "notifications/initialized: expected empty messages",
    );
  }
  log(
    `initialized notification sent http=${initializedRes.status} messages=${initializedRes.messages.length}`,
  );

  // 3) tools/list
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
    `tools/list ok http=${listRes.status} total=${counts.total} plugin=${counts.plugin} legacy=${counts.legacy} other=${counts.other}`,
  );

  const validation = validateAgainstCatalog(toolNames, catalog);
  assertCatalogMatch(validation);
  log(
    `catalog match ok expected=${validation.expectedCount} actual=${validation.actualCount} legacy=0`,
  );

  const summary = {
    ok: true,
    url: assertLoopbackUrl(url).origin + new URL(url).pathname,
    protocolVersion: PROTOCOL_VERSION,
    session: true,
    counts,
    catalog: {
      expected: validation.expectedCount,
      actual: validation.actualCount,
      legacy: 0,
    },
    toolNames: validation.actual,
  };

  // 4) optional --read-smoke: get_policy then list_accessible_notebooks
  //    print only isError / structuredContent / top-level keys / array counts
  if (options.readSmoke) {
    const calls = [];
    for (const toolName of readSmokeTools) {
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
            arguments: {},
          },
        },
      });
      const callMsg = pickJsonRpcResponse(callRes.messages, callId);
      const callResult = assertJsonRpcSuccess(
        callMsg,
        `tools/call ${toolName}`,
      );
      assertToolCallResultShape(callResult, `tools/call ${toolName}`);
      const fieldSummary = summarizeTopLevelFields(callResult);
      log(
        `read-smoke ok tool=${toolName} http=${callRes.status} ${fieldSummary}`,
      );
      calls.push({
        tool: toolName,
        httpStatus: callRes.status,
        summary: fieldSummary,
      });
    }
    summary.readSmoke = { tools: calls };
  }

  log("mcp-smoke PASS");
  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse CLI argv. Fail closed on unknown flags or missing --url value.
 */
export function parseCliArgs(argv) {
  const args = { readSmoke: false, url: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--read-smoke") {
      args.readSmoke = true;
    } else if (a === "--url") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--url requires a value");
      }
      args.url = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a.startsWith("--url=")) {
      const value = a.slice("--url=".length);
      if (!value) {
        throw new Error("--url requires a value");
      }
      args.url = value;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(log = console.log) {
  log(`Usage: node scripts/mcp-smoke.mjs [--read-smoke] [--url URL]

Raw MCP discovery smoke (MCP ${PROTOCOL_VERSION}).
  initialize → session → initialized → tools/list
  optional --read-smoke: tools/call get_policy then list_accessible_notebooks
    (isError / structuredContent / top-level keys / array counts only)

Environment:
  SIYUAN_API_TOKEN   required; never printed
  SIYUAN_MCP_URL     optional; default ${DEFAULT_MCP_URL} (loopback only)

Exit codes:
  0  catalog match (and optional read-smoke ok)
  1  any HTTP / JSON-RPC / isError / catalog / loopback / CLI failure
`);
}

/**
 * CLI entry. Sets process.exitCode and returns (does not call process.exit)
 * so Node can drain handles cleanly — avoids Windows libuv UV_HANDLE_CLOSING
 * asserts after async fetch on some Node builds (e.g. v25.8.1).
 *
 * @param {string[]} argv
 * @param {object} [deps] - injectable for tests; never logs token values
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {typeof runMcpSmoke} [deps.run]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.error]
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runMcpSmoke;
  const log = deps.log ?? console.log.bind(console);
  const error = deps.error ?? console.error.bind(console);

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    error(`mcp-smoke FAIL: ${err?.message ?? err}`);
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
      readSmoke: args.readSmoke,
    });
    process.exitCode = 0;
  } catch (err) {
    const msg = redactSecrets(err?.message ?? err, token);
    error(`mcp-smoke FAIL: ${msg}`);
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
