import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EditBlockError,
  normalizeEditBlockReadback,
  performEditBlock,
  type EditBlockIo,
  type EditBlockPolicySlice,
} from "../src/edit-block";
import {
  computeContentHash,
  runWriteTransaction,
} from "../src/write-transaction";

const BLOCK_ID = "20260101120200-blksmok";
const DOC_ID = "20260101120100-docsmok";
const NOTEBOOK_ID = "20240101120000-nbok001";
const KRAMDOWN = "paragraph marker body\n{: id=\"20260101120200-blksmok\"}";
const REPLACEMENT = "replacement markdown";

function nodeSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function basePolicy(
  overrides: Partial<EditBlockPolicySlice> = {},
): EditBlockPolicySlice {
  return {
    operations: { update: "allow", ...overrides.operations },
    safety: {
      blockEdit: {
        requireExpectedState: true,
        defaultConfirm: false,
        ...overrides.safety?.blockEdit,
      },
      referenceProtection:
        overrides.safety?.referenceProtection ?? "warn",
    },
  };
}

function mockIo(
  overrides: Partial<{
    kramdown: string;
    refs: Array<{
      blockId: string;
      documentId: string;
      notebookId: string;
      contentSnippet: string;
    }>;
    getBlockKramdown: EditBlockIo["getBlockKramdown"];
    listReferencingBlocks: EditBlockIo["listReferencingBlocks"];
    updateBlockMarkdown: EditBlockIo["updateBlockMarkdown"];
    runWriteTransaction: EditBlockIo["runWriteTransaction"];
  }> = {},
): EditBlockIo & {
  getBlockKramdown: ReturnType<typeof vi.fn>;
  listReferencingBlocks: ReturnType<typeof vi.fn>;
  updateBlockMarkdown: ReturnType<typeof vi.fn>;
  runWriteTransaction: ReturnType<typeof vi.fn>;
} {
  const kramdown = overrides.kramdown ?? KRAMDOWN;
  const getBlockKramdown =
    (overrides.getBlockKramdown as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => kramdown);
  const listReferencingBlocks =
    (overrides.listReferencingBlocks as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => overrides.refs ?? []);
  const updateBlockMarkdown =
    (overrides.updateBlockMarkdown as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => undefined);
  const runWriteTransaction =
    (overrides.runWriteTransaction as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (opts: { io: { execute: () => Promise<void> } }) => {
      await opts.io.execute();
      return {
        state: "committed",
        record: { id: "txn-test-1" },
        notice: undefined,
        error: undefined,
      };
    });
  return {
    getBlockKramdown,
    listReferencingBlocks,
    updateBlockMarkdown,
    runWriteTransaction,
    computeContentHash,
  };
}

const context = {
  requestedId: BLOCK_ID,
  documentId: DOC_ID,
  notebookId: NOTEBOOK_ID,
  updated: "20260101120200",
};

describe("normalizeEditBlockReadback", () => {
  it("accepts exact body plus one trailing root IAL with correct id", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("accepts additional legitimate attributes in the single root IAL", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" updated="20260101120300" type="p"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("accepts optional trailing LF after the IAL", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}\n`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("accepts LF separator and optional CRLF terminator", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}\r\n`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("accepts CRLF body→IAL separator", () => {
    const observed = `${REPLACEMENT}\r\n{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("accepts CRLF separator plus CRLF terminator", () => {
    const observed = `${REPLACEMENT}\r\n{: id="${BLOCK_ID}"}\r\n`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("preserves expected markdown that ends with LF (natural: body NL + immediate IAL)", () => {
    // Natural SiYuan form: expected 'body\n', observed = expected + IAL (no extra NL).
    // The body's trailing LF is the body→IAL separator (case B).
    const body = `${REPLACEMENT}\n`;
    const observed = `${body}{: id="${BLOCK_ID}"}`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("preserves expected markdown that ends with LF plus extra separator (case A)", () => {
    const body = `${REPLACEMENT}\n`;
    const observed = `${body}\n{: id="${BLOCK_ID}"}`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("preserves expected markdown that ends with CRLF (natural: body CRLF + immediate IAL)", () => {
    // Natural form: expected 'body\r\n', observed = expected + IAL (no extra NL).
    const body = `${REPLACEMENT}\r\n`;
    const observed = `${body}{: id="${BLOCK_ID}"}`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("preserves expected markdown that ends with CRLF plus extra separator (case A)", () => {
    const body = `${REPLACEMENT}\r\n`;
    const observed = `${body}\n{: id="${BLOCK_ID}"}`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("preserves expected markdown that ends with blank lines (natural: immediate IAL)", () => {
    // Body ending blank lines: expected 'body\n\n', observed = expected + IAL.
    const body = `${REPLACEMENT}\n\n`;
    const observed = `${body}{: id="${BLOCK_ID}"}`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("preserves expected markdown that ends with blank lines plus extra separator", () => {
    const body = `${REPLACEMENT}\n\n`;
    const observed = `${body}\n{: id="${BLOCK_ID}"}\n`;
    expect(normalizeEditBlockReadback(observed, body, BLOCK_ID)).toBe(body);
  });

  it("accepts escaped double quotes and backslashes in attribute values", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" title="a\\"b\\\\c"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBe(REPLACEMENT);
  });

  it("rejects wrong block id", () => {
    const observed = `${REPLACEMENT}\n{: id="20260101129999-wrongid"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects missing id attribute", () => {
    const observed = `${REPLACEMENT}\n{: updated="20260101120300"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects wrong id then target id (duplicate id keys)", () => {
    const observed = `${REPLACEMENT}\n{: id="20260101129999-wrongid" id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects target id then wrong id (duplicate id keys)", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" id="20260101129999-wrongid"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects repeated same target id", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects duplicate non-id attribute keys", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" updated="1" updated="2"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it('rejects missing attribute whitespace (id="target"foo="x")', () => {
    // Actual double quotes, no whitespace between attributes.
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"foo="x"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects same-line second IAL", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects extra body after the IAL", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}\nextra line`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects multiple root IALs on separate lines", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"}\n{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects multi-line IAL", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}"\nupdated="1"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects malformed escapes in attribute values", () => {
    const observed = `${REPLACEMENT}\n{: id="${BLOCK_ID}" title="bad\\x"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects missing body→IAL separator when body has no trailing line ending", () => {
    // Case B only applies when expectedMarkdown ends with LF/CRLF.
    // Immediate IAL after a body without a trailing line ending must fail.
    const observed = `${REPLACEMENT}{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects malformed / unparseable IAL", () => {
    expect(
      normalizeEditBlockReadback(
        `${REPLACEMENT}\n{: id=${BLOCK_ID}}`,
        REPLACEMENT,
        BLOCK_ID,
      ),
    ).toBeNull();
    expect(
      normalizeEditBlockReadback(
        `${REPLACEMENT}\n{: id='${BLOCK_ID}'}`,
        REPLACEMENT,
        BLOCK_ID,
      ),
    ).toBeNull();
    expect(
      normalizeEditBlockReadback(
        `${REPLACEMENT}\n{ id="${BLOCK_ID}"}`,
        REPLACEMENT,
        BLOCK_ID,
      ),
    ).toBeNull();
    expect(
      normalizeEditBlockReadback(REPLACEMENT, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });

  it("rejects body that does not exactly match submitted markdown", () => {
    const observed = `other body\n{: id="${BLOCK_ID}"}`;
    expect(
      normalizeEditBlockReadback(observed, REPLACEMENT, BLOCK_ID),
    ).toBeNull();
  });
});

describe("performEditBlock validateOnly", () => {
  it("never writes when validateOnly=true even if update=allow and confirmed=true", async () => {
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const io = mockIo();
    const result = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash,
        confirmed: true,
        validateOnly: true,
      },
      context,
      basePolicy({
        operations: { update: "allow" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: false },
          referenceProtection: "warn",
        },
      }),
      io,
    );
    expect(result).toEqual({
      mode: "validated",
      validated: true,
      writeExecuted: false,
      blockId: BLOCK_ID,
      documentId: DOC_ID,
      notebookId: NOTEBOOK_ID,
      referenceRisk: "none",
      referencingCount: 0,
      referencing: [],
    });
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
    expect(io.getBlockKramdown).toHaveBeenCalledWith(BLOCK_ID);
    expect(io.listReferencingBlocks).toHaveBeenCalledWith(BLOCK_ID);
  });

  it("never writes when validateOnly=true and confirmed=false under allow policy", async () => {
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const io = mockIo();
    const result = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash,
        confirmed: false,
        validateOnly: true,
      },
      context,
      basePolicy({
        operations: { update: "allow" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: false },
          referenceProtection: "warn",
        },
      }),
      io,
    );
    expect(result).toMatchObject({
      mode: "validated",
      validated: true,
      writeExecuted: false,
    });
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });

  it("never writes when validateOnly=true under defaultConfirm=true + confirmed=true", async () => {
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const io = mockIo();
    await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash,
        confirmed: true,
        validateOnly: true,
      },
      context,
      basePolicy({
        operations: { update: "confirm" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: true },
          referenceProtection: "warn",
        },
      }),
      io,
    );
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });

  it("still enforces expectedHash and reports refs without writing", async () => {
    const io = mockIo({
      refs: [
        {
          blockId: "20260101120300-refref1",
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          contentSnippet: "see above",
        },
      ],
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: "bb".repeat(32),
          confirmed: false,
          validateOnly: true,
        },
        context,
        basePolicy(),
        io,
      ),
    ).rejects.toMatchObject({
      code: "state_changed",
    });
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();

    const goodHash = nodeSha256Hex(KRAMDOWN);
    const ok = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash: goodHash,
        confirmed: false,
        validateOnly: true,
      },
      context,
      basePolicy(),
      io,
    );
    expect(ok).toMatchObject({
      mode: "validated",
      referenceRisk: "some",
      referencingCount: 1,
    });
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });

  it("denies validateOnly under referenceProtection=deny when refs exist", async () => {
    const io = mockIo({
      refs: [
        {
          blockId: "20260101120300-refref1",
          documentId: DOC_ID,
          notebookId: NOTEBOOK_ID,
          contentSnippet: "x",
        },
      ],
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: true,
        },
        context,
        basePolicy({
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: false },
            referenceProtection: "deny",
          },
        }),
        io,
      ),
    ).rejects.toBeInstanceOf(EditBlockError);
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
  });
});

describe("performEditBlock write path", () => {
  it("executes SafeWriteTxn when validateOnly=false and confirmed", async () => {
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const io = mockIo();
    const result = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash,
        confirmed: true,
        validateOnly: false,
      },
      context,
      basePolicy({
        operations: { update: "allow" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: false },
          referenceProtection: "warn",
        },
      }),
      io,
    );
    expect(result).toMatchObject({
      blockId: BLOCK_ID,
      documentId: DOC_ID,
      notebookId: NOTEBOOK_ID,
      txnState: "committed",
      verified: true,
      referenceRisk: "none",
      referencingCount: 0,
    });
    expect(io.runWriteTransaction).toHaveBeenCalledTimes(1);
    expect(io.updateBlockMarkdown).toHaveBeenCalledWith(BLOCK_ID, REPLACEMENT);
  });

  it("requires confirmation when policy demands it", async () => {
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const io = mockIo({
      runWriteTransaction: vi.fn(async () => ({
        state: "awaiting_confirmation",
        record: { id: "txn-await" },
        notice: "need confirm",
        error: undefined,
      })),
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash,
          confirmed: false,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "confirm" },
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: true },
            referenceProtection: "warn",
          },
        }),
        io,
      ),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
  });

  it("rejects update=deny without writing", async () => {
    const io = mockIo();
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({ operations: { update: "deny" } }),
        io,
      ),
    ).rejects.toMatchObject({ code: "operation_denied" });
    expect(io.getBlockKramdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });

  it("requireExpectedState=false still rejects expectedHash mismatch and never writes", async () => {
    const io = mockIo();
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: "cc".repeat(32),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: false, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        io,
      ),
    ).rejects.toMatchObject({ code: "state_changed" });
    expect(io.getBlockKramdown).toHaveBeenCalledWith(BLOCK_ID);
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });

  it("requireExpectedState=false still rejects expectedContent mismatch and never writes", async () => {
    const io = mockIo();
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedContent: "stale content that is not current kramdown",
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: false, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        io,
      ),
    ).rejects.toMatchObject({ code: "state_changed" });
    expect(io.updateBlockMarkdown).not.toHaveBeenCalled();
    expect(io.runWriteTransaction).not.toHaveBeenCalled();
  });
});

describe("state hash source for expectedHash", () => {
  it("matches production computeContentHash of kramdown (not SQL text)", async () => {
    const sqlText = "marker only";
    const kramdown = `${sqlText}\n{: id=\"${BLOCK_ID}\"}`;
    expect(await computeContentHash(kramdown)).toBe(nodeSha256Hex(kramdown));
    expect(await computeContentHash(kramdown)).not.toBe(
      nodeSha256Hex(sqlText),
    );
  });
});

describe("performEditBlock production path with real runWriteTransaction", () => {
  function statefulFakeIo(options: {
    afterWrite?: (markdown: string, blockId: string) => string;
  } = {}) {
    let store = KRAMDOWN;
    let executeCount = 0;
    const afterWrite =
      options.afterWrite ??
      ((markdown: string, blockId: string) =>
        `${markdown}\n{: id="${blockId}" updated="20260101129999"}`);

    const getBlockKramdown = vi.fn(async (id: string) => {
      if (id !== BLOCK_ID) {
        throw new Error("unexpected block id");
      }
      return store;
    });
    const updateBlockMarkdown = vi.fn(async (id: string, markdown: string) => {
      executeCount += 1;
      store = afterWrite(markdown, id);
    });
    const listReferencingBlocks = vi.fn(async () => []);

    const io: EditBlockIo = {
      getBlockKramdown,
      listReferencingBlocks,
      updateBlockMarkdown,
      // Real production SafeWriteTxn — no mock commit shortcut.
      runWriteTransaction,
      computeContentHash,
    };

    return {
      io,
      getBlockKramdown,
      updateBlockMarkdown,
      listReferencingBlocks,
      getExecuteCount: () => executeCount,
      getStore: () => store,
    };
  }

  it("commits when readback is replacement plus correct target root IAL", async () => {
    const fake = statefulFakeIo();
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const result = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: REPLACEMENT,
        expectedHash,
        confirmed: true,
        validateOnly: false,
      },
      context,
      basePolicy({
        operations: { update: "allow" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: false },
          referenceProtection: "warn",
        },
      }),
      fake.io,
    );
    expect(result).toMatchObject({
      blockId: BLOCK_ID,
      txnState: "committed",
      verified: true,
    });
    expect(fake.updateBlockMarkdown).toHaveBeenCalledTimes(1);
    expect(fake.updateBlockMarkdown).toHaveBeenCalledWith(BLOCK_ID, REPLACEMENT);
    expect(fake.getExecuteCount()).toBe(1);
    // Store is body + IAL — not bare markdown (proves normalizer path, not raw hash).
    expect(fake.getStore()).toBe(
      `${REPLACEMENT}\n{: id="${BLOCK_ID}" updated="20260101129999"}`,
    );
    expect(fake.getStore()).not.toBe(REPLACEMENT);
  });

  it("commits exact-once for trailing-newline replacement with immediate IAL (case B)", async () => {
    // Submitted markdown ends with LF; SiYuan returns body + immediate root IAL
    // (no extra newline between the body's trailing LF and the IAL).
    const markdownWithTrailingNl = `${REPLACEMENT}\n`;
    const fake = statefulFakeIo({
      afterWrite: (markdown, blockId) =>
        `${markdown}{: id="${blockId}" updated="20260101129999"}`,
    });
    const expectedHash = nodeSha256Hex(KRAMDOWN);
    const result = await performEditBlock(
      {
        blockId: BLOCK_ID,
        markdown: markdownWithTrailingNl,
        expectedHash,
        confirmed: true,
        validateOnly: false,
      },
      context,
      basePolicy({
        operations: { update: "allow" },
        safety: {
          blockEdit: { requireExpectedState: true, defaultConfirm: false },
          referenceProtection: "warn",
        },
      }),
      fake.io,
    );
    expect(result).toMatchObject({
      blockId: BLOCK_ID,
      txnState: "committed",
      verified: true,
    });
    expect(fake.updateBlockMarkdown).toHaveBeenCalledTimes(1);
    expect(fake.updateBlockMarkdown).toHaveBeenCalledWith(
      BLOCK_ID,
      markdownWithTrailingNl,
    );
    expect(fake.getExecuteCount()).toBe(1);
    expect(fake.getStore()).toBe(
      `${markdownWithTrailingNl}{: id="${BLOCK_ID}" updated="20260101129999"}`,
    );
  });

  it("fails closed on wrong block id IAL and executes exactly once with no retry", async () => {
    const fake = statefulFakeIo({
      afterWrite: (markdown) =>
        `${markdown}\n{: id="20260101129999-wrongid"}`,
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        fake.io,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.getExecuteCount()).toBe(1);
    expect(fake.updateBlockMarkdown).toHaveBeenCalledTimes(1);
  });

  it("fails closed on extra body after IAL with execute once and no retry", async () => {
    const fake = statefulFakeIo({
      afterWrite: (markdown, blockId) =>
        `${markdown}\n{: id="${blockId}"}\nextra body`,
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        fake.io,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.getExecuteCount()).toBe(1);
  });

  it("fails closed on multiple root IALs with execute once and no retry", async () => {
    const fake = statefulFakeIo({
      afterWrite: (markdown, blockId) =>
        `${markdown}\n{: id="${blockId}"}\n{: id="${blockId}"}`,
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        fake.io,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.getExecuteCount()).toBe(1);
  });

  it("fails closed on malformed IAL with execute once and no retry", async () => {
    const fake = statefulFakeIo({
      afterWrite: (markdown) => `${markdown}\n{: id=${BLOCK_ID}}`,
    });
    await expect(
      performEditBlock(
        {
          blockId: BLOCK_ID,
          markdown: REPLACEMENT,
          expectedHash: nodeSha256Hex(KRAMDOWN),
          confirmed: true,
          validateOnly: false,
        },
        context,
        basePolicy({
          operations: { update: "allow" },
          safety: {
            blockEdit: { requireExpectedState: true, defaultConfirm: false },
            referenceProtection: "warn",
          },
        }),
        fake.io,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.getExecuteCount()).toBe(1);
  });
});
