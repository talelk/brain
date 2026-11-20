import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { getTask, makeWorkspace, pass } from "./work";

/** What tasks kept (docs/model.md, "A workspace folder"): the files an attempt saved in /out are listed and readable under out/<task>/, beside the folder's own files and read only. */
let harness: Harness;
let driver: Driver;
let member: Client;
let workspaceId: string;
const play = 'title = "Job"\n[[step]]\nid = "do"\nagent = "dev"\ngoal = "Write the report."\n';

beforeAll(async () => {
  harness = await createHarness();
  ({ workspaceId } = await makeWorkspace(harness, "Results", { agents: { dev: {} }, plays: { job: play } }));
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("the files of a workspace", () => {
  it("list the files a task saved in /out under out/<task>/, readable and marked as a task result", async () => {
    driver.script({ dev: () => ({ result: "Done.", files: { "report.md": "# Report\n\nAll good.\n" } }) });
    const { taskId } = await member.command("task.create", { workspaceId, play: "job" });
    await driver.drain();
    const step = (await getTask(member, workspaceId, taskId)).subtasks[0]!;
    const path = `out/${step.id}/report.md`;
    const listed = (await member.query("workspace.files", { workspaceId })).files.find((file) => file.path === path);
    expect(listed).toMatchObject({ source: "results", lastCommit: { message: expect.any(String) } });
    expect(await member.query("file.read", { workspaceId, path })).toMatchObject({ source: "results", binary: false, content: "# Report\n\nAll good.\n" });
    // The folder's own files are still there, and a task result is never part of the folder.
    expect((await member.query("workspace.files", { workspaceId })).files.some((file) => file.path === "brain.toml" && file.source === "workspace")).toBe(true);
  });
});
