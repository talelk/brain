import { describe, expect, it } from "vitest";
import { activityLine, etaBand, isReadingTool, nowSentence, summarizeActivity, taskNowLine } from "../../apps/web/src/ui/console/doing-now";

type Entry = Parameters<typeof summarizeActivity>[0][number];
let seq = 0;
const tool = (name: string, result = true): Entry => ({ streamSeq: ++seq, at: "2026-11-11T10:00:00Z", type: "tool", kind: "tool", tool: { name, ...(result ? { result: {} } : {}) } });
const message = (): Entry => ({ streamSeq: ++seq, at: "2026-11-11T10:00:01Z", type: "text", kind: "message" });

describe("doing-now sentence from structured events (#61)", () => {
  it("counts consecutive reading tool calls and names them as sources", () => {
    const entries = [tool("bash"), tool("documents.read"), tool("web.fetch"), tool("knowledge.search"), tool("csv.query", false)];
    const activity = summarizeActivity(entries);
    expect(activity.readingStreak).toBe(4);
    expect(nowSentence({ state: "running" }, activity)).toBe("Reading 4 sources…");
    expect(nowSentence({ state: "running" }, summarizeActivity(entries.slice(0, 3)))).toBe("Read 2 sources; deciding the next step.");
    expect(nowSentence({ state: "running" }, summarizeActivity([tool("documents.read", false)]))).toBe("Reading 1 source…");
  });

  it("restarts the count after a non-reading tool and falls back to the tool name", () => {
    const activity = summarizeActivity([tool("documents.read"), tool("documents.read"), tool("write_file", false)]);
    expect(activity.readingStreak).toBe(0);
    expect(nowSentence({ state: "running" }, activity)).toBe("Running write_file…");
  });

  it("says writing when the newest event is the agent's message, and what an empty stream means", () => {
    expect(nowSentence({ state: "running" }, summarizeActivity([tool("web.fetch"), message()]))).toMatch(/^Writing an update/);
    expect(nowSentence({ state: "running" }, summarizeActivity([]))).toMatch(/^Working\./);
    expect(nowSentence({ state: "starting" }, summarizeActivity([]))).toMatch(/starting up/);
  });

  it("says waiting for the independent check when the task is in review, and waiting for a person otherwise", () => {
    expect(nowSentence({ state: "stopped" }, summarizeActivity([message()]), "review")).toBe("Waiting for the independent check of this task's result.");
    expect(nowSentence({ state: "waiting" }, summarizeActivity([]))).toMatch(/waiting for a person/);
    expect(nowSentence({ state: "failed" }, summarizeActivity([]), "review")).toMatch(/stopped because of an error/);
    expect(taskNowLine("review", "stopped")).toBe("Waiting for the independent check.");
    expect(taskNowLine("in-progress", "running")).toBe("Working on it now.");
    expect(taskNowLine("in-progress", undefined)).toBeUndefined();
  });

  it("recognises the reading tools", () => {
    for (const name of ["documents.read", "web.fetch", "knowledge.search", "csv.query", "read", "grep", "read_file"]) expect(isReadingTool(name)).toBe(true);
    for (const name of ["bash", "write", "edit", "readme.update", undefined]) expect(isReadingTool(name)).toBe(false);
  });
});

describe("ETA band (#61)", () => {
  const start = "2026-11-11T10:00:00Z";
  const at = (minutes: number) => Date.parse(start) + minutes * 60_000;
  it("is unknown without an estimate and never guesses", () => {
    expect(etaBand({ startedAt: start, nowMs: at(5) })).toEqual({ kind: "unknown", label: "No time estimate for this task" });
    expect(etaBand({ estimatedMinutes: 0, startedAt: start, nowMs: at(5) }).kind).toBe("unknown");
    expect(etaBand({ estimatedMinutes: -3, startedAt: start, nowMs: at(5) }).kind).toBe("unknown");
  });
  it("compares elapsed time with the estimate", () => {
    expect(etaBand({ estimatedMinutes: 10, startedAt: start, nowMs: at(4) })).toEqual({ kind: "within", label: "4 min of about 10 min · about 6 min left", fraction: 0.4 });
    expect(etaBand({ estimatedMinutes: 10, startedAt: start, nowMs: at(13) })).toEqual({ kind: "over", label: "3 min past the estimate of 10 min", fraction: 1 });
    expect(etaBand({ estimatedMinutes: 10, startedAt: start, nowMs: at(60), endedAtMs: at(7), finished: true })).toMatchObject({ kind: "done", label: "Took 7 min; estimated 10 min" });
    expect(etaBand({ estimatedMinutes: 90, nowMs: at(1) })).toEqual({ kind: "unknown", label: "Estimated about 1 h 30 min" });
  });
});

describe("doing-now sentence from the Governor's session activity (rail and Plan rows)", () => {
  const base = { state: "running" as const };
  it("says how many sources are being read, then what comes next", () => {
    expect(activityLine({ ...base, activity: { toolCalls: 4, sourcesRead: 3, lastTool: "web.fetch", lastToolDone: false } })).toBe("Reading 3 sources…");
    expect(activityLine({ ...base, activity: { toolCalls: 4, sourcesRead: 1, lastTool: "web.fetch", lastToolDone: true } })).toBe("Read 1 source; deciding the next step.");
    expect(activityLine({ ...base, activity: { toolCalls: 5, sourcesRead: 3, lastTool: "bash", lastToolDone: true } })).toBe("Read 3 sources; writing the draft…");
  });
  it("falls back to the state-only line before any tool ran, and for a task in review", () => {
    expect(activityLine(base)).toBe("Working on it now.");
    expect(activityLine({ ...base, activity: { toolCalls: 2, sourcesRead: 2, lastTool: "web.fetch", lastToolDone: false } }, "review")).toBe("Waiting for the independent check.");
  });
});
