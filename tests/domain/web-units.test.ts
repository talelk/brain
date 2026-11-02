import { describe, expect, it } from "vitest";
import {
  beginDecision, beginRecovery, returnToReview, settleDecision, type ApprovalState,
} from "../../apps/web/src/ui/approval-controller";
import { framesAfter } from "../../apps/web/src/ui/logs/frames";
import { EventSpool } from "../../apps/runner/src/spool";

describe("web and runner unit mechanisms", () => {
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

  it("log tail keeps consuming live frames past the SSE window trim (E092)", () => {
    // createEventStream keeps only the newest 500 frames per connection; an
    // absolute consumption index would shift at the first trim and stall the
    // tail forever. framesAfter consumes by the identity of the last rendered
    // frame instead.
    interface Frame { readonly id: string; readonly streamSeq: number }
    const frame = (seq: number): Frame => ({ id: String(seq), streamSeq: seq });
    const window: Frame[] = [];
    let lastFrame: Frame | undefined;
    const ingested: Frame[] = [];
    const deliver = (from: number, to: number): void => {
      const merged: Frame[] = [];
      for (let seq = from; seq <= to; seq++) merged.push(frame(seq));
      window.push(...merged);
      if (window.length > 500) window.splice(0, window.length - 500);
      const arrivals = framesAfter(window, lastFrame);
      lastFrame = window.at(-1) ?? lastFrame;
      ingested.push(...arrivals);
    };
    // Six 150-frame bursts: 900 delivered over one connection.
    for (let burst = 0; burst < 6; burst++) deliver(burst * 150 + 1, (burst + 1) * 150);
    expect(window.length).toBe(500); // the trim really happened
    expect(ingested.length).toBe(900); // nothing skipped by the index shift
    expect(ingested.at(-1)!.streamSeq).toBe(900);
    // Single-frame drips after deep trimming still land.
    deliver(901, 905);
    expect(ingested.length).toBe(905);
    expect(ingested.at(-1)!.streamSeq).toBe(905);
    // Position is identity: a late arrival whose stream_seq trails the newest
    // still sits after the last frame in the window, so framesAfter reports it
    // and the records merge (appendFresh) drops it by stream_seq.
    window.push(frame(900));
    expect(framesAfter(window, lastFrame).map((e) => e.id)).toEqual(["900"]);
  });
});
