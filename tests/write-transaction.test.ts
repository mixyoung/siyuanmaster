import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  computeContentHash,
  isTerminal,
  newTxnRecord,
  runWriteTransaction,
  transition,
  TxnError,
  type WriteIo,
} from "../src/write-transaction";
import { TXN_INVARIANTS, TXN_NAME } from "../src/generated/capabilities";

/** Node reference digest used only in tests (production path is pure TS). */
function nodeSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function mockIo(overrides: Partial<WriteIo> = {}): WriteIo & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute =
    (overrides.execute as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => undefined);
  return {
    snapshot:
      overrides.snapshot ?? (async () => ({ hash: "aa".repeat(32) })),
    verifyCurrent:
      overrides.verifyCurrent ?? (async () => "aa".repeat(32)),
    execute,
    readback: overrides.readback ?? (async () => "bb".repeat(32)),
  };
}

describe("Safe Write Transaction", () => {
  it("uses catalog transaction name and invariants", () => {
    expect(TXN_NAME).toBe("SafeWriteTxn");
    expect(TXN_INVARIANTS).toContain("snapshot_failure_stops");
    expect(TXN_INVARIANTS).toContain("no_auto_retry_on_uncertain");
  });

  it("stops on snapshot failure and never executes", async () => {
    const io = mockIo({
      snapshot: async () => {
        throw new Error("disk unavailable");
      },
    });
    const result = await runWriteTransaction({
      kind: "update_note",
      io,
      confirmed: true,
      requireConfirmation: false,
      expectedReadbackHash: "bb".repeat(32),
    });
    expect(result.state).toBe("failed");
    expect(result.error).toBe("snapshot_failed");
    expect(io.execute).not.toHaveBeenCalled();
  });

  it("aborts on pre-execute state drift without writing", async () => {
    const io = mockIo({
      verifyCurrent: async () => "cc".repeat(32),
    });
    const result = await runWriteTransaction({
      kind: "update_note",
      io,
      confirmed: true,
      requireConfirmation: false,
      expectedReadbackHash: "bb".repeat(32),
    });
    expect(result.state).toBe("failed");
    expect(result.error).toBe("state_changed");
    expect(io.execute).not.toHaveBeenCalled();
  });

  it("marks unknown when execute throws and does not retry", async () => {
    const io = mockIo({
      execute: vi.fn(async () => {
        throw new Error("network blip");
      }),
    });
    const result = await runWriteTransaction({
      kind: "edit_block",
      io,
      confirmed: true,
      requireConfirmation: false,
      expectedReadbackHash: "bb".repeat(32),
    });
    expect(result.state).toBe("unknown");
    expect(result.error).toBe("outcome_unknown");
    expect(io.execute).toHaveBeenCalledTimes(1);
    expect(isTerminal(result.state)).toBe(true);
  });

  it("commits only after successful readback", async () => {
    const expected = "bb".repeat(32);
    const io = mockIo({
      readback: async () => expected,
    });
    const result = await runWriteTransaction({
      kind: "update_note",
      io,
      confirmed: true,
      requireConfirmation: false,
      expectedReadbackHash: expected,
    });
    expect(result.state).toBe("committed");
    expect(io.execute).toHaveBeenCalledTimes(1);
  });

  it("fails on readback mismatch", async () => {
    const io = mockIo({
      readback: async () => "dd".repeat(32),
    });
    const result = await runWriteTransaction({
      kind: "update_note",
      io,
      confirmed: true,
      requireConfirmation: false,
      expectedReadbackHash: "bb".repeat(32),
    });
    expect(result.state).toBe("failed");
    expect(result.error).toBe("readback_mismatch");
  });

  it("returns awaiting_confirmation without executing", async () => {
    const io = mockIo();
    const result = await runWriteTransaction({
      kind: "edit_block",
      io,
      confirmed: false,
      requireConfirmation: true,
      expectedReadbackHash: "bb".repeat(32),
    });
    expect(result.state).toBe("awaiting_confirmation");
    expect(io.execute).not.toHaveBeenCalled();
  });

  it("rejects transitions after finalization (exactly once)", () => {
    const record = newTxnRecord("t1", "update_note");
    transition(record, "prepare");
    transition(record, "snapshot_ok");
    transition(record, "confirm");
    transition(record, "execute");
    transition(record, "readback_ok");
    expect(record.state).toBe("committed");
    expect(() => transition(record, "execute")).toThrow(TxnError);
  });

  it("computes stable sha-256 hex digests", async () => {
    const hash = await computeContentHash("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeContentHash("hello")).toBe(hash);
    expect(await computeContentHash("hello!")).not.toBe(hash);
  });
});

describe("computeContentHash pure runtime", () => {
  // FIPS / NIST well-known SHA-256 vectors over UTF-8 bytes.
  it("matches known SHA-256 vectors for empty, abc/hello, Chinese, and emoji", async () => {
    expect(await computeContentHash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await computeContentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await computeContentHash("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    // "思源" UTF-8 = E6 80 9D E6 BA 90
    expect(await computeContentHash("思源")).toBe(
      "4f08835864604dade4571087aeeac73ba8e08ec05ac451c1d695b1817f607245",
    );
    // U+1F600 😀 UTF-8 = F0 9F 98 80 (UTF-16 surrogate pair)
    expect(await computeContentHash("😀")).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );
  });

  it("matches node:crypto for mixed Unicode and unpaired surrogates", async () => {
    const mixed = "hello 思源 笔记 😀 — café\nline2";
    expect(await computeContentHash(mixed)).toBe(nodeSha256Hex(mixed));

    const unpairedHigh = `prefix${String.fromCharCode(0xd800)}suffix`;
    const unpairedLow = `prefix${String.fromCharCode(0xdc00)}suffix`;
    const loneHigh = String.fromCharCode(0xdbff);
    const loneLow = String.fromCharCode(0xdfff);
    // node:crypto with 'utf8' replaces unpaired surrogates with U+FFFD,
    // matching TextEncoder / our encoder.
    expect(await computeContentHash(unpairedHigh)).toBe(
      nodeSha256Hex(unpairedHigh),
    );
    expect(await computeContentHash(unpairedLow)).toBe(
      nodeSha256Hex(unpairedLow),
    );
    expect(await computeContentHash(loneHigh)).toBe(nodeSha256Hex(loneHigh));
    expect(await computeContentHash(loneLow)).toBe(nodeSha256Hex(loneLow));
  });

  it("handles SHA-256 padding boundaries around 55/56/63/64 bytes", async () => {
    // UTF-8 lengths that stress single-block vs two-block padding.
    for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const ascii = "a".repeat(len);
      expect(await computeContentHash(ascii)).toBe(nodeSha256Hex(ascii));
    }
    // Multi-byte characters near block boundaries (each 思 is 3 bytes).
    for (const count of [17, 18, 19, 20, 21]) {
      const chinese = "思".repeat(count);
      expect(await computeContentHash(chinese)).toBe(nodeSha256Hex(chinese));
    }
  });

  it("hashes large inputs correctly", async () => {
    const large = `${"思源笔记".repeat(4096)}\n${"x".repeat(50_000)}😀`;
    expect(large.length).toBeGreaterThan(10_000);
    expect(await computeContentHash(large)).toBe(nodeSha256Hex(large));
  });

  it("succeeds when globalThis.TextEncoder and globalThis.crypto are unavailable", async () => {
    const globalRef = globalThis as typeof globalThis & {
      TextEncoder?: unknown;
      crypto?: unknown;
    };
    const savedTextEncoder = globalRef.TextEncoder;
    const savedCrypto = globalRef.crypto;
    try {
      // Simulate SiYuan kernel: no TextEncoder, no Web Crypto.
      delete globalRef.TextEncoder;
      delete globalRef.crypto;
      expect(globalRef.TextEncoder).toBeUndefined();
      expect(globalRef.crypto).toBeUndefined();

      const hash = await computeContentHash("hello 思源 😀");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(nodeSha256Hex("hello 思源 😀"));
      expect(await computeContentHash("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    } finally {
      if (savedTextEncoder !== undefined) {
        globalRef.TextEncoder = savedTextEncoder;
      }
      if (savedCrypto !== undefined) {
        globalRef.crypto = savedCrypto;
      }
    }
    // Globals restored for subsequent tests / process health.
    expect(globalRef.TextEncoder).toBe(savedTextEncoder);
    expect(globalRef.crypto).toBe(savedCrypto);
  });

  it("production write-transaction path has no runtime hashing host deps", () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../src/write-transaction.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    // Forbidden host APIs in production hashing (code tokens, not comments alone).
    expect(source).not.toMatch(/\bnew\s+TextEncoder\b/);
    expect(source).not.toMatch(/\bcrypto\.subtle\b/);
    expect(source).not.toMatch(/\bglobalThis\.crypto\b/);
    expect(source).not.toMatch(/\bfrom\s+["']node:crypto["']/);
    expect(source).not.toMatch(/\brequire\s*\(\s*["'](?:node:)?crypto["']\s*\)/);
    expect(source).not.toMatch(/\bBuffer\.(?:from|alloc|isBuffer)\b/);
    // Positive markers that the pure implementation is present.
    expect(source).toContain("function encodeUtf8");
    expect(source).toContain("function sha256Bytes");
    expect(source).toContain("export async function computeContentHash");
  });
});
