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
