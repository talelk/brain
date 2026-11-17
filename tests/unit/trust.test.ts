import { approvalSubjectDigest, nextCron, type JsonValue, type SnapshotManifest } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import { inputProblem } from "../../apps/governor/src/tools/schema";
import { approvalSubject, standingCovers } from "../../apps/governor/src/trust/approvals";
import { inputSchema } from "../../apps/governor/src/workspace/load";

const tool = { description: "Restarts a container.", effect: "privileged", timeout_seconds: 90, needs: [], network: [], secrets: [], host_command: "host.restart", inputs: {}, source: "sre", input_schema: {}, files: [] };
const manifest = { tools: { "host.restart": tool } } as unknown as SnapshotManifest;
const call = { tool: "host.restart", input: { container: "web-1" } as JsonValue, taskId: "t_1", snapshotDigest: `sha256:${"a".repeat(64)}` };
const digest = (subject: object): string => approvalSubjectDigest(subject as JsonValue);

describe("the approval subject", () => {
  it("binds the tool and its definition, the input, the task and the snapshot", () => {
    const subject = approvalSubject(manifest, call);
    expect(subject).toMatchObject({ tool: "host.restart", input: { container: "web-1" }, taskId: "t_1", snapshotDigest: call.snapshotDigest });
    expect(subject.toolDigest).toMatch(/^sha256:/u);
    expect(subject).not.toHaveProperty("patchDigest");
    expect(digest(subject)).toBe(digest(approvalSubject(manifest, { ...call, input: { container: "web-1" } })));
  });
  it("has another digest when the input, the task, the snapshot, the tool's definition or the patch differ", () => {
    const base = digest(approvalSubject(manifest, call));
    const changed = [
      approvalSubject(manifest, { ...call, input: { container: "web-2" } }), approvalSubject(manifest, { ...call, taskId: "t_2" }), approvalSubject(manifest, { ...call, snapshotDigest: `sha256:${"b".repeat(64)}` }),
      approvalSubject({ tools: { "host.restart": { ...tool, timeout_seconds: 5 } } } as unknown as SnapshotManifest, call), approvalSubject(manifest, { ...call, patchDigest: `sha256:${"c".repeat(64)}` }),
    ].map(digest);
    expect(new Set([base, ...changed]).size).toBe(6);
  });
});

describe("a standing approval", () => {
  const standing = { targets: ["web-1", "worker-1"], per_day: 3, until: "2027-01-31" };
  it("covers a call whose target is listed, under the daily limit, up to its end date", () => {
    expect(standingCovers(standing, { container: "web-1" }, 0, "2026-11-16")).toBe(true);
    expect(standingCovers(standing, { container: "web-1", lines: 50 }, 2, "2027-01-31")).toBe(true);
  });
  it("does not cover another target, a call with no target, a fourth use of the day, or a day after its end", () => {
    expect(standingCovers(standing, { container: "db-1" }, 0, "2026-11-16")).toBe(false);
    expect(standingCovers(standing, { container: "web-1", also: "db-1" }, 0, "2026-11-16")).toBe(false);
    expect(standingCovers(standing, { lines: 50 }, 0, "2026-11-16")).toBe(false);
    expect(standingCovers(standing, { container: "web-1" }, 3, "2026-11-16")).toBe(false);
    expect(standingCovers(standing, { container: "web-1" }, 0, "2027-02-01")).toBe(false);
    expect(standingCovers(undefined, { container: "web-1" }, 0, "2026-11-16")).toBe(false);
  });
});

describe("a call's input", () => {
  const schema = inputSchema({
    container: { type: "string", description: "", required: true }, lines: { type: "integer", description: "", required: false },
    mode: { type: "string", description: "", required: false, enum: ["plain", "loud"] }, words: { type: "array", description: "", required: false, items: { type: "string" } },
  });
  it("is accepted when it has the required inputs with the right types and nothing else", () => {
    expect(inputProblem(schema, { container: "web-1" })).toBeUndefined();
    expect(inputProblem(schema, { container: "web-1", lines: 50, mode: "loud", words: ["a", "b"] })).toBeUndefined();
  });
  it("is refused, with what to fix, otherwise", () => {
    expect(inputProblem(schema, {})).toBe('"container" is required');
    expect(inputProblem(schema, { container: 5 })).toBe('"container" must be of type string');
    expect(inputProblem(schema, { container: "web-1", lines: 1.5 })).toBe('"lines" must be of type integer');
    expect(inputProblem(schema, { container: "web-1", mode: "quiet" })).toContain('"mode" must be one of');
    expect(inputProblem(schema, { container: "web-1", words: ["a", 2] })).toContain('every item of "words"');
    expect(inputProblem(schema, { container: "web-1", force: true })).toContain('"force" is not an input');
    expect(inputProblem(schema, "web-1")).toBe("the input must be a JSON object");
  });
});

describe("the next time of a schedule", () => {
  const at = (month: number, day: number, hour: number, minute: number): number => Date.UTC(2026, month - 1, day, hour, minute);
  const next = (expression: string, from: number, timeZone = "UTC"): number | undefined => nextCron(expression, from, timeZone);
  it("is the first matching minute after the given moment", () => {
    expect(next("*/15 * * * *", at(11, 16, 9, 0))).toBe(at(11, 16, 9, 15));
    expect(next("*/15 * * * *", at(11, 16, 9, 59) + 30_000)).toBe(at(11, 16, 10, 0));
    expect(next("0 8 * * *", at(11, 16, 9, 0))).toBe(at(11, 17, 8, 0));
    expect(next("30 6,18 * * *", at(11, 16, 9, 0))).toBe(at(11, 16, 18, 30));
  });
  it("honours the day of the week, the day of the month and the month", () => {
    // 16 November 2026 is a Monday.
    expect(next("0 8 * * 1", at(11, 16, 9, 0))).toBe(at(11, 23, 8, 0));
    expect(next("0 8 * * 1-5", at(11, 20, 9, 0))).toBe(at(11, 23, 8, 0));
    expect(next("0 0 1 * *", at(11, 16, 9, 0))).toBe(at(12, 1, 0, 0));
    expect(next("0 12 25 12 *", at(11, 16, 9, 0))).toBe(at(12, 25, 12, 0));
    expect(next("0 8 * * 7", at(11, 16, 9, 0))).toBe(at(11, 22, 8, 0));
    // With both day fields set, either one is enough.
    expect(next("0 8 1 * 3", at(11, 16, 9, 0))).toBe(at(11, 18, 8, 0));
  });
  it("is nothing for an expression that names no time", () => {
    expect(next("61 * * * *", at(11, 16, 9, 0))).toBeUndefined();
    expect(next("0 8 * * mon", at(11, 16, 9, 0))).toBeUndefined();
    expect(next("0 0 31 2 *", at(11, 16, 9, 0))).toBeUndefined();
  });
  it("is read on the wall clock of the workspace's time zone", () => {
    // Paris is an hour ahead of UTC in winter and two in summer; Tunis is an hour ahead all year.
    expect(next("0 8 * * *", at(11, 16, 9, 0), "Europe/Paris")).toBe(at(11, 17, 7, 0));
    expect(next("0 8 * * *", at(7, 1, 9, 0), "Europe/Paris")).toBe(at(7, 2, 6, 0));
    expect(next("0 8 * * 1", at(11, 16, 6, 30), "Africa/Tunis")).toBe(at(11, 16, 7, 0));
    expect(next("0 0 1 * *", at(11, 30, 22, 30), "Europe/Paris")).toBe(at(11, 30, 23, 0));
    // 29 March 2026, Paris: the clock goes from 02:00 to 03:00, so 02:30 does not come that day.
    expect(next("30 2 * * *", at(3, 28, 12, 0), "Europe/Paris")).toBe(at(3, 30, 0, 30));
    expect(next("0 * * * *", at(3, 29, 0, 30), "Europe/Paris")).toBe(at(3, 29, 1, 0));
    // 25 October 2026, Paris: the clock goes from 03:00 back to 02:00, so 02:30 comes twice.
    expect(next("30 2 * * *", at(10, 24, 12, 0), "Europe/Paris")).toBe(at(10, 25, 0, 30));
    expect(next("30 2 * * *", at(10, 25, 0, 30), "Europe/Paris")).toBe(at(10, 25, 1, 30));
    expect(next("30 2 * * *", at(10, 25, 1, 30), "Europe/Paris")).toBe(at(10, 26, 1, 30));
  });
});
