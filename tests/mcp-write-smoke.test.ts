import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_POSSIBLY_CREATED_SIGNAL,
  assertCreateResultMatch,
  assertDeleted,
  assertNotebookAccessible,
  assertPluginDirectStructuredContent,
  assertPluginOkEnvelope,
  assertReadContainsMarker,
  assertReadVisibleMatch,
  assertSiyuanId,
  assertUpdateCommitted,
  assertWriteOpsPermitted,
  buildLifecycleArgs,
  DEFAULT_VISIBILITY_DELAY_MS,
  DEFAULT_VISIBILITY_MAX_ATTEMPTS,
  generateSmokeIdentity,
  isSiyuanId,
  main,
  parseCliArgs,
  parseVisibilityReadEnvelope,
  runMcpWriteSmoke,
  SIYUAN_ID_PATTERN,
  VISIBILITY_TIMEOUT_MESSAGE,
} from "../scripts/mcp-write-smoke.mjs";

const PLUGIN_NS = "plugin__siyuanmaster__";
const PROTOCOL_VERSION = "2025-03-26";

const CATALOG_19 = {
  namespaces: { plugin: PLUGIN_NS },
  pluginTools: [
    "get_policy",
    "list_accessible_notebooks",
    "list_document_tree",
    "search_notes",
    "read_note",
    "resolve_document",
    "read_note_segments",
    "create_note",
    "append_note",
    "update_note",
    "edit_block",
    "rename_note",
    "move_note",
    "delete_note",
    "suggest_tags",
    "apply_tags",
    "prepare_summary",
    "save_memory",
    "get_audit_log",
  ].map((name) => ({
    name,
    category: "x",
    readOnly: true,
    confirmDefault: false,
  })),
};

const FQ_19 = CATALOG_19.pluginTools.map((t) => `${PLUGIN_NS}${t.name}`);

// Strict SiYuan ids: /^\d{14}-[a-z0-9]{7}$/ (7-char suffix)
const NOTEBOOK_ID = "20240101120000-nbok001";
const DOC_ID = "20240101120100-docsmok";
const INVALID_DOC_ID = "20240101120100-toolong1"; // 8-char suffix — not valid
const TITLE = "mcp-write-smoke-fixed-title";
const BODY_MARKER = "mcp-write-smoke-marker-fixed";
const TOKEN = "write-smoke-test-token-value-abcdefgh";
const URL = "http://127.0.0.1:6806/mcp";
const SESSION = "write-smoke-session-1";

function mockHeaders(map: Record<string, string | null> = {}) {
  return {
    get(name: string) {
      const key = name.toLowerCase();
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === key) {
          return v;
        }
      }
      return null;
    },
  };
}

function jsonResponse(
  body: unknown,
  opts: { status?: number; sessionId?: string | null; contentType?: string } = {},
) {
  const status = opts.status ?? 200;
  const headers = mockHeaders({
    "content-type": opts.contentType ?? "application/json",
    ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
  });
  return {
    status,
    headers,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  };
}

function okEnvelope(result: Record<string, unknown>) {
  return {
    isError: false,
    content: [{ type: "text", text: "DO_NOT_PARSE_CONTENT_TEXT_SECRET" }],
    structuredContent: { ok: true, result },
  };
}

/** Real get_policy shape: structuredContent is the policy object directly. */
function directPolicyContent(operations: Record<string, string>) {
  return {
    isError: false,
    content: [{ type: "text", text: "DO_NOT_PARSE_CONTENT_TEXT_SECRET" }],
    structuredContent: {
      product: {
        brand: "siyuanmaster",
        technicalId: "siyuanmaster",
        namespace: "plugin__siyuanmaster__",
      },
      operations,
      access: { mode: "allowlist", selectedNotebookIds: [NOTEBOOK_ID] },
      tagging: { mode: "off" },
      safety: {},
    },
  };
}

function toolCallResponse(id: number, result: unknown) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result,
  });
}

type Capture = {
  methods: string[];
  toolNames: string[];
  toolArgs: unknown[];
  bodies: unknown[];
  urls: string[];
  headerSnapshots: Array<Record<string, string | undefined>>;
};

type WriteFetchOpts = {
  sessionId?: string | null;
  capture?: Capture;
  operations?: Record<string, string>;
  notebooks?: Array<{ id: string; name?: string }> | "omit" | "not-array";
  /**
   * get_policy structuredContent modes (default = real direct policy object).
   * "enveloped" returns runTool shape so ops cannot be misread as policy.
   */
  policyShape?:
    | "direct"
    | "enveloped"
    | "missing"
    | "array"
    | "null"
    | "text-only"
    | "is-error"
    | "ok-false-envelope"
    | "malformed";
  /** @deprecated use policyShape; kept for older call sites during migration */
  policyEnvelope?:
    | "ok"
    | "missing"
    | "ok-false"
    | "malformed"
    | "text-only"
    | "enveloped"
    | "array"
    | "null"
    | "is-error";
  listEnvelope?: "ok" | "missing" | "ok-false" | "malformed" | "text-only";
  createResult?:
    | "ok"
    | "missing-doc"
    | "invalid-doc-id"
    | "notebook-mismatch"
    | "title-mismatch"
    | "ok-false"
    | "malformed"
    | "text-only"
    | "missing-envelope"
    | "timeout"
    | "transport-fail";
  updateResult?:
    | "ok"
    | "txn-not-committed"
    | "verified-false"
    | "ok-false"
    | "malformed";
  /**
   * Post-update verification read_note only (after update has been called).
   * Readiness (pre-update) uses visibility* options.
   */
  readResult?: "ok" | "missing-marker" | "no-content" | "ok-false";
  deleteResult?: "ok" | "not-deleted" | "ok-false" | "fail-once-then-ok";
  /** Fail a specific bare tool name after create with envelope error */
  failTool?: string | null;
  /** After how many delete_note calls should cleanup fail (for fail-once) */
  deleteFailCount?: number;
  /**
   * Pre-update visibility read_note: first N calls return {ok:false}
   * (not-yet-visible), then succeed. Default 0 (immediate visibility).
   */
  visibilityFailCount?: number;
  /** Pre-update visibility reads always return {ok:false} (timeout path). */
  visibilityNever?: boolean;
  /**
   * Pre-update visibility envelope mode on the first readiness read.
   * "ok-false" is also treated as not-yet-visible (same as visibilityNever
   * when combined with maxAttempts).
   */
  visibilityResult?:
    | "ok"
    | "ok-false"
    | "malformed"
    | "text-only"
    | "missing"
    | "mismatch-doc"
    | "mismatch-notebook"
    | "mismatch-title"
    | "missing-marker";
};

function makeWriteFetch(opts: WriteFetchOpts = {}) {
  const sessionId = opts.sessionId === undefined ? SESSION : opts.sessionId;
  const capture = opts.capture;
  const operations = opts.operations ?? {
    create: "allow",
    update: "confirm",
    read: "allow",
    delete: "confirm",
    append: "allow",
  };
  const notebooks =
    opts.notebooks === undefined
      ? [{ id: NOTEBOOK_ID, name: "Disposable Secret Notebook" }]
      : opts.notebooks;

  let deleteCalls = 0;
  let updateCalled = false;
  let visibilityReadCount = 0;

  const visibilitySuccessResult = (): Record<string, unknown> => ({
    documentId: DOC_ID,
    notebookId: NOTEBOOK_ID,
    title: TITLE,
    content: `# mcp-write-smoke\n\n${BODY_MARKER}\n`,
  });

  return async (url: string, init?: RequestInit) => {
    capture?.urls.push(String(url));
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const normalized: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      normalized[k.toLowerCase()] = v;
    }
    capture?.headerSnapshots.push(normalized);

    const body = JSON.parse(String(init?.body ?? "{}"));
    capture?.bodies.push(body);
    capture?.methods.push(body.method);

    if (body.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
          },
        },
        { sessionId },
      );
    }
    if (body.method === "notifications/initialized") {
      return jsonResponse("", { status: 202, contentType: "text/plain" });
    }
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: FQ_19.map((name) => ({ name })) },
      });
    }
    if (body.method === "tools/call") {
      const tool = String(body.params?.name ?? "");
      const bare = tool.startsWith(PLUGIN_NS)
        ? tool.slice(PLUGIN_NS.length)
        : tool;
      capture?.toolNames.push(tool);
      capture?.toolArgs.push(body.params?.arguments ?? {});

      const envelopeMode = (mode: string | undefined, okResult: Record<string, unknown>) => {
        if (mode === "missing" || mode === "missing-envelope") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "TEXT_ONLY_SHOULD_NOT_BE_USED" }],
          });
        }
        if (mode === "text-only") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, result: okResult }),
              },
            ],
          });
        }
        if (mode === "ok-false") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "err" }],
            structuredContent: {
              ok: false,
              error: { code: "denied", message: "SECRET_ERROR_DO_NOT_ECHO" },
            },
          });
        }
        if (mode === "malformed") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "x" }],
            structuredContent: { ok: true, result: "not-an-object" },
          });
        }
        return toolCallResponse(body.id, okEnvelope(okResult));
      };

      if (bare === "get_policy") {
        // Map legacy policyEnvelope aliases → policyShape
        const shape =
          opts.policyShape ??
          (opts.policyEnvelope === "ok"
            ? "direct"
            : opts.policyEnvelope === "ok-false"
              ? "ok-false-envelope"
              : opts.policyEnvelope) ??
          "direct";

        if (shape === "missing") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "TEXT_ONLY_SHOULD_NOT_BE_USED" }],
          });
        }
        if (shape === "text-only") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  operations,
                  access: { mode: "allowlist" },
                }),
              },
            ],
          });
        }
        if (shape === "array") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "x" }],
            structuredContent: [{ operations }],
          });
        }
        if (shape === "null") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "x" }],
            structuredContent: null,
          });
        }
        if (shape === "malformed") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "x" }],
            structuredContent: "not-an-object",
          });
        }
        if (shape === "is-error") {
          return toolCallResponse(body.id, {
            isError: true,
            content: [{ type: "text", text: "tool failed" }],
            structuredContent: directPolicyContent(operations).structuredContent,
          });
        }
        if (shape === "enveloped") {
          // Wrong contract: runTool envelope must not be accepted as policy.
          return toolCallResponse(
            body.id,
            okEnvelope({
              operations,
              access: { mode: "allowlist", selectedNotebookIds: [NOTEBOOK_ID] },
              tagging: { mode: "off" },
            }),
          );
        }
        if (shape === "ok-false-envelope") {
          return toolCallResponse(body.id, {
            isError: false,
            content: [{ type: "text", text: "err" }],
            structuredContent: {
              ok: false,
              error: { code: "denied", message: "SECRET_ERROR_DO_NOT_ECHO" },
            },
          });
        }
        // Default / "direct": real kernel get_policy shape
        return toolCallResponse(body.id, directPolicyContent(operations));
      }
      if (bare === "list_accessible_notebooks") {
        if (opts.listEnvelope && opts.listEnvelope !== "ok") {
          return envelopeMode(opts.listEnvelope, {
            notebooks: [{ id: NOTEBOOK_ID }],
          });
        }
        let listResult: Record<string, unknown>;
        if (notebooks === "omit") {
          listResult = {};
        } else if (notebooks === "not-array") {
          listResult = { notebooks: { id: NOTEBOOK_ID } };
        } else {
          listResult = { notebooks };
        }
        return toolCallResponse(body.id, okEnvelope(listResult));
      }
      if (bare === "create_note") {
        if (opts.createResult === "timeout") {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        if (opts.createResult === "transport-fail") {
          throw new Error("ECONNREFUSED secret-host:6806");
        }
        if (opts.createResult === "ok-false") {
          return envelopeMode("ok-false", {});
        }
        if (opts.createResult === "malformed") {
          return envelopeMode("malformed", {});
        }
        if (opts.createResult === "text-only" || opts.createResult === "missing-envelope") {
          return envelopeMode(opts.createResult, {
            documentId: DOC_ID,
            notebookId: NOTEBOOK_ID,
            title: TITLE,
          });
        }
        if (opts.createResult === "missing-doc") {
          return toolCallResponse(
            body.id,
            okEnvelope({
              documentId: "",
              notebookId: NOTEBOOK_ID,
              title: TITLE,
            }),
          );
        }
        if (opts.createResult === "invalid-doc-id") {
          return toolCallResponse(
            body.id,
            okEnvelope({
              documentId: INVALID_DOC_ID,
              notebookId: NOTEBOOK_ID,
              title: TITLE,
            }),
          );
        }
        if (opts.createResult === "notebook-mismatch") {
          return toolCallResponse(
            body.id,
            okEnvelope({
              documentId: DOC_ID,
              notebookId: "20240101999999-wrongnb",
              title: TITLE,
            }),
          );
        }
        if (opts.createResult === "title-mismatch") {
          return toolCallResponse(
            body.id,
            okEnvelope({
              documentId: DOC_ID,
              notebookId: NOTEBOOK_ID,
              title: "wrong-title-should-fail",
            }),
          );
        }
        return toolCallResponse(
          body.id,
          okEnvelope({
            documentId: DOC_ID,
            notebookId: NOTEBOOK_ID,
            title: TITLE,
          }),
        );
      }
      if (bare === "update_note") {
        updateCalled = true;
        if (opts.failTool === "update_note") {
          return envelopeMode("ok-false", {});
        }
        if (opts.updateResult === "ok-false") {
          return envelopeMode("ok-false", {});
        }
        if (opts.updateResult === "malformed") {
          return envelopeMode("malformed", {});
        }
        if (opts.updateResult === "txn-not-committed") {
          return toolCallResponse(
            body.id,
            okEnvelope({ txnState: "failed", verified: true }),
          );
        }
        if (opts.updateResult === "verified-false") {
          return toolCallResponse(
            body.id,
            okEnvelope({ txnState: "committed", verified: false }),
          );
        }
        return toolCallResponse(
          body.id,
          okEnvelope({
            documentId: DOC_ID,
            txnState: "committed",
            verified: true,
          }),
        );
      }
      if (bare === "read_note") {
        // Pre-update: readiness / visibility poll only (create→index wait).
        if (!updateCalled) {
          visibilityReadCount += 1;
          const mode = opts.visibilityResult;
          if (mode === "malformed" || mode === "text-only" || mode === "missing") {
            return envelopeMode(mode, visibilitySuccessResult());
          }
          if (mode === "mismatch-doc") {
            return toolCallResponse(
              body.id,
              okEnvelope({
                ...visibilitySuccessResult(),
                documentId: "20240101999999-wrongid",
              }),
            );
          }
          if (mode === "mismatch-notebook") {
            return toolCallResponse(
              body.id,
              okEnvelope({
                ...visibilitySuccessResult(),
                notebookId: "20240101999999-wrongnb",
              }),
            );
          }
          if (mode === "mismatch-title") {
            return toolCallResponse(
              body.id,
              okEnvelope({
                ...visibilitySuccessResult(),
                title: "wrong-title-should-fail",
              }),
            );
          }
          if (mode === "missing-marker") {
            return toolCallResponse(
              body.id,
              okEnvelope({
                documentId: DOC_ID,
                notebookId: NOTEBOOK_ID,
                title: TITLE,
                content: "# mcp-write-smoke\n\nno marker here\n",
              }),
            );
          }
          if (
            opts.visibilityNever === true ||
            mode === "ok-false" ||
            (typeof opts.visibilityFailCount === "number" &&
              visibilityReadCount <= opts.visibilityFailCount)
          ) {
            return envelopeMode("ok-false", {});
          }
          return toolCallResponse(body.id, okEnvelope(visibilitySuccessResult()));
        }

        // Post-update verification read
        if (opts.failTool === "read_note") {
          return envelopeMode("ok-false", {});
        }
        if (opts.readResult === "ok-false") {
          return envelopeMode("ok-false", {});
        }
        if (opts.readResult === "missing-marker") {
          return toolCallResponse(
            body.id,
            okEnvelope({
              documentId: DOC_ID,
              notebookId: NOTEBOOK_ID,
              title: TITLE,
              content: "# mcp-write-smoke\n\nno marker here\n",
            }),
          );
        }
        if (opts.readResult === "no-content") {
          return toolCallResponse(body.id, okEnvelope({ documentId: DOC_ID }));
        }
        return toolCallResponse(
          body.id,
          okEnvelope({
            content: `# mcp-write-smoke\n\n${BODY_MARKER}\n\nupdated\n`,
            documentId: DOC_ID,
            notebookId: NOTEBOOK_ID,
            title: TITLE,
          }),
        );
      }
      if (bare === "delete_note") {
        deleteCalls += 1;
        if (opts.failTool === "delete_note" && deleteCalls === 1) {
          // lifecycle delete fails → cleanup may run if created
          return envelopeMode("ok-false", {});
        }
        if (opts.deleteResult === "fail-once-then-ok") {
          if (deleteCalls === 1) {
            return envelopeMode("ok-false", {});
          }
          return toolCallResponse(body.id, okEnvelope({ deleted: true }));
        }
        if (opts.deleteResult === "ok-false") {
          return envelopeMode("ok-false", {});
        }
        if (opts.deleteResult === "not-deleted") {
          return toolCallResponse(body.id, okEnvelope({ deleted: false }));
        }
        return toolCallResponse(body.id, okEnvelope({ deleted: true }));
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unknown tool ${tool}` },
      });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32601, message: `unknown method ${body.method}` },
    });
  };
}

/** Fast deterministic visibility wait for unit tests (no real wall-clock delay). */
const FAST_VISIBILITY = {
  visibilityMaxAttempts: 5,
  visibilityDelayMs: 0,
  sleep: async () => {},
};

async function runWrite(
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
) {
  const logs: string[] = [];
  const result = await runMcpWriteSmoke({
    token: TOKEN,
    url: URL,
    notebookId: NOTEBOOK_ID,
    confirmDestructiveSmoke: true,
    catalog: CATALOG_19,
    fetchImpl,
    log: (line: string) => logs.push(line),
    identityFactory: () => ({ title: TITLE, bodyMarker: BODY_MARKER }),
    ...FAST_VISIBILITY,
    ...overrides,
  });
  return { result, logs };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("mcp-write-smoke pure helpers", () => {
  it("isSiyuanId / assertSiyuanId enforce /^\d{14}-[a-z0-9]{7}$/", () => {
    expect(SIYUAN_ID_PATTERN.test(NOTEBOOK_ID)).toBe(true);
    expect(isSiyuanId(NOTEBOOK_ID)).toBe(true);
    expect(isSiyuanId(DOC_ID)).toBe(true);
    expect(isSiyuanId("20240101120000-notebook1")).toBe(false); // 9-char suffix
    expect(isSiyuanId(INVALID_DOC_ID)).toBe(false);
    expect(isSiyuanId("not-an-id")).toBe(false);
    expect(isSiyuanId("")).toBe(false);
    expect(isSiyuanId(null)).toBe(false);
    expect(assertSiyuanId(DOC_ID, "documentId")).toBe(DOC_ID);
    expect(() => assertSiyuanId("bad", "notebookId")).toThrow(
      /invalid SiYuan id format/,
    );
  });

  it("assertPluginDirectStructuredContent requires plain SC object; never content.text", () => {
    const textOnly = {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            operations: { create: "allow" },
          }),
        },
      ],
    };
    expect(() => assertPluginDirectStructuredContent(textOnly)).toThrow(
      /missing or malformed structuredContent/,
    );

    expect(() =>
      assertPluginDirectStructuredContent({
        isError: true,
        structuredContent: { operations: { create: "allow" } },
      }),
    ).toThrow(/isError=true/);

    expect(() =>
      assertPluginDirectStructuredContent({
        isError: false,
        structuredContent: null,
      }),
    ).toThrow(/missing or malformed structuredContent/);

    expect(() =>
      assertPluginDirectStructuredContent({
        isError: false,
        structuredContent: [{ operations: {} }],
      }),
    ).toThrow(/missing or malformed structuredContent/);

    expect(() =>
      assertPluginDirectStructuredContent({
        isError: false,
        structuredContent: "not-object",
      }),
    ).toThrow(/missing or malformed structuredContent/);

    expect(() =>
      assertPluginDirectStructuredContent({
        isError: false,
        content: [{ type: "text", text: "ignored" }],
      }),
    ).toThrow(/missing or malformed structuredContent/);

    const policy = assertPluginDirectStructuredContent({
      isError: false,
      content: [{ type: "text", text: "ignored" }],
      structuredContent: {
        product: { brand: "siyuanmaster" },
        operations: { create: "allow", update: "allow", read: "allow", delete: "allow" },
      },
    });
    expect(policy).toMatchObject({ product: { brand: "siyuanmaster" } });
    // Direct extractor does not unwrap envelopes; enveloped SC is returned as-is
    // (callers then fail policy validation — operations missing on envelope root).
    const enveloped = assertPluginDirectStructuredContent({
      isError: false,
      structuredContent: {
        ok: true,
        result: {
          operations: {
            create: "allow",
            update: "allow",
            read: "allow",
            delete: "allow",
          },
        },
      },
    });
    expect(enveloped).toMatchObject({ ok: true });
    expect(enveloped.operations).toBeUndefined();
  });

  it("assertPluginOkEnvelope requires {ok:true,result:object} and never uses content.text", () => {
    const textOnly = {
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: { documentId: "from-text" },
          }),
        },
      ],
    };
    expect(() => assertPluginOkEnvelope(textOnly)).toThrow(
      /missing or malformed structuredContent/,
    );

    expect(() =>
      assertPluginOkEnvelope({
        isError: false,
        structuredContent: { ok: false, error: { code: "x" } },
      }),
    ).toThrow(/ok=false/);

    expect(() =>
      assertPluginOkEnvelope({
        isError: false,
        structuredContent: { ok: true, result: null },
      }),
    ).toThrow(/result must be an object/);

    expect(() =>
      assertPluginOkEnvelope({
        isError: false,
        structuredContent: { ok: true, result: [1] },
      }),
    ).toThrow(/result must be an object/);

    // Direct policy shape is NOT a valid runTool envelope
    expect(() =>
      assertPluginOkEnvelope({
        isError: false,
        structuredContent: {
          product: { brand: "siyuanmaster" },
          operations: { create: "allow" },
        },
      }),
    ).toThrow(/missing or malformed structuredContent envelope/);

    const ok = assertPluginOkEnvelope({
      isError: false,
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { ok: true, result: { a: 1 } },
    });
    expect(ok).toEqual({ a: 1 });
  });

  it("assertWriteOpsPermitted refuses delete deny and other deny", () => {
    expect(() =>
      assertWriteOpsPermitted({
        create: "allow",
        update: "allow",
        read: "allow",
        delete: "deny",
      }),
    ).toThrow(/operations\.delete is deny/);

    expect(() =>
      assertWriteOpsPermitted({
        create: "deny",
        update: "allow",
        read: "allow",
        delete: "allow",
      }),
    ).toThrow(/operations\.create is deny/);

    expect(() =>
      assertWriteOpsPermitted({
        create: "allow",
        update: "confirm",
        read: "allow",
        delete: "confirm",
      }),
    ).not.toThrow();
  });

  it("assertNotebookAccessible matches id only", () => {
    expect(() =>
      assertNotebookAccessible(
        { notebooks: [{ id: "other" }] },
        NOTEBOOK_ID,
      ),
    ).toThrow(/not accessible/);

    expect(() =>
      assertNotebookAccessible(
        { notebooks: [{ id: NOTEBOOK_ID, name: "Secret" }] },
        NOTEBOOK_ID,
      ),
    ).not.toThrow();

    expect(() =>
      assertNotebookAccessible({ notebooks: "nope" as never }, NOTEBOOK_ID),
    ).toThrow(/must be an array/);
  });

  it("buildLifecycleArgs uses exact tagging skip + tags [] on create and update", () => {
    const args = buildLifecycleArgs({
      notebookId: NOTEBOOK_ID,
      title: TITLE,
      bodyMarker: BODY_MARKER,
      documentId: DOC_ID,
    });
    expect(args.create.tagging).toEqual({ decision: "skip", tags: [] });
    expect(args.create).toMatchObject({
      notebookId: NOTEBOOK_ID,
      title: TITLE,
      confirmed: true,
    });
    expect(args.create.markdown).toContain(BODY_MARKER);
    expect(args.update).toEqual({
      documentId: DOC_ID,
      markdown: `# mcp-write-smoke\n\n${BODY_MARKER}\n\nupdated\n`,
      tagging: { decision: "skip", tags: [] },
      confirmed: true,
    });
    expect(args.update.tagging).toEqual({ decision: "skip", tags: [] });
    expect(args.read).toEqual({ documentId: DOC_ID, confirmed: true });
    expect(args.delete).toEqual({
      documentId: DOC_ID,
      expectedTitle: TITLE,
      confirmed: true,
    });
  });

  it("assertCreateResultMatch requires valid SiYuan documentId and exact notebookId/title", () => {
    expect(() =>
      assertCreateResultMatch(
        { documentId: "", notebookId: NOTEBOOK_ID, title: TITLE },
        { notebookId: NOTEBOOK_ID, title: TITLE },
      ),
    ).toThrow(/documentId missing/);

    expect(() =>
      assertCreateResultMatch(
        {
          documentId: INVALID_DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
        },
        { notebookId: NOTEBOOK_ID, title: TITLE },
      ),
    ).toThrow(/documentId invalid format/);

    expect(() =>
      assertCreateResultMatch(
        {
          documentId: DOC_ID,
          notebookId: "wrong",
          title: TITLE,
        },
        { notebookId: NOTEBOOK_ID, title: TITLE },
      ),
    ).toThrow(/notebookId mismatch/);

    expect(() =>
      assertCreateResultMatch(
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: "other",
        },
        { notebookId: NOTEBOOK_ID, title: TITLE },
      ),
    ).toThrow(/title mismatch/);

    expect(
      assertCreateResultMatch(
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
        },
        { notebookId: NOTEBOOK_ID, title: TITLE },
      ),
    ).toBe(DOC_ID);
  });

  it("assertUpdateCommitted requires txnState committed and verified true", () => {
    expect(() =>
      assertUpdateCommitted({ txnState: "failed", verified: true }),
    ).toThrow(/txnState is not committed/);
    expect(() =>
      assertUpdateCommitted({ txnState: "committed", verified: false }),
    ).toThrow(/verified is not true/);
    expect(() =>
      assertUpdateCommitted({ txnState: "committed", verified: true }),
    ).not.toThrow();
  });

  it("assertReadContainsMarker checks content string", () => {
    expect(() =>
      assertReadContainsMarker({ content: "nope" }, BODY_MARKER),
    ).toThrow(/body marker not found/);
    expect(() =>
      assertReadContainsMarker({ content: `x ${BODY_MARKER} y` }, BODY_MARKER),
    ).not.toThrow();
    expect(() => assertReadContainsMarker({}, BODY_MARKER)).toThrow(
      /content missing/,
    );
  });

  it("parseVisibilityReadEnvelope: ok=false is not_yet_visible; malformed hard fails", () => {
    expect(
      parseVisibilityReadEnvelope({
        isError: false,
        content: [{ type: "text", text: "SECRET_ERROR_DO_NOT_ECHO" }],
        structuredContent: {
          ok: false,
          error: { code: "x", message: "SECRET_ERROR_DO_NOT_ECHO" },
        },
      }),
    ).toEqual({ status: "not_yet_visible" });

    expect(() =>
      parseVisibilityReadEnvelope({
        isError: false,
        content: [{ type: "text", text: "TEXT_ONLY" }],
      }),
    ).toThrow(/missing or malformed structuredContent/);

    expect(() =>
      parseVisibilityReadEnvelope({
        isError: false,
        structuredContent: { ok: true, result: "not-object" },
      }),
    ).toThrow(/result must be an object/);

    expect(() =>
      parseVisibilityReadEnvelope({
        isError: false,
        structuredContent: { product: { brand: "x" } },
      }),
    ).toThrow(/missing or malformed structuredContent envelope/);

    expect(() =>
      parseVisibilityReadEnvelope({
        isError: true,
        structuredContent: { ok: true, result: { documentId: DOC_ID } },
      }),
    ).toThrow(/isError=true/);

    const visible = parseVisibilityReadEnvelope({
      isError: false,
      content: [{ type: "text", text: "ignored" }],
      structuredContent: {
        ok: true,
        result: {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
          content: BODY_MARKER,
        },
      },
    });
    expect(visible.status).toBe("visible");
    if (visible.status === "visible") {
      expect(visible.result.documentId).toBe(DOC_ID);
    }
  });

  it("assertReadVisibleMatch requires documentId/notebookId/title + marker", () => {
    const good = {
      documentId: DOC_ID,
      notebookId: NOTEBOOK_ID,
      title: TITLE,
      content: `prefix ${BODY_MARKER} suffix`,
    };
    expect(() =>
      assertReadVisibleMatch(good, {
        documentId: DOC_ID,
        notebookId: NOTEBOOK_ID,
        title: TITLE,
        bodyMarker: BODY_MARKER,
      }),
    ).not.toThrow();

    expect(() =>
      assertReadVisibleMatch(
        { ...good, documentId: "20240101999999-wrongid" },
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
          bodyMarker: BODY_MARKER,
        },
      ),
    ).toThrow(/documentId mismatch/);

    expect(() =>
      assertReadVisibleMatch(
        { ...good, notebookId: "20240101999999-wrongnb" },
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
          bodyMarker: BODY_MARKER,
        },
      ),
    ).toThrow(/notebookId mismatch/);

    expect(() =>
      assertReadVisibleMatch(
        { ...good, title: "other" },
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
          bodyMarker: BODY_MARKER,
        },
      ),
    ).toThrow(/title mismatch/);

    expect(() =>
      assertReadVisibleMatch(
        { ...good, content: "no marker" },
        {
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          title: TITLE,
          bodyMarker: BODY_MARKER,
        },
      ),
    ).toThrow(/body marker not found/);
  });

  it("visibility defaults form a bounded ~5s window", () => {
    expect(DEFAULT_VISIBILITY_MAX_ATTEMPTS).toBe(20);
    expect(DEFAULT_VISIBILITY_DELAY_MS).toBe(250);
    expect(DEFAULT_VISIBILITY_MAX_ATTEMPTS * DEFAULT_VISIBILITY_DELAY_MS).toBe(
      5000,
    );
    expect(VISIBILITY_TIMEOUT_MESSAGE).toMatch(
      /not visible to read_note within the bounded wait window/,
    );
    // Fixed safe message must not embed secrets/ids/titles
    expect(VISIBILITY_TIMEOUT_MESSAGE).not.toMatch(/documentId|token|SECRET/i);
  });

  it("assertDeleted requires deleted === true", () => {
    expect(() => assertDeleted({ deleted: false })).toThrow(
      /deleted is not true/,
    );
    expect(() => assertDeleted({ deleted: true })).not.toThrow();
  });

  it("generateSmokeIdentity returns unique title and bodyMarker", () => {
    const a = generateSmokeIdentity(1, () => Buffer.from("aaaaaaaa"));
    const b = generateSmokeIdentity(2, () => Buffer.from("bbbbbbbb"));
    expect(a.title).toMatch(/^mcp-write-smoke-1-/);
    expect(a.bodyMarker).toMatch(/^mcp-write-smoke-marker-1-/);
    expect(a.title).not.toBe(b.title);
  });
});

// ---------------------------------------------------------------------------
// CLI guards
// ---------------------------------------------------------------------------

describe("mcp-write-smoke CLI guards", () => {
  it("requires --confirm-destructive-smoke and --notebook-id", () => {
    expect(() => parseCliArgs([])).toThrow(/confirm-destructive-smoke/);
    expect(() =>
      parseCliArgs(["--confirm-destructive-smoke"]),
    ).toThrow(/notebook-id/);
    expect(() => parseCliArgs(["--notebook-id", "x"])).toThrow(
      /confirm-destructive-smoke/,
    );
    expect(
      parseCliArgs([
        "--notebook-id",
        NOTEBOOK_ID,
        "--confirm-destructive-smoke",
      ]),
    ).toMatchObject({
      notebookId: NOTEBOOK_ID,
      confirmDestructiveSmoke: true,
    });
  });

  it("rejects invalid CLI notebookId format before run", () => {
    expect(() =>
      parseCliArgs([
        "--notebook-id",
        "not-a-siyuan-id",
        "--confirm-destructive-smoke",
      ]),
    ).toThrow(/invalid --notebook-id format/);
    expect(() =>
      parseCliArgs([
        "--notebook-id",
        "20240101120000-toolong1",
        "--confirm-destructive-smoke",
      ]),
    ).toThrow(/invalid --notebook-id format/);
  });

  it("parses --url forms and rejects unknown / missing values", () => {
    expect(
      parseCliArgs([
        "--notebook-id",
        NOTEBOOK_ID,
        "--confirm-destructive-smoke",
        "--url",
        "http://127.0.0.1:9/mcp",
      ]).url,
    ).toBe("http://127.0.0.1:9/mcp");
    expect(
      parseCliArgs([
        `--notebook-id=${NOTEBOOK_ID}`,
        "--confirm-destructive-smoke",
        "--url=http://localhost/mcp",
      ]).url,
    ).toBe("http://localhost/mcp");
    expect(() =>
      parseCliArgs([
        "--notebook-id",
        NOTEBOOK_ID,
        "--confirm-destructive-smoke",
        "--unknown",
      ]),
    ).toThrow(/unknown argument/);
    expect(() =>
      parseCliArgs([
        "--notebook-id",
        NOTEBOOK_ID,
        "--confirm-destructive-smoke",
        "--url",
      ]),
    ).toThrow(/--url requires a value/);
    expect(() =>
      parseCliArgs([
        "--notebook-id",
        "",
        "--confirm-destructive-smoke",
      ]),
    ).toThrow(/notebook-id/);
  });
});

describe("mcp-write-smoke main exitCode (no process.exit)", () => {
  const prevExitCode = process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
    process.exitCode = prevExitCode;
  });

  function trackExit() {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not be called from main");
    }) as never);
  }

  it("missing flags sets exitCode 1 without process.exit", async () => {
    trackExit();
    process.exitCode = undefined;
    const errors: string[] = [];
    await main([], {
      log: () => {},
      error: (line: string) => errors.push(line),
      env: {},
      run: async () => {
        throw new Error("run must not be called");
      },
    });
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/mcp-write-smoke FAIL:/);
  });

  it("help sets exitCode 0 without process.exit", async () => {
    trackExit();
    process.exitCode = undefined;
    const logs: string[] = [];
    const secret = "help-must-not-print-token";
    await main(["--help"], {
      log: (line: string) => logs.push(line),
      error: () => {},
      env: { SIYUAN_API_TOKEN: secret },
      run: async () => {
        throw new Error("run must not be called on help");
      },
    });
    expect(process.exitCode).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Usage: node scripts\/mcp-write-smoke\.mjs/);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("success sets exitCode 0 and passes confirm + notebookId", async () => {
    trackExit();
    process.exitCode = undefined;
    let ran = false;
    await main(
      ["--notebook-id", NOTEBOOK_ID, "--confirm-destructive-smoke"],
      {
        log: () => {},
        error: () => {},
        env: { SIYUAN_API_TOKEN: TOKEN },
        run: async (opts: {
          token?: string;
          notebookId?: string;
          confirmDestructiveSmoke?: boolean;
        }) => {
          ran = true;
          expect(opts.token).toBe(TOKEN);
          expect(opts.notebookId).toBe(NOTEBOOK_ID);
          expect(opts.confirmDestructiveSmoke).toBe(true);
          return { ok: true };
        },
      },
    );
    expect(ran).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("run failure redacts token and sets exitCode 1", async () => {
    trackExit();
    process.exitCode = undefined;
    const secret = "main-write-fail-secret-token-xyz";
    const errors: string[] = [];
    await main(
      ["--notebook-id", NOTEBOOK_ID, "--confirm-destructive-smoke"],
      {
        log: () => {},
        error: (line: string) => errors.push(line),
        env: { SIYUAN_API_TOKEN: secret },
        run: async () => {
          throw new Error(`failed token=${secret}`);
        },
      },
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/mcp-write-smoke FAIL:/);
    expect(errors.join("\n")).not.toContain(secret);
  });

  it("invalid CLI notebookId fails closed without calling run", async () => {
    trackExit();
    process.exitCode = undefined;
    const errors: string[] = [];
    let ran = false;
    await main(
      ["--notebook-id", "bad-id", "--confirm-destructive-smoke"],
      {
        log: () => {},
        error: (line: string) => errors.push(line),
        env: { SIYUAN_API_TOKEN: TOKEN },
        run: async () => {
          ran = true;
          throw new Error("run must not be called");
        },
      },
    );
    expect(ran).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/invalid --notebook-id format/);
  });
});

// ---------------------------------------------------------------------------
// Orchestration with mocked MCP transport
// ---------------------------------------------------------------------------

describe("mcp-write-smoke orchestration", () => {
  const silent = () => {};

  it("refuses without confirmDestructiveSmoke even if notebook set", async () => {
    await expect(
      runMcpWriteSmoke({
        token: TOKEN,
        url: URL,
        notebookId: NOTEBOOK_ID,
        confirmDestructiveSmoke: false,
        catalog: CATALOG_19,
        fetchImpl: makeWriteFetch() as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/confirmDestructiveSmoke must be true/);
  });

  it("rejects invalid programmatic notebookId before any network", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const fetchImpl = makeWriteFetch({ capture });
    await expect(
      runMcpWriteSmoke({
        token: TOKEN,
        url: URL,
        notebookId: "not-valid-id",
        confirmDestructiveSmoke: true,
        catalog: CATALOG_19,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/invalid SiYuan id format/);
    expect(capture.methods).toHaveLength(0);
    expect(capture.urls).toHaveLength(0);
  });

  it("preflight runs get_policy + list_accessible_notebooks before any write", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    // delete deny → fails at preflight before create
    const fetchImpl = makeWriteFetch({
      capture,
      operations: {
        create: "allow",
        update: "allow",
        read: "allow",
        delete: "deny",
      },
    });
    await expect(
      runWrite(fetchImpl as typeof fetch),
    ).rejects.toThrow(/operations\.delete is deny/);

    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
    ]);
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
    expect(capture.methods.filter((m) => m === "tools/call")).toHaveLength(2);
  });

  it("refuses inaccessible notebook before create", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const fetchImpl = makeWriteFetch({
      capture,
      notebooks: [{ id: "20240101000000-othernb" }],
    });
    await expect(runWrite(fetchImpl as typeof fetch)).rejects.toThrow(
      /not accessible/,
    );
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
  });

  it("direct get_policy + enveloped list/lifecycle happy path passes", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const { result } = await runWrite(
      makeWriteFetch({ capture, policyShape: "direct" }) as typeof fetch,
    );
    expect(result.ok).toBe(true);
    expect(capture.toolNames[0]).toBe(`${PLUGIN_NS}get_policy`);
    expect(capture.toolNames[1]).toBe(`${PLUGIN_NS}list_accessible_notebooks`);
    expect(capture.toolNames).toContain(`${PLUGIN_NS}create_note`);
  });

  it("enveloped get_policy is rejected as malformed policy before any write", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await expect(
      runWrite(
        makeWriteFetch({ capture, policyShape: "enveloped" }) as typeof fetch,
      ),
    ).rejects.toThrow(/operations missing or malformed|operations\./);
    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
    ]);
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
  });

  it("missing/array/null direct get_policy structuredContent rejects before write", async () => {
    for (const policyShape of ["missing", "array", "null", "malformed"] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      await expect(
        runWrite(makeWriteFetch({ capture, policyShape }) as typeof fetch),
      ).rejects.toThrow(/missing or malformed structuredContent|isError/);
      expect(capture.toolNames).toEqual([`${PLUGIN_NS}get_policy`]);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
    }
  });

  it("get_policy never falls back to content.text", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await expect(
      runWrite(
        makeWriteFetch({ capture, policyShape: "text-only" }) as typeof fetch,
      ),
    ).rejects.toThrow(/missing or malformed structuredContent/);
    expect(capture.toolNames).toEqual([`${PLUGIN_NS}get_policy`]);
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
  });

  it("fails on malformed/missing list envelopes and lifecycle envelopes without content.text fallback", async () => {
    for (const mode of ["missing", "ok-false", "text-only"] as const) {
      await expect(
        runWrite(
          makeWriteFetch({ listEnvelope: mode }) as typeof fetch,
        ),
      ).rejects.toThrow(/structuredContent|ok=false/);
    }
  });

  it("happy path: create → readiness read(s) → update → verification read → delete", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const { result, logs } = await runWrite(
      makeWriteFetch({ capture }) as typeof fetch,
    );

    expect(result.ok).toBe(true);
    expect(result.lifecycle).toEqual({
      create: true,
      update: true,
      read: true,
      delete: true,
    });
    expect(result.cleanupAttempted).toBe(false);

    // methods: init, initialized, tools/list, then 7 tool calls
    // (get_policy, list, create, readiness read, update, verify read, delete)
    expect(capture.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
      `${PLUGIN_NS}create_note`,
      `${PLUGIN_NS}read_note`,
      `${PLUGIN_NS}update_note`,
      `${PLUGIN_NS}read_note`,
      `${PLUGIN_NS}delete_note`,
    ]);

    // preflight before write
    const createIdx = capture.toolNames.indexOf(`${PLUGIN_NS}create_note`);
    expect(capture.toolNames.indexOf(`${PLUGIN_NS}get_policy`)).toBeLessThan(
      createIdx,
    );
    expect(
      capture.toolNames.indexOf(`${PLUGIN_NS}list_accessible_notebooks`),
    ).toBeLessThan(createIdx);

    // readiness read before update; verification read after update
    const updateIdx = capture.toolNames.indexOf(`${PLUGIN_NS}update_note`);
    const readinessIdx = capture.toolNames.indexOf(`${PLUGIN_NS}read_note`);
    const verifyIdx = capture.toolNames.lastIndexOf(`${PLUGIN_NS}read_note`);
    expect(readinessIdx).toBeGreaterThan(createIdx);
    expect(readinessIdx).toBeLessThan(updateIdx);
    expect(verifyIdx).toBeGreaterThan(updateIdx);

    const expected = buildLifecycleArgs({
      notebookId: NOTEBOOK_ID,
      title: TITLE,
      bodyMarker: BODY_MARKER,
      documentId: DOC_ID,
    });
    // create args (documentId null path uses same create shape)
    expect(capture.toolArgs[2]).toEqual(
      buildLifecycleArgs({
        notebookId: NOTEBOOK_ID,
        title: TITLE,
        bodyMarker: BODY_MARKER,
        documentId: null,
      }).create,
    );
    expect(capture.toolArgs[2]).toMatchObject({
      tagging: { decision: "skip", tags: [] },
    });
    // readiness + verification reads share the same read args shape
    expect(capture.toolArgs[3]).toEqual(expected.read);
    expect(capture.toolArgs[4]).toEqual(expected.update);
    expect(capture.toolArgs[4]).toMatchObject({
      tagging: { decision: "skip", tags: [] },
    });
    expect(capture.toolArgs[5]).toEqual(expected.read);
    expect(capture.toolArgs[6]).toEqual(expected.delete);

    // writes never retried
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}create_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}update_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);

    // no native API bypass — only MCP URL
    expect(capture.urls.every((u) => u === URL)).toBe(true);
    expect(capture.urls.some((u) => /\/api\//.test(u))).toBe(false);

    const joined = logs.join("\n");
    expect(joined).toMatch(/mcp-write-smoke PASS/);
    expect(joined).toMatch(/visibility read_note ok/);
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(SESSION);
    expect(joined).not.toContain(NOTEBOOK_ID);
    expect(joined).not.toContain(DOC_ID);
    expect(joined).not.toContain(TITLE);
    expect(joined).not.toContain(BODY_MARKER);
    expect(joined).not.toContain("Disposable Secret Notebook");
    expect(joined).not.toContain("DO_NOT_PARSE_CONTENT_TEXT_SECRET");
    expect(joined).not.toContain("SECRET_ERROR");
    expect(joined).toMatch(/session=yes/);
    expect(joined).not.toMatch(/session=write-smoke/);
  });

  it("create-result mismatch (notebook/title) aborts and runs exactly one cleanup", async () => {
    for (const createResult of ["notebook-mismatch", "title-mismatch"] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      await expect(
        runWrite(makeWriteFetch({ capture, createResult }) as typeof fetch),
      ).rejects.toThrow(/mismatch/);

      const deletes = capture.toolNames.filter(
        (n) => n === `${PLUGIN_NS}delete_note`,
      );
      expect(deletes).toHaveLength(1);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
      // cleanup args carry documentId + expectedTitle
      const deleteArg = capture.toolArgs[
        capture.toolNames.indexOf(`${PLUGIN_NS}delete_note`)
      ] as { documentId?: string; expectedTitle?: string; confirmed?: boolean };
      expect(deleteArg).toEqual({
        documentId: DOC_ID,
        expectedTitle: TITLE,
        confirmed: true,
      });
    }
  });

  it("create missing documentId does not cleanup and reports artifactPossiblyCreated", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    try {
      await runWrite(
        makeWriteFetch({ capture, createResult: "missing-doc" }) as typeof fetch,
      );
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/documentId missing/);
      expect(msg).toContain(ARTIFACT_POSSIBLY_CREATED_SIGNAL);
      expect(msg).not.toMatch(/cleanup failed|cleanup delete/);
    }
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}delete_note`);
  });

  it("create malformed returned documentId is not known-created: no cleanup, artifactPossiblyCreated, never prints id", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    try {
      await runWrite(
        makeWriteFetch({
          capture,
          createResult: "invalid-doc-id",
        }) as typeof fetch,
      );
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/documentId invalid format/);
      expect(msg).toContain("artifactPossiblyCreated=true");
      expect(msg).toContain(
        "manual inspection required in the selected disposable notebook",
      );
      expect(msg).not.toContain(INVALID_DOC_ID);
      expect(msg).not.toContain(NOTEBOOK_ID);
      expect(msg).not.toContain(TITLE);
      expect(msg).not.toContain(BODY_MARKER);
      expect(msg).not.toMatch(/cleanup failed|cleanup delete/);
    }
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}delete_note`);
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
  });

  it("create transport/envelope/missing-ID failures report artifactPossiblyCreated and never cleanup", async () => {
    const modes = [
      "timeout",
      "transport-fail",
      "ok-false",
      "malformed",
      "text-only",
      "missing-envelope",
      "missing-doc",
      "invalid-doc-id",
    ] as const;
    for (const createResult of modes) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      try {
        await runWrite(
          makeWriteFetch({ capture, createResult }) as typeof fetch,
        );
        expect.fail(`should throw for createResult=${createResult}`);
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).toContain("artifactPossiblyCreated=true");
        expect(msg).toContain(
          "manual inspection required in the selected disposable notebook",
        );
        expect(msg).not.toMatch(/cleanup failed/);
        expect(msg).not.toContain(NOTEBOOK_ID);
        expect(msg).not.toContain(TITLE);
        expect(msg).not.toContain(BODY_MARKER);
        expect(msg).not.toContain(TOKEN);
        expect(msg).not.toContain(SESSION);
        expect(msg).not.toContain(INVALID_DOC_ID);
        // Must not claim a documentId recovery path when id is unknown
        expect(msg).not.toMatch(/documentId=2024/);
      }
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}delete_note`);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
      // create was attempted (dispatched)
      expect(capture.toolNames).toContain(`${PLUGIN_NS}create_note`);
    }
  });

  it("preflight failures never report artifactPossiblyCreated", async () => {
    const cases: Array<{
      label: string;
      opts: WriteFetchOpts;
      re: RegExp;
    }> = [
      {
        label: "delete-deny",
        opts: {
          operations: {
            create: "allow",
            update: "allow",
            read: "allow",
            delete: "deny",
          },
        },
        re: /operations\.delete is deny/,
      },
      {
        label: "inaccessible-notebook",
        opts: { notebooks: [{ id: "20240101000000-othernb" }] },
        re: /not accessible/,
      },
      {
        label: "policy-direct-missing",
        opts: { policyShape: "missing" },
        re: /structuredContent/,
      },
      {
        label: "policy-enveloped-malformed-ops",
        opts: { policyShape: "enveloped" },
        re: /operations missing or malformed|operations\./,
      },
      {
        label: "policy-ok-false-envelope-not-ops",
        opts: { policyShape: "ok-false-envelope" },
        re: /operations missing or malformed|operations\./,
      },
    ];
    for (const c of cases) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      try {
        await runWrite(makeWriteFetch({ capture, ...c.opts }) as typeof fetch);
        expect.fail(`should throw for ${c.label}`);
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).toMatch(c.re);
        expect(msg).not.toContain("artifactPossiblyCreated");
      }
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}create_note`);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}delete_note`);
    }
  });

  it("create text-only / missing envelope never falls back to content.text", async () => {
    for (const createResult of ["text-only", "missing-envelope"] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      await expect(
        runWrite(makeWriteFetch({ capture, createResult }) as typeof fetch),
      ).rejects.toThrow(/structuredContent/);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}delete_note`);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
    }
  });

  it("update txn/verified checks fail and trigger exactly one cleanup", async () => {
    for (const updateResult of [
      "txn-not-committed",
      "verified-false",
    ] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      await expect(
        runWrite(makeWriteFetch({ capture, updateResult }) as typeof fetch),
      ).rejects.toThrow(/txnState|verified/);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
      ).toHaveLength(1);
      // readiness read before update; verification read not reached
      expect(capture.toolNames).toContain(`${PLUGIN_NS}read_note`);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
      ).toHaveLength(1);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}update_note`),
      ).toHaveLength(1);
    }
  });

  it("read marker check fails and triggers exactly one cleanup", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await expect(
      runWrite(
        makeWriteFetch({ capture, readResult: "missing-marker" }) as typeof fetch,
      ),
    ).rejects.toThrow(/body marker not found/);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);
    // readiness + verification reads; only verification fails marker
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
    ).toHaveLength(2);
  });

  it("exactly one cleanup after post-create failure; no second delete", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await expect(
      runWrite(
        makeWriteFetch({ capture, failTool: "update_note" }) as typeof fetch,
      ),
    ).rejects.toThrow(/ok=false/);
    const deletes = capture.toolNames.filter(
      (n) => n === `${PLUGIN_NS}delete_note`,
    );
    expect(deletes).toHaveLength(1);
    // lifecycle: create → readiness read → update fail → cleanup delete
    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
      `${PLUGIN_NS}create_note`,
      `${PLUGIN_NS}read_note`,
      `${PLUGIN_NS}update_note`,
      `${PLUGIN_NS}delete_note`,
    ]);
  });

  it("cleanup failure documentId-only recovery (no title/token/session/body)", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const logs: string[] = [];
    try {
      await runMcpWriteSmoke({
        token: TOKEN,
        url: URL,
        notebookId: NOTEBOOK_ID,
        confirmDestructiveSmoke: true,
        catalog: CATALOG_19,
        fetchImpl: makeWriteFetch({
          capture,
          failTool: "update_note",
          deleteResult: "ok-false",
        }) as typeof fetch,
        log: (line: string) => logs.push(line),
        identityFactory: () => ({ title: TITLE, bodyMarker: BODY_MARKER }),
        ...FAST_VISIBILITY,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/cleanup failed/);
      expect(msg).toContain(`documentId=${DOC_ID}`);
      // may leave one note — print only documentId, not secrets
      expect(msg).not.toContain(TOKEN);
      expect(msg).not.toContain(SESSION);
      expect(msg).not.toContain(TITLE);
      expect(msg).not.toContain(BODY_MARKER);
      expect(msg).not.toContain("Disposable Secret Notebook");
      expect(msg).not.toContain("SECRET_ERROR");
    }
    // create + readiness + failed update + one cleanup delete attempt
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);
    const joined = logs.join("\n");
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(TITLE);
    expect(joined).not.toContain(BODY_MARKER);
  });

  it("lifecycle delete success does not attempt extra cleanup delete", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await runWrite(makeWriteFetch({ capture }) as typeof fetch);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);
  });

  it("lifecycle delete fails then cleanup succeeds: two deletes, original error, cleanup logged ok", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const logs: string[] = [];
    try {
      await runMcpWriteSmoke({
        token: TOKEN,
        url: URL,
        notebookId: NOTEBOOK_ID,
        confirmDestructiveSmoke: true,
        catalog: CATALOG_19,
        fetchImpl: makeWriteFetch({
          capture,
          deleteResult: "fail-once-then-ok",
        }) as typeof fetch,
        log: (line: string) => logs.push(line),
        identityFactory: () => ({ title: TITLE, bodyMarker: BODY_MARKER }),
        ...FAST_VISIBILITY,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      // overall still fails with original lifecycle error
      expect(msg).toMatch(/ok=false/);
      // cleanup succeeded — do not append cleanup-failure recovery
      expect(msg).not.toMatch(/cleanup failed/);
      expect(msg).not.toContain("artifactPossiblyCreated");
      expect(msg).not.toContain(TITLE);
      expect(msg).not.toContain(BODY_MARKER);
    }
    const deletes = capture.toolNames.filter(
      (n) => n === `${PLUGIN_NS}delete_note`,
    );
    expect(deletes).toHaveLength(2);
    expect(logs.some((l) => l === "cleanup delete_note ok")).toBe(true);
    // no third delete
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(2);
  });

  it("lifecycle delete fails then cleanup fails: two deletes, validated documentId only, no third", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const logs: string[] = [];
    try {
      await runMcpWriteSmoke({
        token: TOKEN,
        url: URL,
        notebookId: NOTEBOOK_ID,
        confirmDestructiveSmoke: true,
        catalog: CATALOG_19,
        fetchImpl: makeWriteFetch({
          capture,
          deleteResult: "ok-false",
        }) as typeof fetch,
        log: (line: string) => logs.push(line),
        identityFactory: () => ({ title: TITLE, bodyMarker: BODY_MARKER }),
        ...FAST_VISIBILITY,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/ok=false/);
      expect(msg).toMatch(/cleanup failed/);
      expect(msg).toContain(`documentId=${DOC_ID}`);
      // recovery contains only validated documentId — no secrets/title/body
      expect(msg).not.toContain(TOKEN);
      expect(msg).not.toContain(SESSION);
      expect(msg).not.toContain(TITLE);
      expect(msg).not.toContain(BODY_MARKER);
      expect(msg).not.toContain(NOTEBOOK_ID);
      expect(msg).not.toContain("SECRET_ERROR");
      expect(msg).not.toContain("artifactPossiblyCreated");
    }
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(2);
    expect(logs.some((l) => l === "cleanup delete_note ok")).toBe(false);
  });

  it("eventual visibility: ok=false readiness polls then succeeds before update", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const sleepCalls: number[] = [];
    const { result, logs } = await runWrite(
      makeWriteFetch({ capture, visibilityFailCount: 3 }) as typeof fetch,
      {
        visibilityMaxAttempts: 5,
        visibilityDelayMs: 7,
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
      },
    );
    expect(result.ok).toBe(true);
    const readNames = capture.toolNames.filter(
      (n) => n === `${PLUGIN_NS}read_note`,
    );
    // 3 not-yet-visible + 1 success readiness + 1 verification
    expect(readNames).toHaveLength(5);
    expect(sleepCalls).toEqual([7, 7, 7]);
    const createIdx = capture.toolNames.indexOf(`${PLUGIN_NS}create_note`);
    const updateIdx = capture.toolNames.indexOf(`${PLUGIN_NS}update_note`);
    const readinessReads = capture.toolNames
      .map((n, i) => ({ n, i }))
      .filter(
        ({ n, i }) =>
          n === `${PLUGIN_NS}read_note` && i > createIdx && i < updateIdx,
      );
    expect(readinessReads).toHaveLength(4);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}create_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}update_note`),
    ).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/visibility read_note ok/);
    expect(logs.join("\n")).not.toContain("SECRET_ERROR");
  });

  it("visibility timeout: fixed safe message, bounded reads, exactly one cleanup, no write retries", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    const sleepCalls: number[] = [];
    const maxAttempts = 4;
    try {
      await runWrite(
        makeWriteFetch({ capture, visibilityNever: true }) as typeof fetch,
        {
          visibilityMaxAttempts: maxAttempts,
          visibilityDelayMs: 11,
          sleep: async (ms: number) => {
            sleepCalls.push(ms);
          },
        },
      );
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe(VISIBILITY_TIMEOUT_MESSAGE);
      // timeout path is known-created: cleanup may append documentId only on cleanup fail
      expect(msg).not.toContain(TITLE);
      expect(msg).not.toContain(BODY_MARKER);
      expect(msg).not.toContain(TOKEN);
      expect(msg).not.toContain(SESSION);
      expect(msg).not.toContain("SECRET_ERROR");
      expect(msg).not.toContain("artifactPossiblyCreated");
    }
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
    ).toHaveLength(maxAttempts);
    expect(sleepCalls).toHaveLength(maxAttempts - 1);
    expect(sleepCalls.every((ms) => ms === 11)).toBe(true);
    expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}create_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);
  });

  it("visibility malformed envelope is hard failure (no further polls), then cleanup", async () => {
    for (const visibilityResult of ["malformed", "text-only", "missing"] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      try {
        await runWrite(
          makeWriteFetch({ capture, visibilityResult }) as typeof fetch,
          { visibilityMaxAttempts: 8, visibilityDelayMs: 0, sleep: async () => {} },
        );
        expect.fail(`should throw for visibilityResult=${visibilityResult}`);
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).toMatch(/structuredContent|result must be an object/);
        expect(msg).not.toContain("SECRET_ERROR");
        expect(msg).not.toContain(TITLE);
        expect(msg).not.toContain(BODY_MARKER);
        expect(msg).not.toBe(VISIBILITY_TIMEOUT_MESSAGE);
      }
      // hard fail on first readiness read — no retry of malformed
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
      ).toHaveLength(1);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
      ).toHaveLength(1);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}create_note`),
      ).toHaveLength(1);
    }
  });

  it("visibility field mismatch is hard failure then exactly one cleanup", async () => {
    for (const visibilityResult of [
      "mismatch-doc",
      "mismatch-notebook",
      "mismatch-title",
      "missing-marker",
    ] as const) {
      const capture: Capture = {
        methods: [],
        toolNames: [],
        toolArgs: [],
        bodies: [],
        urls: [],
        headerSnapshots: [],
      };
      await expect(
        runWrite(
          makeWriteFetch({ capture, visibilityResult }) as typeof fetch,
        ),
      ).rejects.toThrow(/mismatch|body marker not found/);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
      ).toHaveLength(1);
      expect(capture.toolNames).not.toContain(`${PLUGIN_NS}update_note`);
      expect(
        capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
      ).toHaveLength(1);
    }
  });

  it("writes are never retried on update failure after visibility", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await expect(
      runWrite(
        makeWriteFetch({
          capture,
          visibilityFailCount: 2,
          failTool: "update_note",
        }) as typeof fetch,
        {
          visibilityMaxAttempts: 5,
          visibilityDelayMs: 0,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(/ok=false/);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}create_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}update_note`),
    ).toHaveLength(1);
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}delete_note`),
    ).toHaveLength(1);
    // readiness polls only (no verification after failed update)
    expect(
      capture.toolNames.filter((n) => n === `${PLUGIN_NS}read_note`),
    ).toHaveLength(3);
  });

  it("no native bypass endpoint is ever requested", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      toolArgs: [],
      bodies: [],
      urls: [],
      headerSnapshots: [],
    };
    await runWrite(makeWriteFetch({ capture }) as typeof fetch);
    for (const u of capture.urls) {
      expect(u).toBe(URL);
      expect(u).not.toMatch(/\/api\//);
      expect(u).not.toMatch(/bypass|native|exportMd|createDoc/i);
    }
    // only plugin tools
    for (const name of capture.toolNames) {
      expect(name.startsWith(PLUGIN_NS)).toBe(true);
    }
  });
});
