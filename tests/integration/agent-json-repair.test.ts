import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { payloadValidator } from "@brain/contracts/validate";
import { sha256Digest } from "@brain/contracts";
import type { EngineAdapter, EngineEvent, EngineSessionSpec } from "@brain/contracts";
import { decodeModelJson, repairJsonStrings, runAgentExecution } from "../../apps/runner/src/engines/run";

/** Replies a real model produced or plausibly produces, with what each must decode to. Valid JSON must be left exactly alone. */
const REPAIRABLE: Array<[string, string, unknown]> = [
  ["a regular expression", String.raw`{"deliverable":"Match digits with \d+ and groups with \(a\)","n":1}`, { deliverable: String.raw`Match digits with \d+ and groups with \(a\)`, n: 1 }],
  ["a Windows path", String.raw`{"deliverable":"Open C:\Users\ada\data\docs"}`, { deliverable: "Open C:\\Users\\ada\\data\\docs" }],
  ["LaTeX", String.raw`{"deliverable":"The sum is \( \sum_{i} x_i \) and \_ stays"}`, { deliverable: String.raw`The sum is \( \sum_{i} x_i \) and \_ stays` }],
  ["a raw line break and tab inside a string", '{"deliverable":"# Title\n\nFirst\tpoint","summary":"s"}', { deliverable: "# Title\n\nFirst\tpoint", summary: "s" }],
  ["an incomplete unicode escape", String.raw`{"deliverable":"a \u12 b"}`, { deliverable: String.raw`a \u12 b` }],
  ["a code fence around a broken string", '```json\n{"deliverable":"line one\nline \\q two"}\n```', { deliverable: "line one\nline \\q two" }],
  ["a sentence around a broken object", String.raw`Here you go: {"summary":"uses \s whitespace"} done.`, { summary: String.raw`uses \s whitespace` }],
];
const VALID = [
  '{"a":"line\\nbreak","b":"quote \\" and slash \\\\ and \\/ and \\u00e9","c":[1,2,{"d":null}]}',
  '{"deliverable":"# Heading\\n\\n- one\\n- two"}',
  '[1,2,3]',
  '{"emptyString":"","backslashEnd":"x\\\\"}',
];

describe("repairing the strings of a model's JSON reply (A2 residual)", () => {
  for (const [name, text, expected] of REPAIRABLE) {
    it(`decodes ${name}`, () => {
      expect(decodeModelJson(text)).toEqual({ value: expected, repaired: true });
    });
  }
  it("leaves valid JSON byte for byte alone, repaired or not", () => {
    for (const text of VALID) {
      expect(repairJsonStrings(text)).toBe(text);
      expect(decodeModelJson(text)?.repaired).toBe(false);
      expect(decodeModelJson(text)?.value).toEqual(JSON.parse(text));
    }
  });
  it("does not turn prose or unrepairable JSON into a value", () => {
    expect(decodeModelJson("No JSON here, only prose {not json}")).toBeUndefined();
    expect(decodeModelJson('{"deliverable":"an unescaped "quote" inside"}')).toBeUndefined();
    expect(decodeModelJson('{"truncated":"never ends')).toBeUndefined();
  });
});

type Reply = { text: string; usage?: { inputTokens: number; outputTokens: number; microUsd: number } };
/** An engine whose successive sessions answer with the given replies; the task each session received is recorded. */
function scripted(replies: Reply[]): { engine: EngineAdapter; tasks: string[] } {
  const tasks: string[] = [];
  let spec: EngineSessionSpec | undefined;
  let session = -1;
  const engine: EngineAdapter = {
    id: "fixture", probe: async () => ({ id: "fixture", version: "1", adapterDigest: `sha256:${"0".repeat(64)}`, features: ["sessions"] }),
    start: async (value) => { spec = value; session++; tasks.push(value.task); return { sessionId: `session-${session}` }; },
    events: () => (async function* () {
      const reply = replies[Math.min(session, replies.length - 1)]!;
      void spec;
      if (reply.usage) yield { kind: "usage", payload: { usageId: "u", accounting: "final-total", estimated: false, ...reply.usage } } as unknown as EngineEvent;
      yield { kind: "text", payload: { text: reply.text } } as EngineEvent;
      const bytes = new TextEncoder().encode(reply.text);
      yield { kind: "session.stopped", payload: { reason: "completed", terminationConfirmed: true, output: { digest: sha256Digest(bytes), bytes: bytes.length } } } as EngineEvent;
    })(),
    cancel: async () => ({ terminationConfirmed: true }), dispose: async () => undefined,
    checkpoint: async () => { throw new Error("unsupported"); },
  };
  return { engine, tasks };
}
const run = (engine: EngineAdapter, events: Array<{ kind: string; payload: unknown }> = []) => runAgentExecution({
  engine, attemptId: "att-repair", jobFence: 1, leaseId: "lease-repair", runnerId: "runner-repair", organizationId: "org", workspaceId: "ws", jobId: "job-repair",
  configDigest: `sha256:${"d".repeat(64)}`, task: "Write the report", timeoutMs: 2000, emit: async (kind, payload) => { events.push({ kind, payload }); }, signal: new AbortController().signal,
});

describe("one corrective try for a reply that is still not JSON", () => {
  it("asks once with the reply and the instruction, uses the corrected answer, and charges both sessions", async () => {
    const { engine, tasks } = scripted([
      { text: '{"deliverable":"an unescaped "quote" inside","summary":"s"}', usage: { inputTokens: 1000, outputTokens: 400, microUsd: 700 } },
      { text: '{"deliverable":"an escaped \\"quote\\" inside","summary":"s"}', usage: { inputTokens: 1500, outputTokens: 300, microUsd: 500 } },
    ]);
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await run(engine, events);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ deliverable: 'an escaped "quote" inside', summary: "s" });
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toContain("not valid JSON");
    expect(tasks[1]).toContain("an unescaped \"quote\" inside");
    // The last final total is what the ledger charges: it must hold both sessions.
    const totals = events.filter((event) => event.kind === "engine" && (event.payload as { kind?: string }).kind === "usage").map((event) => (event.payload as { payload: Record<string, number> }).payload);
    expect(totals.at(-1)).toMatchObject({ inputTokens: 2500, outputTokens: 700, microUsd: 1200 });
  });

  it("tries only once: a second broken reply leaves the first reply standing", async () => {
    const { engine, tasks } = scripted([{ text: '{"a":"x "y" z"}' }, { text: '{"a":"still "broken""}' }]);
    const result = await run(engine);
    expect(tasks).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('{"a":"x "y" z"}');
  });

  it("does not ask again for a reply that repairs by itself, for plain prose or for valid JSON", async () => {
    for (const text of [String.raw`{"deliverable":"uses \d"}`, "BRAIN_OK", '{"fine":true}']) {
      const { engine, tasks } = scripted([{ text }]);
      await run(engine);
      expect(tasks).toHaveLength(1);
    }
  });
});

/** The plan guide's real output schema: a reply that parses but breaks it is corrected once, told exactly which violations to fix. */
describe("one corrective try for a reply that breaks the output contract", () => {
  const schema = JSON.parse(readFileSync("examples/v1/starter-release/schemas/plan-guide-output.json", "utf8")) as object;
  const check = payloadValidator(schema);
  const outputCheck = (output: unknown) => { const result = check(output); return result.ok ? [] : result.errors; };
  const withAssignment = (assignment: unknown) => JSON.stringify({ summary: "s", tasks: [{ id: "review", title: "Review", criteria: ["Reviewed"], dependsOn: [], assignment }] });
  const runChecked = (engine: EngineAdapter, events: Array<{ kind: string; payload: unknown }> = []) => runAgentExecution({
    engine, attemptId: "att-contract", jobFence: 1, leaseId: "lease-contract", runnerId: "runner-contract", organizationId: "org", workspaceId: "ws", jobId: "job-contract",
    configDigest: `sha256:${"d".repeat(64)}`, task: "Plan it", timeoutMs: 2000, outputCheck, emit: async (kind, payload) => { events.push({ kind, payload }); }, signal: new AbortController().signal,
  });

  it("a human assignment without an id (the live failure) is fixed in the same attempt, with the exact violation in the prompt", async () => {
    const { engine, tasks } = scripted([{ text: withAssignment({ kind: "human", role: "reviewer" }), usage: { inputTokens: 800, outputTokens: 400, microUsd: 0 } }, { text: withAssignment({ kind: "human", id: "owner", role: "reviewer" }), usage: { inputTokens: 1200, outputTokens: 420, microUsd: 0 } }]);
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await runChecked(engine, events);
    expect(result.ok).toBe(true);
    expect((result.output as { tasks: Array<{ assignment: { id: string } }> }).tasks[0]!.assignment.id).toBe("owner");
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toContain("/tasks/0/assignment");
    expect(tasks[1]).toContain("id");
    expect(tasks[1]).toContain("does not meet the required output contract");
    const totals = events.filter((event) => event.kind === "engine" && (event.payload as { kind?: string }).kind === "usage").map((event) => (event.payload as { payload: Record<string, number> }).payload);
    expect(totals.at(-1)).toMatchObject({ inputTokens: 2000, outputTokens: 820 });
  });

  it("a conforming reply costs exactly one session", async () => {
    const { engine, tasks } = scripted([{ text: withAssignment({ kind: "human", id: "owner", role: "reviewer" }) }]);
    expect((await runChecked(engine)).ok).toBe(true);
    expect(tasks).toHaveLength(1);
  });

  it("a correction that is worse is never taken: the first reply stands", async () => {
    const first = withAssignment({ kind: "human", role: "reviewer" });
    const worse = JSON.stringify({ summary: "s", tasks: [{ id: "Bad Id", title: "", criteria: [], dependsOn: [] }] });
    const { engine, tasks } = scripted([{ text: first }, { text: worse }]);
    const result = await runChecked(engine);
    expect(tasks).toHaveLength(2);
    expect(result.output).toEqual(JSON.parse(first));
  });

  it("broken JSON is still corrected by the parse correction, not the contract one", async () => {
    const { engine, tasks } = scripted([{ text: '{"summary":"an unescaped "quote" inside","tasks":[]}' }, { text: withAssignment(undefined) }]);
    const result = await runChecked(engine);
    expect(result.ok).toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toContain("not valid JSON");
  });
});
