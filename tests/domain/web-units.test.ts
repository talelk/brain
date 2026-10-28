import { describe, expect, it } from "vitest";
import { visibleWindow } from "../../apps/web/src/ui/window-list";
import {
  beginDecision, beginRecovery, returnToReview, settleDecision, type ApprovalState,
} from "../../apps/web/src/ui/approval-controller";
import { EventSpool } from "../../apps/runner/src/spool";

describe("web and runner unit mechanisms", () => {
  it("windowed list bounds rendered rows and preserves scroll geometry (E092)", () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    const top = visibleWindow(items, 0, 52, 480);
    expect(top.items.length).toBeLessThan(30);
    expect(top.topPadPx).toBe(0);
    expect(top.items[0]).toBe(0);
    const mid = visibleWindow(items, 52 * 5000, 52, 480);
    expect(mid.items).toContain(5000);
    expect(mid.topPadPx + mid.items.length * 52 + mid.bottomPadPx).toBe(10_000 * 52);
    const beyond = visibleWindow(items, 52 * 99_999, 52, 480);
    expect(beyond.end).toBe(10_000);
    expect(beyond.bottomPadPx).toBe(0);
    expect(visibleWindow([], 0, 52, 480).items).toEqual([]);
  });

  it("stale approvals settle to review-again with the captured intent preserved (E094)", () => {
    const proposal = { approvalId: "a1", subjectDigest: "d1", expectedVersion: 3 };
    let state: ApprovalState = beginDecision({ status: "review" }, proposal, "looks right", "k-1");
    state = settleDecision(state, "stale");
    expect(state.status).toBe("stale");
    if (state.status === "stale") {
      expect(state.intent.note).toBe("looks right"); // note preserved across stale
      expect(state.intent.expectedVersion).toBe(3);
      expect(state.intent.idempotencyKey).toBe("k-1");
    }
    expect(() => beginDecision(state, proposal, "again", "k-2")).toThrow(); // cannot re-decide without review
    state = returnToReview(state);
    expect(state.status).toBe("review");
    // Uncertain outcomes recover the original intent, never a fresh decision.
    let s2 = beginDecision({ status: "review" }, proposal, "note", "k-3");
    s2 = settleDecision(s2, "pending");
    expect(s2.status).toBe("unknown");
    const s3 = beginRecovery(s2);
    if (s3.status === "checking") expect(s3.intent.idempotencyKey).toBe("k-3");
  });

  it("runner spool backpressures telemetry but retains effect evidence (E072)", () => {
    const spool = new EventSpool(3, 10_000);
    expect(spool.push({ sequence: 1, kind: "text", payload: "a" })).toBe("accepted");
    expect(spool.push({ sequence: 1, kind: "text", payload: "a" })).toBe("duplicate");
    spool.push({ sequence: 2, kind: "text", payload: "b" });
    spool.push({ sequence: 3, kind: "text", payload: "c" });
    expect(spool.push({ sequence: 4, kind: "text", payload: "d" })).toBe("backpressure");
    // Effect events evict the oldest telemetry instead of being dropped.
    expect(spool.push({ sequence: 5, kind: "effect", payload: { ref: "x" } })).toBe("accepted");
    expect(spool.stats()).toMatchObject({ depth: 3, droppedTelemetry: 1, lastSequence: 5 });
    const drained = spool.drain(3);
    expect(drained.map((e) => e.sequence)).toEqual([2, 3, 5]);
    expect(spool.stats().depth).toBe(0);
    // Byte bound applies too.
    const small = new EventSpool(100, 120);
    expect(small.push({ sequence: 1, kind: "text", payload: "x".repeat(200) })).toBe("backpressure");
  });
});
