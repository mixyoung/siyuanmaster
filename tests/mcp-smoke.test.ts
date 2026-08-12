import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCatalogMatch,
  assertJsonRpcSuccess,
  assertLoopbackUrl,
  assertNoJsonRpcErrors,
  assertToolCallResultShape,
  catalogPath,
  countToolNamespaces,
  extractToolNames,
  isLoopbackHostname,
  loadCatalog,
  main,
  mcpPost,
  parseCliArgs,
  parseMcpHttpBody,
  parseSseJsonRpcMessages,
  partitionPluginTools,
  pickJsonRpcResponse,
  redactSecrets,
  runMcpSmoke,
  summarizeTopLevelFields,
  validateAgainstCatalog,
} from "../scripts/mcp-smoke.mjs";

const PLUGIN_NS = "plugin__siyuanmaster__";
const LEGACY_NS = "plugin__siyuan_agent_access__";

const CATALOG_27 = {
  namespaces: { plugin: PLUGIN_NS },
  pluginTools: [
    "get_policy",
    "list_accessible_notebooks",
    "list_document_tree",
    "search_notes",
    "read_note",
    "resolve_document",
    "read_note_segments",
    "register_knowledge_source",
    "register_wiki_authority",
    "knowledge_status",
    "find_wiki_candidates",
    "list_wiki_templates",
    "render_wiki_template",
    "validate_wiki_template",
    "plan_source_ingest",
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
  ].map((name) => ({ name, category: "x", readOnly: true, confirmDefault: false })),
};

const FQ_27 = CATALOG_27.pluginTools.map((t) => `${PLUGIN_NS}${t.name}`);

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
    ...(opts.sessionId
      ? { "mcp-session-id": opts.sessionId }
      : {}),
  });
  return {
    status,
    headers,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("mcp-smoke loopback guard", () => {
  it("accepts loopback hostnames only", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("127.0.0.2")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });

  it("strictly rejects invalid IPv4 octets in 127/8", () => {
    expect(isLoopbackHostname("127.0.0.256")).toBe(false);
    expect(isLoopbackHostname("127.999.0.1")).toBe(false);
    expect(isLoopbackHostname("127.0.0.01")).toBe(false); // leading zero not in 0–255 pattern for multi-digit? actually 01 might fail our pattern - good
    expect(isLoopbackHostname("127.0.0.-1")).toBe(false);
    expect(isLoopbackHostname("127.1.2.300")).toBe(false);
    expect(isLoopbackHostname("127.0.0")).toBe(false);
  });

  it("assertLoopbackUrl accepts http loopback and rejects remote", () => {
    expect(assertLoopbackUrl("http://127.0.0.1:6806/mcp").hostname).toBe(
      "127.0.0.1",
    );
    expect(assertLoopbackUrl("http://localhost:6806/mcp").hostname).toBe(
      "localhost",
    );
    expect(() => assertLoopbackUrl("http://example.com:6806/mcp")).toThrow(
      /loopback/,
    );
    expect(() => assertLoopbackUrl("ftp://127.0.0.1/mcp")).toThrow(/http/);
  });
});
describe("mcp-smoke parsing (JSON / SSE)", () => {
  it("parses application/json single and array bodies", () => {
    const single = parseMcpHttpBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
      "application/json",
    );
    expect(single.messages).toHaveLength(1);
    expect(single.messages[0].result.ok).toBe(true);

    const multi = parseMcpHttpBody(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, result: { a: 1 } },
        { jsonrpc: "2.0", id: 2, result: { b: 2 } },
      ]),
      "application/json; charset=utf-8",
    );
    expect(multi.messages).toHaveLength(2);
  });

  it("parses SSE data frames into JSON-RPC messages", () => {
    const sse = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
      "",
      'data: {"jsonrpc":"2.0","method":"notifications/message"}',
      "",
    ].join("\n");
    const messages = parseSseJsonRpcMessages(sse);
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe(1);
    expect(messages[0].result.tools).toEqual([]);

    const fromBody = parseMcpHttpBody(sse, "text/event-stream");
    expect(fromBody.contentType).toBe("text/event-stream");
    expect(fromBody.messages).toHaveLength(2);
  });

  it("detects SSE body even when content-type is wrong", () => {
    const body = 'data: {"jsonrpc":"2.0","id":9,"result":{"x":1}}\n\n';
    const parsed = parseMcpHttpBody(body, "text/plain");
    expect(parsed.messages[0].id).toBe(9);
  });

  it("picks JSON-RPC response by id", () => {
    const messages = [
      { jsonrpc: "2.0", method: "notifications/progress" },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
      { jsonrpc: "2.0", id: 1, result: { wrong: true } },
    ];
    expect(pickJsonRpcResponse(messages, 2)?.result).toEqual({ tools: [] });
    expect(pickJsonRpcResponse([], 1)).toBeNull();
  });

  it("does not fall back to any response when request id does not match", () => {
    const messages = [
      { jsonrpc: "2.0", id: 99, result: { tools: [{ name: "wrong" }] } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
      { jsonrpc: "2.0", method: "notifications/progress" },
    ];
    expect(pickJsonRpcResponse(messages, 1)).toBeNull();
    expect(pickJsonRpcResponse(messages, 42)).toBeNull();
    expect(() =>
      assertJsonRpcSuccess(pickJsonRpcResponse(messages, 1), "tools/list"),
    ).toThrow(/missing response/);
  });

  it("illegal SSE JSON error does not echo payload text", () => {
    const secret = "SECRET_SSE_PAYLOAD_SHOULD_NOT_APPEAR";
    expect(() => parseSseJsonRpcMessages(`data: ${secret}\n\n`)).toThrow(
      /not valid JSON/,
    );
    try {
      parseSseJsonRpcMessages(`data: ${secret}\n\n`);
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).not.toContain(secret);
      expect(msg).toMatch(/dataLength=/);
    }
  });

  it("illegal non-JSON/SSE body error does not echo body text", () => {
    const secret = "THIS_IS_RAW_HTTP_BODY_CONTENT_xyz";
    expect(() => parseMcpHttpBody(secret, "text/plain")).toThrow(
      /neither JSON nor SSE/,
    );
    try {
      parseMcpHttpBody(secret, "text/plain");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).not.toContain(secret);
      expect(msg).toMatch(/bodyLength=/);
      expect(msg).toMatch(/content-type=text\/plain/);
    }
  });
});
describe("mcp-smoke fail-closed errors", () => {
  it("throws on JSON-RPC error", () => {
    expect(() =>
      assertJsonRpcSuccess(
        { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } },
        "test",
      ),
    ).toThrow(/JSON-RPC error/);
  });

  it("JSON-RPC error exposes code only, never message", () => {
    const secretMsg = "SECRET_RPC_ERROR_MESSAGE_do_not_echo";
    try {
      assertJsonRpcSuccess(
        {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32603, message: secretMsg },
        },
        "rpc",
      );
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/code=-32603/);
      expect(msg).not.toContain(secretMsg);
      expect(msg).not.toMatch(/message=/);
    }
  });

  it("throws on result.isError", () => {
    expect(() =>
      assertJsonRpcSuccess(
        {
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "nope" }] },
        },
        "tools/call",
      ),
    ).toThrow(/isError/);
  });

  it("throws when result is missing", () => {
    expect(() =>
      assertJsonRpcSuccess({ jsonrpc: "2.0", id: 1 }, "x"),
    ).toThrow(/no result/);
  });

  it("throws fixed missing response when message is null", () => {
    expect(() => assertJsonRpcSuccess(null, "initialize")).toThrow(
      /missing response/,
    );
  });

  it("rejects tools/list without tools array", () => {
    expect(() => extractToolNames({})).toThrow(/tools/);
    expect(() => extractToolNames({ tools: [{ name: "a" }, {}] })).toThrow(
      /missing name/,
    );
  });

  it("assertToolCallResultShape requires non-empty content or structuredContent", () => {
    expect(() =>
      assertToolCallResultShape(
        { isError: false, content: [] },
        "tools/call x",
      ),
    ).toThrow(/non-empty content|structuredContent/);

    expect(() =>
      assertToolCallResultShape({ isError: false }, "tools/call x"),
    ).toThrow(/non-empty content|structuredContent/);

    expect(
      assertToolCallResultShape({
        isError: false,
        content: [{ type: "text", text: "ok" }],
      }),
    ).toMatchObject({ isError: false });

    expect(
      assertToolCallResultShape({
        isError: false,
        content: [],
        structuredContent: { ok: true },
      }),
    ).toMatchObject({ structuredContent: { ok: true } });
  });

  it("assertNoJsonRpcErrors exposes code only", () => {
    const secret = "SECRET_NOTIF_ERROR_MESSAGE";
    expect(() =>
      assertNoJsonRpcErrors(
        [{ jsonrpc: "2.0", error: { code: -32000, message: secret } }],
        "notifications/initialized",
      ),
    ).toThrow(/code=-32000/);
    try {
      assertNoJsonRpcErrors(
        [{ jsonrpc: "2.0", error: { code: -32000, message: secret } }],
        "notifications/initialized",
      );
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
    expect(() => assertNoJsonRpcErrors([], "notifications/initialized")).not.toThrow();
  });
});
describe("mcp-smoke catalog set validation", () => {
  it("matches exactly 27 plugin tools and zero legacy", () => {
    const discovered = [
      ...FQ_27,
      "some_native_tool",
    ];
    const v = validateAgainstCatalog(discovered, CATALOG_27);
    expect(v.expectedCount).toBe(27);
    expect(v.actualCount).toBe(27);
    expect(v.missing).toEqual([]);
    expect(v.extra).toEqual([]);
    expect(v.legacyCount).toBe(0);
    expect(() => assertCatalogMatch(v)).not.toThrow();
  });

  it("fails when catalog.pluginTools.length is not 27", () => {
    const short = {
      namespaces: { plugin: PLUGIN_NS },
      pluginTools: CATALOG_27.pluginTools.slice(0, 26),
    };
    expect(() => validateAgainstCatalog(FQ_27.slice(0, 26), short)).toThrow(
      /pluginTools\.length must be 27/,
    );
    const long = {
      namespaces: { plugin: PLUGIN_NS },
      pluginTools: [
        ...CATALOG_27.pluginTools,
        { name: "extra_tool", category: "x", readOnly: true, confirmDefault: false },
      ],
    };
    expect(() =>
      validateAgainstCatalog([...FQ_27, `${PLUGIN_NS}extra_tool`], long),
    ).toThrow(/pluginTools\.length must be 27/);
  });

  it("loads real catalog/capabilities.json with exactly 27 plugin tools", async () => {
    const catalog = await loadCatalog(catalogPath);
    expect(catalog.pluginTools).toHaveLength(27);
    expect(catalog.namespaces.plugin).toBe(PLUGIN_NS);
    const discovered = catalog.pluginTools.map(
      (t: { name: string }) => `${catalog.namespaces.plugin}${t.name}`,
    );
    expect(discovered).toHaveLength(27);
    const v = validateAgainstCatalog(discovered, catalog);
    expect(v.expectedCount).toBe(27);
    expect(v.actualCount).toBe(27);
    expect(() => assertCatalogMatch(v)).not.toThrow();
  });

  it("fails when a catalog tool is missing", () => {
    const missingOne = FQ_27.slice(0, 26);
    const v = validateAgainstCatalog(missingOne, CATALOG_27);
    expect(v.missing).toHaveLength(1);
    expect(() => assertCatalogMatch(v)).toThrow(/missing/);
  });

  it("fails when an unexpected plugin tool is present", () => {
    const withExtra = [...FQ_27, `${PLUGIN_NS}unexpected_tool`];
    const v = validateAgainstCatalog(withExtra, CATALOG_27);
    expect(v.extra).toContain(`${PLUGIN_NS}unexpected_tool`);
    expect(() => assertCatalogMatch(v)).toThrow(/extra/);
  });

  it("fails closed when any legacy namespace tool appears", () => {
    const withLegacy = [...FQ_27, `${LEGACY_NS}get_policy`];
    const v = validateAgainstCatalog(withLegacy, CATALOG_27);
    expect(v.legacyCount).toBe(1);
    expect(() => assertCatalogMatch(v)).toThrow(/legacy/);
  });

  it("partitions namespaces correctly", () => {
    const names = [
      `${PLUGIN_NS}get_policy`,
      `${LEGACY_NS}get_policy`,
      "native_foo",
    ];
    const p = partitionPluginTools(names, PLUGIN_NS);
    expect(p.plugin).toEqual([`${PLUGIN_NS}get_policy`]);
    expect(p.legacy).toEqual([`${LEGACY_NS}get_policy`]);
    expect(p.other).toEqual(["native_foo"]);
    expect(countToolNamespaces(names, PLUGIN_NS)).toEqual({
      total: 3,
      plugin: 1,
      legacy: 1,
      other: 1,
    });
  });
});

describe("mcp-smoke desensitization", () => {
  const secret = "super-secret-token-value-xyz";

  it("never echoes the provided token", () => {
    const raw = `Authorization: Token ${secret} SIYUAN_API_TOKEN=${secret} body`;
    const redacted = redactSecrets(raw, secret);
    expect(redacted).not.toContain(secret);
    expect(redacted).toMatch(/REDACTED/);
  });

  it("redacts Authorization Token/Bearer headers without explicit token arg", () => {
    const a = redactSecrets("Authorization: Token abcdefghijklmnopqr");
    expect(a).toMatch(/\[REDACTED\]/);
    expect(a).not.toContain("abcdefghijklmnopqr");

    const b = redactSecrets("Authorization: Bearer zzzzzzzzzzzzzzzzzz");
    expect(b).toMatch(/\[REDACTED\]/);
  });

  it("summarizeTopLevelFields exposes keys and counts, not nested bodies", () => {
    const summary = summarizeTopLevelFields({
      isError: false,
      status: "ok",
      content: [{ type: "text", text: "SECRET_BODY_SHOULD_NOT_APPEAR" }],
      policy: { allow: ["notebook-1"] },
      structuredContent: { notebooks: [{ id: "nb-SECRET" }] },
    });
    expect(summary).toContain("isError=false");
    expect(summary).toContain("structuredContent=present");
    expect(summary).toContain("content.length=1");
    expect(summary).toContain("topLevelKeys=");
    expect(summary).toContain("policy");
    expect(summary).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    expect(summary).not.toContain("notebook-1");
    expect(summary).not.toContain("nb-SECRET");
    expect(summary).not.toContain("status=ok");
  });
});

describe("mcp-smoke CLI flags", () => {
  it("parses --read-smoke and --url", () => {
    expect(parseCliArgs(["--read-smoke"]).readSmoke).toBe(true);
    expect(parseCliArgs(["--url", "http://127.0.0.1:9/mcp"]).url).toBe(
      "http://127.0.0.1:9/mcp",
    );
    expect(parseCliArgs(["--url=http://localhost/mcp"]).url).toBe(
      "http://localhost/mcp",
    );
    expect(parseCliArgs([]).readSmoke).toBe(false);
  });

  it("fails closed on unknown arguments", () => {
    expect(() => parseCliArgs(["--unknown-flag"])).toThrow(/unknown argument/);
    expect(() => parseCliArgs(["--read-smoke", "extra"])).toThrow(
      /unknown argument/,
    );
  });

  it("fails closed when --url value is missing", () => {
    expect(() => parseCliArgs(["--url"])).toThrow(/--url requires a value/);
    expect(() => parseCliArgs(["--url="])).toThrow(/--url requires a value/);
    expect(() => parseCliArgs(["--url", "--read-smoke"])).toThrow(
      /--url requires a value/,
    );
  });
});

describe("mcp-smoke main exitCode (no process.exit)", () => {
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

  it("parse args failure sets exitCode 1 without process.exit", async () => {
    trackExit();
    process.exitCode = undefined;
    const errors: string[] = [];
    const logs: string[] = [];

    await main(["--unknown-flag"], {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
      env: {},
      run: async () => {
        throw new Error("run must not be called");
      },
    });

    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/mcp-smoke FAIL:.*unknown argument/);
    expect(logs).toEqual([]);
  });

  it("help sets exitCode 0 without process.exit", async () => {
    trackExit();
    process.exitCode = undefined;
    const logs: string[] = [];
    const errors: string[] = [];

    await main(["--help"], {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
      env: { SIYUAN_API_TOKEN: "help-must-not-print-this-token-value" },
      run: async () => {
        throw new Error("run must not be called on help");
      },
    });

    expect(process.exitCode).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toMatch(/Usage: node scripts\/mcp-smoke\.mjs/);
    expect(logs.join("\n")).not.toContain("help-must-not-print-this-token-value");
  });

  it("success sets exitCode 0 without process.exit", async () => {
    trackExit();
    process.exitCode = undefined;
    const secret = "main-success-secret-token-value-xyz";
    const logs: string[] = [];
    const errors: string[] = [];
    let ran = false;

    await main(["--read-smoke", "--url", "http://127.0.0.1:6806/mcp"], {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
      env: { SIYUAN_API_TOKEN: secret },
      run: async (opts: { token?: string; readSmoke?: boolean; url?: string }) => {
        ran = true;
        expect(opts.token).toBe(secret);
        expect(opts.readSmoke).toBe(true);
        expect(opts.url).toBe("http://127.0.0.1:6806/mcp");
        return { ok: true };
      },
    });

    expect(ran).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("run failure sets exitCode 1 without process.exit and redacts token", async () => {
    trackExit();
    process.exitCode = undefined;
    const secret = "main-fail-secret-token-value-xyz";
    const logs: string[] = [];
    const errors: string[] = [];

    await main([], {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
      env: { SIYUAN_API_TOKEN: secret },
      run: async () => {
        throw new Error(`catalog mismatch token=${secret} body=SECRET`);
      },
    });

    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    const joined = [...logs, ...errors].join("\n");
    expect(errors.join("\n")).toMatch(/mcp-smoke FAIL:/);
    expect(joined).not.toContain(secret);
    expect(joined).toMatch(/REDACTED_TOKEN|REDACTED/);
    expect(joined).not.toMatch(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("mcp-smoke HTTP transport", () => {
  const token = "super-secret-http-token-value-xyz";
  const url = "http://127.0.0.1:6806/mcp";

  it("mcpPost HTTP error does not leak body or token", async () => {
    const bodySecret = `unauthorized token was ${token} detail=SECRET_BODY`;
    const fetchImpl = async () =>
      jsonResponse(bodySecret, {
        status: 401,
        contentType: "application/json",
      });

    await expect(
      mcpPost({
        url,
        token,
        body: { jsonrpc: "2.0", method: "initialize", id: 1, params: {} },
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/MCP HTTP 401/);

    try {
      await mcpPost({
        url,
        token,
        body: { jsonrpc: "2.0", method: "initialize", id: 1, params: {} },
        fetchImpl: fetchImpl as typeof fetch,
      });
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/content-type=application\/json/);
      expect(msg).toMatch(/bodyLength=/);
      expect(msg).not.toContain(token);
      expect(msg).not.toContain("SECRET_BODY");
      expect(msg).not.toContain("unauthorized");
    }
  });

  it("mcpPost success does not return bodyText or raw headers", async () => {
    const fetchImpl = async () =>
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
        { sessionId: "sess-1" },
      );
    const res = await mcpPost({
      url,
      token,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(res.sessionId).toBe("sess-1");
    expect(res.messages).toHaveLength(1);
    expect(res.contentType).toBeTruthy();
    expect(res).not.toHaveProperty("bodyText");
    expect(res).not.toHaveProperty("headers");
    expect(Object.keys(res).sort()).toEqual(
      ["contentType", "messages", "sessionId", "status"].sort(),
    );
  });

  it("mcpPost times out with fixed metadata only", async () => {
    const secretToken = "timeout-secret-token-value-xyz";
    const fetchImpl = (_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error(
            `aborted raw url=${url} token=${secretToken} body=SECRET`,
          );
          err.name = "AbortError";
          reject(err);
        });
      });

    try {
      await mcpPost({
        url,
        token: secretToken,
        body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 40,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/timed out after 40ms/);
      expect(msg).not.toContain(secretToken);
      expect(msg).not.toContain(url);
      expect(msg).not.toContain("SECRET");
      expect(msg).not.toContain("aborted raw");
    }
  });

  it("mcpPost timeout covers response.text after headers return", async () => {
    const secretToken = "body-timeout-secret-token-xyz";
    const secretBody = "SECRET_SLOW_BODY_CONTENT";
    const fetchImpl = (_u: string, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        headers: mockHeaders({
          "content-type": "application/json",
          "mcp-session-id": "sess-slow",
        }),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing abort signal"));
              return;
            }
            if (signal.aborted) {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
              return;
            }
            signal.addEventListener("abort", () => {
              const err = new Error(
                `text aborted raw url=${url} token=${secretToken} body=${secretBody}`,
              );
              err.name = "AbortError";
              reject(err);
            });
          }),
      });

    try {
      await mcpPost({
        url,
        token: secretToken,
        body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 40,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe("MCP HTTP request timed out after 40ms");
      expect(msg).not.toContain(secretToken);
      expect(msg).not.toContain(url);
      expect(msg).not.toContain(secretBody);
      expect(msg).not.toContain("text aborted");
    }
  });

  it("mcpPost network failure does not leak url token body or raw err.message", async () => {
    const secretToken = "netfail-secret-token-value-xyz";
    const secretUrl = "http://127.0.0.1:6806/mcp?token=LEAKED_QUERY";
    const fetchImpl = async () => {
      throw new Error(
        `connect ECONNREFUSED ${secretUrl} token=${secretToken} body={"password":"SECRET_BODY"}`,
      );
    };

    try {
      await mcpPost({
        url,
        token: secretToken,
        body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe("MCP HTTP request failed");
      expect(msg).not.toContain(secretToken);
      expect(msg).not.toContain(secretUrl);
      expect(msg).not.toContain(url);
      expect(msg).not.toContain("ECONNREFUSED");
      expect(msg).not.toContain("LEAKED_QUERY");
      expect(msg).not.toContain("password");
      expect(msg).not.toContain("SECRET_BODY");
    }
  });
});

describe("mcp-smoke orchestration", () => {
  const token = "orch-test-token-value-abcdefgh";
  const url = "http://127.0.0.1:6806/mcp";
  const silent = () => {};
  const SESSION = "test-session-1";

  type Capture = {
    methods: string[];
    toolNames: string[];
    bodies: unknown[];
    headerSnapshots: Array<Record<string, string | undefined>>;
  };

  function makeOrchestrationFetch(opts: {
    sessionId?: string | null;
    capture?: Capture;
    /** Omit key, set undefined, or pass wrong string to test protocolVersion assertion */
    protocolVersion?: string | null | undefined | "omit";
    initialized?:
      | "202-empty"
      | "error"
      | "200-empty"
      | "204-empty"
      | "202-nonempty";
    toolCallResult?: "ok" | "malformed-empty";
  } = {}) {
    const sessionId = opts.sessionId === undefined ? SESSION : opts.sessionId;
    const capture = opts.capture;
    const initializedMode = opts.initialized ?? "202-empty";
    const toolCallResult = opts.toolCallResult ?? "ok";
    return async (_u: string, init?: RequestInit) => {
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const normalized: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        normalized[k.toLowerCase()] = v;
      }
      capture?.headerSnapshots.push(normalized);

      const body = JSON.parse(String(init?.body ?? "{}"));
      capture?.bodies.push(body);
      capture?.methods.push(body.method);
      if (body.method === "tools/call") {
        capture?.toolNames.push(body.params?.name);
      }

      if (body.method === "initialize") {
        const result: Record<string, unknown> = { capabilities: {} };
        if (opts.protocolVersion === "omit") {
          // leave protocolVersion absent
        } else if (opts.protocolVersion === undefined && !("protocolVersion" in opts)) {
          result.protocolVersion = "2025-03-26";
        } else if (opts.protocolVersion === undefined || opts.protocolVersion === null) {
          // explicit missing: do not set
        } else {
          result.protocolVersion = opts.protocolVersion;
        }
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result,
          },
          { sessionId },
        );
      }
      if (body.method === "notifications/initialized") {
        if (initializedMode === "error") {
          return jsonResponse({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "SECRET_INITIALIZED_ERROR_do_not_echo",
            },
          });
        }
        if (initializedMode === "200-empty") {
          return jsonResponse("", { status: 200, contentType: "text/plain" });
        }
        if (initializedMode === "204-empty") {
          return jsonResponse("", { status: 204, contentType: "text/plain" });
        }
        if (initializedMode === "202-nonempty") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              result: { ok: true, secret: "NON_EMPTY_RESULT_do_not_echo" },
            },
            { status: 202, contentType: "application/json" },
          );
        }
        // SiYuan real-machine: 202 with empty body
        return jsonResponse("", { status: 202, contentType: "text/plain" });
      }
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: FQ_27.map((name) => ({ name })),
          },
        });
      }
      if (body.method === "tools/call") {
        if (toolCallResult === "malformed-empty") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [],
            },
          });
        }
        const tool = body.params?.name;
        if (tool === `${PLUGIN_NS}get_policy`) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [
                {
                  type: "text",
                  text: "POLICY_SECRET_VALUE_should_not_appear",
                },
              ],
              structuredContent: {
                allow: ["notebook-SECRET-id"],
              },
            },
          });
        }
        if (tool === `${PLUGIN_NS}list_accessible_notebooks`) {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              isError: false,
              content: [
                {
                  type: "text",
                  text: "NOTEBOOK_LIST_SECRET_should_not_appear",
                },
              ],
              notebooks: [
                { id: "nb-ELEMENT-SECRET", name: "Private Notebook" },
              ],
            },
          });
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

  it("runMcpSmoke fails when initialize omits session id", async () => {
    const fetchImpl = makeOrchestrationFetch({ sessionId: null });
    await expect(
      runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/SiYuan MCP smoke prerequisite.*Mcp-Session-Id/);
  });

  it("rejects initialize when protocolVersion is missing (fixed error, no raw echo)", async () => {
    const fetchImpl = makeOrchestrationFetch({ protocolVersion: "omit" });
    try {
      await runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe("initialize: protocolVersion missing");
      expect(msg).not.toMatch(/2024|2025|capabilities|result/);
    }
  });

  it("rejects initialize when protocolVersion mismatches (fixed error, no raw echo)", async () => {
    const wrong = "2024-11-05";
    const fetchImpl = makeOrchestrationFetch({ protocolVersion: wrong });
    try {
      await runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe("initialize: protocolVersion mismatch");
      expect(msg).not.toContain(wrong);
      expect(msg).not.toMatch(/2024-11-05|got=|expected=/);
    }
  });

  it("accepts notifications/initialized 202 empty and logs sent only after validation", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      bodies: [],
      headerSnapshots: [],
    };
    const logs: string[] = [];
    const fetchImpl = makeOrchestrationFetch({
      capture,
      initialized: "202-empty",
    });

    await runMcpSmoke({
      token,
      url,
      catalog: CATALOG_27,
      fetchImpl: fetchImpl as typeof fetch,
      log: (line) => logs.push(line),
    });

    expect(capture.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    const initNotif = capture.bodies[1] as { params?: unknown; id?: unknown };
    expect(initNotif.params).toEqual({});
    expect(initNotif).not.toHaveProperty("id");
    expect(logs.some((l) => /initialized notification sent/.test(l))).toBe(
      true,
    );
    expect(logs.some((l) => /http=202/.test(l))).toBe(true);
  });

  it("rejects notifications/initialized JSON-RPC error (code only)", async () => {
    const fetchImpl = makeOrchestrationFetch({ initialized: "error" });
    try {
      await runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toMatch(/notifications\/initialized/);
      expect(msg).toMatch(/code=-32000/);
      expect(msg).not.toContain("SECRET_INITIALIZED_ERROR");
    }
  });

  it("rejects notifications/initialized HTTP 200 empty", async () => {
    const fetchImpl = makeOrchestrationFetch({ initialized: "200-empty" });
    await expect(
      runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/notifications\/initialized: expected HTTP 202/);
  });

  it("rejects notifications/initialized HTTP 204 empty", async () => {
    const fetchImpl = makeOrchestrationFetch({ initialized: "204-empty" });
    await expect(
      runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/notifications\/initialized: expected HTTP 202/);
  });

  it("rejects notifications/initialized HTTP 202 with non-empty result messages", async () => {
    const fetchImpl = makeOrchestrationFetch({ initialized: "202-nonempty" });
    try {
      await runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      });
      expect.fail("should throw");
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toBe("notifications/initialized: expected empty messages");
      expect(msg).not.toContain("NON_EMPTY_RESULT");
      expect(msg).not.toContain("ok");
    }
  });

  it("read-smoke fails on malformed empty tools/call result", async () => {
    const fetchImpl = makeOrchestrationFetch({
      toolCallResult: "malformed-empty",
    });
    await expect(
      runMcpSmoke({
        token,
        url,
        catalog: CATALOG_27,
        readSmoke: true,
        fetchImpl: fetchImpl as typeof fetch,
        log: silent,
      }),
    ).rejects.toThrow(/non-empty content|structuredContent/);
  });

  it("read-smoke calls get_policy then list_accessible_notebooks with safe summaries", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      bodies: [],
      headerSnapshots: [],
    };
    const fetchImpl = makeOrchestrationFetch({ capture });
    const logs: string[] = [];

    const summary = await runMcpSmoke({
      token,
      url,
      catalog: CATALOG_27,
      readSmoke: true,
      fetchImpl: fetchImpl as typeof fetch,
      log: (line) => logs.push(line),
    });

    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
    ]);

    const initNotif = capture.bodies.find(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as { method?: string }).method === "notifications/initialized",
    ) as { params?: unknown } | undefined;
    expect(initNotif?.params).toEqual({});

    expect(summary.readSmoke?.tools).toHaveLength(2);
    expect(summary.readSmoke?.tools[0].tool).toBe(`${PLUGIN_NS}get_policy`);
    expect(summary.readSmoke?.tools[1].tool).toBe(
      `${PLUGIN_NS}list_accessible_notebooks`,
    );

    const joined = [
      ...logs,
      ...summary.readSmoke.tools.map((t: { summary: string }) => t.summary),
    ].join("\n");

    expect(joined).toMatch(/isError=false/);
    expect(joined).toMatch(/structuredContent=/);
    expect(joined).toMatch(/topLevelKeys=/);
    expect(joined).toMatch(/notebooks\.length=1|content\.length=/);
    expect(joined).not.toContain("POLICY_SECRET_VALUE_should_not_appear");
    expect(joined).not.toContain("notebook-SECRET-id");
    expect(joined).not.toContain("nb-ELEMENT-SECRET");
    expect(joined).not.toContain("Private Notebook");
    expect(joined).not.toContain(SESSION);
  });

  it("full mocked contract: strict order, protocol/session/auth headers, safe summary only", async () => {
    const capture: Capture = {
      methods: [],
      toolNames: [],
      bodies: [],
      headerSnapshots: [],
    };
    const logs: string[] = [];
    const fetchImpl = makeOrchestrationFetch({ capture });

    const summary = await runMcpSmoke({
      token,
      url,
      catalog: CATALOG_27,
      readSmoke: true,
      fetchImpl: fetchImpl as typeof fetch,
      log: (line) => logs.push(line),
    });

    expect(capture.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
    ]);
    expect(capture.toolNames).toEqual([
      `${PLUGIN_NS}get_policy`,
      `${PLUGIN_NS}list_accessible_notebooks`,
    ]);

    expect(capture.headerSnapshots).toHaveLength(5);
    for (let i = 0; i < capture.headerSnapshots.length; i += 1) {
      const h = capture.headerSnapshots[i];
      expect(h["mcp-protocol-version"]).toBe("2025-03-26");
      expect(h.authorization).toBe(`Token ${token}`);
      expect(h.accept).toMatch(/application\/json/);
      expect(h["content-type"]).toMatch(/application\/json/);
      if (i === 0) {
        // initialize: session header not yet established
        expect(h["mcp-session-id"]).toBeUndefined();
      } else {
        expect(h["mcp-session-id"]).toBe(SESSION);
      }
    }

    const joined = [...logs, JSON.stringify(summary)].join("\n");
    expect(joined).toMatch(/mcp-smoke PASS/);
    expect(joined).toMatch(/catalog match ok expected=27/);
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(SESSION);
    expect(joined).not.toContain("POLICY_SECRET_VALUE");
    expect(joined).not.toContain("NOTEBOOK_LIST_SECRET");
    expect(joined).not.toContain("Private Notebook");
    expect(summary.session).toBe(true);
    expect(summary.ok).toBe(true);
    expect(summary.catalog).toEqual({ expected: 27, actual: 27, legacy: 0 });
  });
});
