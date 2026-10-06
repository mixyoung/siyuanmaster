import { describe, expect, it, vi } from "vitest";
import type * as kernel from "siyuan/kernel";
import { clonePolicy, computePolicyFingerprint, DEFAULT_POLICY, normalizePolicy } from "../src/config";
import type { BlockRecord, KernelApiClient } from "../src/kernel-api";
import type { AuditEntry, PluginPolicy } from "../src/types";
import { deferred, kernelRuntime, runtimeClock, type RuntimeClock } from "./helpers/plugin-runtime";

const NOTEBOOK_ID = "20260101000000-nbok001";
const DOCUMENT_ID = "20260101000001-doc0001";
const PARENT_ID = "20260101000002-parent1";
const JOINER = String.fromCharCode(0x200d);

interface ToolResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

type Handler = (input: Record<string, unknown>) => Promise<ToolResponse>;

interface KernelRuntime {
  policy: PluginPolicy;
  client: KernelApiClient;
  status(): Promise<Record<string, unknown>>;
  registerCreateTool(): Promise<void>;
  registerAppendTool(): Promise<void>;
  registerMemoryTool(): Promise<void>;
  registerUpdateTool(): Promise<void>;
  registerRenameTool(): Promise<void>;
  registerMoveTool(): Promise<void>;
}

function document(id = DOCUMENT_ID, title = "Original"): BlockRecord {
  return {
    id, root_id: id, box: NOTEBOOK_ID, path: `/${id}.sy`, hpath: `/${title}`,
    content: title, type: "d", subtype: "", name: "", alias: "", memo: "", tag: "",
    created: "20260101000000", updated: "20260101000000",
  };
}

async function fixture(clock: RuntimeClock = runtimeClock()) {
  let payload = "[]";
  const handlers = new Map<string, Handler>();
  const api = {
    plugin: { lifecycle: {} },
    agent: {
      registerCapability: vi.fn(async (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      }),
    },
    client: { fetch: vi.fn(async () => { throw new Error("Unexpected HTTP in runtime test"); }) },
    storage: {
      get: vi.fn(async () => ({ json: async () => JSON.parse(payload) as unknown })),
      put: vi.fn(async (_key: string, value: string) => { payload = value; }),
      list: vi.fn(async () => [{ name: "audit.json" }]),
    },
    logger: { warn: vi.fn(async () => undefined), info: vi.fn(async () => undefined) },
  } as unknown as kernel.ISiyuan;
  const plugin = await kernelRuntime<KernelRuntime>(api, clock);
  plugin.policy = normalizePolicy({
    ...DEFAULT_POLICY,
    access: { ...DEFAULT_POLICY.access, selectedNotebookIds: [NOTEBOOK_ID] },
    operations: { ...DEFAULT_POLICY.operations, update: "allow", rename: "allow", move: "allow" },
    tagging: { ...DEFAULT_POLICY.tagging, mode: "off" },
  });
  const source = document();
  const parent = document(PARENT_ID, "Parent");
  const client = plugin.client;
  client.listNotebooks = vi.fn(async () => [{ id: NOTEBOOK_ID, name: "Test notebook" }]);
  client.getDocumentContext = vi.fn(async (id: string) => {
    const target = id === PARENT_ID ? parent : source;
    return { requested: target, document: target };
  });
  client.findDocumentByHPath = vi.fn(async () => undefined);
  client.countDocumentTree = vi.fn(async () => 1);
  client.getBlockAttrs = vi.fn(async () => ({}));
  client.createDocument = vi.fn(async () => DOCUMENT_ID);
  client.appendMarkdown = vi.fn(async () => undefined);
  client.updateDocument = vi.fn(async () => undefined);
  client.renameDocument = vi.fn(async () => undefined);
  client.moveDocument = vi.fn(async () => undefined);
  return {
    plugin, client, source, parent,
    handler: (name: string) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Unregistered test capability: ${name}`);
      return handler;
    },
    audit: () => JSON.parse(payload) as AuditEntry[],
  };
}

async function structureFixture(kind: "rename" | "move", clock: RuntimeClock = runtimeClock()) {
  const setup = await fixture(clock);
  const { plugin } = setup;
  if (kind === "rename") await plugin.registerRenameTool();
  else await plugin.registerMoveTool();
  const handler = setup.handler(`${kind}_note`);
  const input = kind === "rename"
    ? { documentId: DOCUMENT_ID, newTitle: "Renamed" }
    : { documentId: DOCUMENT_ID, targetNotebookId: NOTEBOOK_ID, targetParentDocumentId: PARENT_ID };
  const preview = await handler(input);
  expect(preview.ok).toBe(true);
  expect(preview.result?.previewToken).toEqual(expect.any(String));
  return {
    ...setup,
    execute: () => handler({ ...input, previewToken: preview.result!.previewToken, confirmed: true }),
    write: kind === "rename" ? setup.client.renameDocument : setup.client.moveDocument,
  };
}

describe("kernel write-result regression", () => {
  it.each(["create", "append", "memory-create", "memory-append"] as const)(
    "%s returns outcome_unknown when the body committed but its response failed",
    async (kind) => {
      const { plugin, client, handler, audit } = await fixture();
      if (kind === "create") await plugin.registerCreateTool();
      else if (kind === "append") await plugin.registerAppendTool();
      else await plugin.registerMemoryTool();
      let committed = 0;
      const write = vi.fn(async () => {
        committed += 1;
        throw new Error("response lost after commit");
      });
      const creates = kind === "create" || kind === "memory-create";
      if (creates) client.createDocument = write;
      else client.appendMarkdown = write;
      const input = creates
        ? { notebookId: NOTEBOOK_ID, title: "Regression", markdown: "body" }
        : { documentId: DOCUMENT_ID, markdown: "body" };
      const result = await handler(kind.startsWith("memory") ? "save_memory" : `${kind}_note`)(input);

      expect(committed).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(result.error?.code).toBe("outcome_unknown");
      expect(result.error?.message).toContain("do not auto-retry");
      expect(result.error?.message).toContain("read back");
      expect(audit().at(-1)?.outcome).toBe("failed");
    },
  );

  it.each(["rename", "move"] as const)("%s distinguishes post-write state mismatch from an unwritten change", async (kind) => {
    const setup = await structureFixture(kind);
    const result = await setup.execute();

    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(result.error?.code).toBe("verification_failed");
    expect(result.error?.message).toContain("do not auto-retry");
    expect(result.error?.message).toContain(DOCUMENT_ID);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s returns outcome_unknown if its write API loses the response", async (kind) => {
    const setup = await structureFixture(kind);
    vi.mocked(setup.write).mockRejectedValue(new Error("write response unavailable"));
    const result = await setup.execute();

    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(result.error?.code).toBe("outcome_unknown");
    expect(result.error?.message).toContain("do not auto-retry");
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s returns outcome_unknown if post-write readback is unavailable", async (kind) => {
    const setup = await structureFixture(kind);
    let written = false;
    vi.mocked(setup.write).mockImplementation(async () => { written = true; });
    vi.mocked(setup.client.getDocumentContext).mockImplementation(async (id) => {
      if (written) throw new Error("readback transport unavailable");
      const target = id === PARENT_ID ? setup.parent : setup.source;
      return { requested: target, document: target };
    });
    const result = await setup.execute();

    expect(written).toBe(true);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(result.error?.code).toBe("outcome_unknown");
    expect(result.error?.message).toContain("do not auto-retry");
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s records a pre-write state change as unexecuted, not policy denial", async (kind) => {
    const setup = await structureFixture(kind);
    setup.source.updated = "20260102000000";
    const result = await setup.execute();

    expect(setup.write).not.toHaveBeenCalled();
    expect(result.error?.code).toBe("state_changed");
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
    expect(setup.audit().at(-1)?.message).toContain("not executed");
  });

  it("keeps real operation-policy denial separate from write failures", async () => {
    const { plugin, client, handler, audit } = await fixture();
    plugin.policy.operations.rename = "deny";
    await plugin.registerRenameTool();
    const result = await handler("rename_note")({ documentId: DOCUMENT_ID, newTitle: "Renamed" });

    expect(result.error?.code).toBe("operation_denied");
    expect(client.getDocumentContext).not.toHaveBeenCalled();
    expect(client.renameDocument).not.toHaveBeenCalled();
    expect(audit().at(-1)?.outcome).toBe("denied");
  });

  it("records a failed update snapshot as unexecuted, not policy denial", async () => {
    const { plugin, client, handler, audit } = await fixture();
    await plugin.registerUpdateTool();
    client.exportMarkdown = vi.fn(async () => { throw new Error("snapshot unavailable"); });
    const result = await handler("update_note")({ documentId: DOCUMENT_ID, markdown: "replacement" });

    expect(client.updateDocument).not.toHaveBeenCalled();
    expect(result.error?.code).toBe("state_changed");
    expect(audit().at(-1)?.outcome).toBe("failed");
    expect(audit().at(-1)?.message).toContain("not executed");
  });

  it.each(["append", "update"] as const)("%s preserves tag partial success and accurate readback wording", async (kind) => {
    const { plugin, client, handler, audit } = await fixture();
    let written = false;
    client.getBlockAttrs = vi.fn(async () => {
      if (written) throw new Error("tag update unavailable");
      return {};
    });
    if (kind === "append") {
      await plugin.registerAppendTool();
      client.appendMarkdown = vi.fn(async () => { written = true; });
    } else {
      await plugin.registerUpdateTool();
      client.exportMarkdown = vi.fn(async () => ({ hPath: "/Original", content: written ? "replacement" : "original" }));
      client.updateDocument = vi.fn(async () => { written = true; });
    }
    const result = await handler(`${kind}_note`)({ documentId: DOCUMENT_ID, markdown: "replacement" });

    expect(result.ok).toBe(true);
    expect(result.result?.tagStatus).toBe("failed");
    expect(result.result?.reason).toEqual(expect.stringContaining(
      kind === "update" ? "verified by readback" : "no independent readback",
    ));
    expect(audit().at(-1)?.outcome).toBe("allowed");
    expect(audit().at(-1)?.message).toContain("partial success");
  });
});

describe("document update readback compatibility", () => {
  it.each([
    ["exact body", "replacement", "replacement"],
    ["one export LF", "replacement", "replacement\n"],
    ["empty document", "", "\n"],
    ["empty export paragraph placeholder", "", `${JOINER}\n`],
    ["submitted literal joiner", JOINER, `${JOINER}\n`],
    ["exact empty document", "", ""],
    ["closed code fence", "```ts\nconst x = 1;\n```", "```ts\nconst x = 1;\n```\n"],
    ["submitted LF", "replacement\n", "replacement\n"],
    ["exact CRLF", "first\r\nsecond\r\n", "first\r\nsecond\r\n"],
    ["exact multiple LFs", "replacement\n\n", "replacement\n\n"],
    ["exact significant spaces", "first  \nsecond\n", "first  \nsecond\n"],
  ])("accepts %s without changing submitted Markdown", async (_name, markdown, observed) => {
    const { plugin, client, handler, audit } = await fixture();
    await plugin.registerUpdateTool();
    let written = false;
    client.updateDocument = vi.fn(async () => { written = true; });
    client.exportMarkdown = vi.fn(async () => ({ hPath: "/Original", content: written ? observed : "original\n" }));
    const result = await handler("update_note")({ documentId: DOCUMENT_ID, markdown });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ txnState: "committed", verified: true });
    expect(client.updateDocument).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, markdown);
    expect(client.exportMarkdown).toHaveBeenCalledTimes(3);
    expect(audit().at(-1)?.outcome).toBe("allowed");
  });

  it.each([
    ["changed body", "replacement", "different\n"],
    ["placeholder without EOF LF", "", JOINER],
    ["duplicate empty placeholders", "", `${JOINER}${JOINER}\n`],
    ["empty placeholder with extra space", "", `${JOINER} \n`],
    ["empty placeholder with extra LF", "", `${JOINER}\n\n`],
    ["removed literal body joiner", `first${JOINER}second`, "firstsecond\n"],
    ["placeholder added to nonempty body", "replacement", `replacement${JOINER}\n`],
    ["missing body", "replacement", "\n"],
    ["two added LFs", "replacement", "replacement\n\n"],
    ["extra LF after submitted LF", "replacement\n", "replacement\n\n"],
    ["removed submitted LF", "replacement\n", "replacement"],
    ["collapsed multiple LFs", "replacement\n\n", "replacement\n"],
    ["normalized interior CRLF", "first\r\nsecond\r\n", "first\nsecond\n"],
    ["terminal CR", "replacement\r", "replacement\r\n"],
    ["stripped leading spaces", "  replacement", "replacement\n"],
    ["stripped hard-break spaces", "first  \nsecond\n", "first\nsecond\n"],
    ["changed code whitespace", "```ts\n  const x = 1;\n```", "```ts\nconst x = 1;\n```\n"],
    ["added root IAL", "replacement", `replacement\n{: id=\"${DOCUMENT_ID}\"}\n`],
  ])("rejects %s rather than trimming or retrying", async (_name, markdown, observed) => {
    const { plugin, client, handler, audit } = await fixture();
    await plugin.registerUpdateTool();
    let written = false;
    client.updateDocument = vi.fn(async () => { written = true; });
    client.exportMarkdown = vi.fn(async () => ({ hPath: "/Original", content: written ? observed : "original\n" }));
    const result = await handler("update_note")({ documentId: DOCUMENT_ID, markdown });

    expect(result.error?.code).toBe("verification_failed");
    expect(result.error?.message).toContain("do not auto-retry");
    expect(client.updateDocument).toHaveBeenCalledExactlyOnceWith(DOCUMENT_ID, markdown);
    expect(audit().at(-1)?.outcome).toBe("failed");
  });

  it("keeps a single LF difference in the pre-write snapshot strict", async () => {
    const { plugin, client, handler, audit } = await fixture();
    await plugin.registerUpdateTool();
    client.exportMarkdown = vi.fn()
      .mockResolvedValueOnce({ hPath: "/Original", content: "original" })
      .mockResolvedValueOnce({ hPath: "/Original", content: "original\n" });
    const result = await handler("update_note")({ documentId: DOCUMENT_ID, markdown: "replacement" });

    expect(result.error?.code).toBe("state_changed");
    expect(client.updateDocument).not.toHaveBeenCalled();
    expect(audit().at(-1)?.message).toContain("not executed");
  });

  it.each(["write", "readback"] as const)("keeps %s failure uncertain and never retries", async (stage) => {
    const { plugin, client, handler, audit } = await fixture();
    await plugin.registerUpdateTool();
    let written = false;
    client.updateDocument = vi.fn(async () => {
      written = true;
      if (stage === "write") throw new Error("response unavailable");
    });
    client.exportMarkdown = vi.fn(async () => {
      if (written) throw new Error("readback unavailable");
      return { hPath: "/Original", content: "original\n" };
    });
    const result = await handler("update_note")({ documentId: DOCUMENT_ID, markdown: "replacement" });

    expect(result.error?.code).toBe("outcome_unknown");
    expect(result.error?.message).toContain("do not auto-retry");
    expect(client.updateDocument).toHaveBeenCalledTimes(1);
    expect(audit().at(-1)?.outcome).toBe("failed");
  });
});

function expectedStructure(source: BlockRecord, kind: "rename" | "move"): BlockRecord {
  return kind === "rename"
    ? { ...source, content: "Renamed", hpath: "/Renamed" }
    : { ...source, path: `/${PARENT_ID}/${DOCUMENT_ID}.sy`, hpath: "/Parent/Original" };
}

function observeStructure(
  setup: Awaited<ReturnType<typeof structureFixture>>,
  read: () => Promise<BlockRecord>,
) {
  let written = false;
  let reads = 0;
  vi.mocked(setup.write).mockImplementation(async () => { written = true; });
  vi.mocked(setup.client.getDocumentContext).mockImplementation(async (id) => {
    if (written) {
      reads += 1;
      const target = await read();
      return { requested: target, document: target };
    }
    const target = id === PARENT_ID ? setup.parent : setup.source;
    return { requested: target, document: target };
  });
  return () => reads;
}

describe("bounded structure readback", () => {
  it.each(["rename", "move"] as const)("%s returns immediately when every target field matches", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const start = clock.now();
    const reads = observeStructure(setup, async () => expectedStructure(setup.source, kind));
    const result = await setup.execute();

    expect(result.ok).toBe(true);
    expect(reads()).toBe(1);
    expect(clock.now()).toBe(start);
    expect(clock.pending()).toBe(0);
    expect(setup.write).toHaveBeenCalledTimes(1);
  });

  it.each(["rename", "move"] as const)("%s rejects a matching read that returns after the deadline", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const reads = observeStructure(setup, async () => {
      clock.advance(5001);
      return expectedStructure(setup.source, kind);
    });
    const result = await setup.execute();

    expect(result.error?.code).toBe("outcome_unknown");
    expect(reads()).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s stops on a transport error after a stale read", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    let attempts = 0;
    const reads = observeStructure(setup, async () => {
      if (++attempts === 2) throw new Error("readback disconnected");
      return setup.source;
    });
    const result = await setup.execute();

    expect(result.error?.code).toBe("outcome_unknown");
    expect(reads()).toBe(2);
    expect(clock.pending()).toBe(0);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s accepts delayed SQL visibility without a second write", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const start = clock.now();
    const expected = expectedStructure(setup.source, kind);
    const reads = observeStructure(setup, async () => clock.now() - start >= 1500 ? expected : setup.source);
    const result = await setup.execute();

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ mode: "executed", verified: true });
    expect(clock.now() - start).toBeGreaterThanOrEqual(1500);
    expect(clock.now() - start).toBeLessThanOrEqual(5000);
    expect(reads()).toBeLessThanOrEqual(21);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("allowed");
    expect(clock.pending()).toBe(0);
  });

  it.each(["rename", "move"] as const)("%s stops persistent mismatch at the total deadline", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const start = clock.now();
    const reads = observeStructure(setup, async () => setup.source);
    const result = await setup.execute();

    expect(result.error?.code).toBe("verification_failed");
    expect(clock.now() - start).toBe(5000);
    expect(reads()).toBeGreaterThan(8);
    expect(reads()).toBeLessThanOrEqual(21);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
    expect(clock.pending()).toBe(0);
  });

  it.each(["rename", "move"] as const)("%s includes slow reads in the deadline", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const start = clock.now();
    const reads = observeStructure(setup, () => new Promise(resolve => {
      clock.setTimeout(() => resolve(setup.source), 2000);
    }));
    const result = await setup.execute();

    expect(result.error?.code).toBe("outcome_unknown");
    expect(clock.now() - start).toBe(5000);
    expect(reads()).toBe(3);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });

  it.each(["rename", "move"] as const)("%s bounds a hung read and ignores its late success", async (kind) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const pending = deferred<BlockRecord>();
    const start = clock.now();
    const reads = observeStructure(setup, () => pending.promise);
    let watchdog = 0;
    const result = await Promise.race([
      setup.execute(),
      new Promise<ToolResponse>(resolve => {
        watchdog = clock.setTimeout(() => resolve({
          ok: false, error: { code: "test_unbounded_read", message: "No result within the verification budget" },
        }), 6000);
      }),
    ]);
    clock.clearTimeout(watchdog);
    const auditBefore = setup.audit();

    expect(result.error?.code).toBe("outcome_unknown");
    expect(clock.now() - start).toBe(5000);
    expect(reads()).toBe(1);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    pending.resolve(expectedStructure(setup.source, kind));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.ok).toBe(false);
    expect(setup.audit()).toEqual(auditBefore);
    expect(reads()).toBe(1);
  });

  it.each(["rename", "move"] as const)("%s caps attempts even if the clock does not progress", async (kind) => {
    const clock = runtimeClock();
    const start = clock.now();
    const setup = await structureFixture(kind, { ...clock, now: () => start });
    const reads = observeStructure(setup, async () => setup.source);
    const result = await setup.execute();

    expect(result.error?.code).toBe("verification_failed");
    expect(reads()).toBe(21);
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it.each([
    ["rename", "content"], ["rename", "hpath"], ["rename", "box"],
    ["move", "box"], ["move", "path"], ["move", "hpath"],
  ] as const)("%s does not accept a mismatched %s", async (kind, field) => {
    const clock = runtimeClock();
    const setup = await structureFixture(kind, clock);
    const observed = { ...expectedStructure(setup.source, kind), [field]: "wrong" };
    observeStructure(setup, async () => observed);
    const result = await setup.execute();

    expect(result.error?.code).toBe("verification_failed");
    expect(setup.write).toHaveBeenCalledTimes(1);
    expect(setup.audit().at(-1)?.outcome).toBe("failed");
  });
});

describe("kernel policy status snapshot", () => {
  it("uses one deep snapshot for fingerprint and every policy-dependent status field", async () => {
    const { plugin } = await fixture();
    const snapshot = clonePolicy(plugin.policy);
    const expectedFingerprint = await computePolicyFingerprint(snapshot);
    const pending = plugin.status();
    plugin.policy.access.mode = "denylist";
    plugin.policy.access.selectedNotebookIds.push("20260101000000-denied1");
    plugin.policy.tagging.mode = "always";
    plugin.policy.safety.referenceProtection = "deny";
    plugin.policy.safety.permissionInheritance = false;
    const status = await pending;

    expect(status.policyFingerprint).toBe(expectedFingerprint);
    expect(status.accessMode).toBe(snapshot.access.mode);
    expect(status.selectedNotebookCount).toBe(snapshot.access.selectedNotebookIds.length);
    expect(status.taggingMode).toBe(snapshot.tagging.mode);
    expect(status.safety).toEqual(snapshot.safety);
    expect(status.safety).not.toBe(plugin.policy.safety);
    expect(status.capabilities).toMatchObject({
      referenceProtection: snapshot.safety.referenceProtection,
      permissionInheritance: snapshot.safety.permissionInheritance,
    });
  });
});
