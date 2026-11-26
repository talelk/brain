import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PUBLISHED, type CommandType, type JsonValue, type QueryType } from "@brain/contracts";
import { schemaProblem } from "@brain/contracts/validate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Harness } from "./harness";
import { makeWorkspace, pass } from "./work";

/** docs/openapi.json (docs/architecture.md section 4): what the Governor answers fits what the file says it answers. */
const PACKS = fileURLToPath(new URL("../../packs", import.meta.url));
const api = JSON.parse(readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8")) as { components: { schemas: Record<string, JsonValue> }; "x-brain-operations": Record<string, unknown> };
let harness: Harness;
let driver: Driver;
const seen = new Set<string>();
const fits = (name: string, output: unknown): void => {
  seen.add(name);
  const schema = { $ref: `#/components/schemas/${name}.output`, components: api.components as unknown as JsonValue };
  expect(schemaProblem(schema, JSON.parse(JSON.stringify(output)) as JsonValue, "output"), name).toBeUndefined();
};

beforeAll(async () => {
  harness = await createHarness({ packsDir: PACKS });
  driver = await enrolRunner(harness, { checker: () => pass(), dev: async ({ brain }) => { await brain("task.note", { text: "Seen." }); return "Done."; }, asker: async ({ brain }) => { await brain("task.ask", { question: "Which?" }); return "Asked."; } });
});
afterAll(() => harness.close());

describe("the published API", () => {
  it("lists every entry it publishes", () => {
    expect(Object.keys(api["x-brain-operations"]).sort()).toEqual([...PUBLISHED.queries, ...PUBLISHED.commands].sort());
  });

  it("answers what it says it answers, entry by entry", async () => {
    const admin = harness.admin;
    const { workspaceId: platformId } = await makeWorkspace(harness, "Brain admin", { platform: "admin", packs: ["base", "platform"] });
    const { workspaceId } = await makeWorkspace(harness, "Spoken", {
      packs: ["base"], agents: { dev: { tools: ["task.note"] }, asker: { tools: ["task.ask"] } },
      plays: { one: 'title = "One"\n[trigger]\nschedule = "0 6 * * 1"\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "Do."\napprove = true\n', ask: 'title = "Ask"\n[[step]]\nid = "do"\nagent = "asker"\ngoal = "Ask."\n' },
    });
    const query = async (type: QueryType, input: object = {}) => { const output = await admin.query(type, input as never); fits(type, output); return output; };
    const command = async (type: CommandType, input: object) => { const output = await admin.command(type, input as never); fits(type, output); return output; };
    const task = async (taskId: string) => (await query("task.get", { workspaceId, taskId })) as unknown as { subtasks: Array<{ id: string }>; attempts: Array<{ id: string }> };

    const one = (await command("task.create", { workspaceId, play: "one" })) as { taskId: string };
    const asking = (await command("task.create", { workspaceId, play: "ask" })) as { taskId: string };
    await command("task.steer", { workspaceId, taskId: one.taskId, priority: "high" });
    await query("queue", {});
    await driver.drain();
    const done = await task(one.taskId);
    await query("task.events", { workspaceId, taskId: done.subtasks[0]?.id, attemptId: done.attempts[0]?.id });
    await command("task.answer", { workspaceId, taskId: (await task(asking.taskId)).subtasks[0]?.id, answer: "This one." });
    await command("task.check", { workspaceId, taskId: done.subtasks[0]?.id, pass: true });
    const stopped = (await command("task.create", { workspaceId, goal: "Stop me." })) as { taskId: string };
    await command("task.stop", { workspaceId, taskId: stopped.taskId });
    await command("task.retry", { workspaceId, taskId: stopped.taskId });
    await command("file.write", { workspaceId, files: [{ path: "docs/a.md", content: "# A\n" }] });
    await query("file.read", { workspaceId, path: "docs/a.md" });
    await query("workspace.files", { workspaceId });
    await command("file.delete", { workspaceId, paths: ["docs/a.md"] });
    await command("pack.release", { workspaceId: platformId, name: "base" });
    await query("packs.list", {});
    await query("me", {});
    await query("overview", {});
    await query("insights", { days: 7 });
    await query("tasks.list", { workspaceId });
    await query("schedules.list", {});
    await query("audit.verify", {});
    const made = (await command("workspace.create", { name: "Another" })) as { workspaceId: string };
    await command("workspace.archive", { workspaceId: made.workspaceId });
    // A checkpoint's answer is the one entry this walk does not meet.
    expect([...PUBLISHED.queries, ...PUBLISHED.commands].filter((name) => !seen.has(name))).toEqual(["task.checkpoint"]);
  });
});
