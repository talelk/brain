import git from "isomorphic-git";
import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Client, type Harness } from "./harness";
import { makeWorkspace, pass } from "./work";

/** A workspace's memory (docs/model.md): agents search it and propose entries; a person accepts a proposal, which commits the file. */
let harness: Harness;
let member: Client;
let workspaceId: string;
let slug: string;
let driver: Driver;
const play = 'title = "Learn"\n[[step]]\nid = "learn"\nagent = "scholar"\ngoal = "Learn."\n';
/** Runs one attempt of the scholar with these tool calls and returns their answers. */
async function ask(calls: Array<[string, object]>, workspace = workspaceId): Promise<unknown[]> {
  const answers: unknown[] = [];
  driver.script({ scholar: async ({ brain }) => { for (const [tool, input] of calls) answers.push(await brain(tool, input as never)); return "Learned."; } });
  await harness.admin.command("task.create", { workspaceId: workspace, play: "learn" });
  await driver.drain();
  return answers;
}
const found = (answer: unknown): string[] => (answer as { output: { results: Array<{ name: string }> } }).output.results.map((entry) => entry.name);

beforeAll(async () => {
  harness = await createHarness();
  const files = { agents: { scholar: { tools: ["memory.search", "memory.propose"] } }, plays: { learn: play } };
  ({ workspaceId, slug } = await makeWorkspace(harness, "Library", {
    ...files,
    memory: {
      "release-checklist": "# Release checklist\n\nTag the commit, then deploy to staging before production. Never release on a Friday.\n",
      "refund-policy": "# Refunds\n\nA refund is possible within 30 days of the invoice.\n",
      staging: "# The staging server\n\nStaging mirrors production and is reset every night.\n",
    },
  }));
  member = await harness.member(workspaceId, "max@example.com", "member");
  driver = await enrolRunner(harness, { checker: () => pass() });
});
afterAll(() => harness.close());

describe("memory", () => {
  it("memory.search returns the entries that match, best first, with the part that matches", async () => {
    const [staging, refund, nothing, limited, bad] = await ask([
      ["memory.search", { query: "staging" }], ["memory.search", { query: "refund invoice" }], ["memory.search", { query: "kubernetes" }], ["memory.search", { query: "staging release refund welcome", limit: 2 }], ["memory.search", { query: 5 }],
    ]);
    // The entry about staging comes before the one that only mentions it.
    expect(found(staging)).toEqual(["staging", "release-checklist"]);
    expect(refund).toEqual({ state: "done", output: { results: [{ name: "refund-policy", title: "Refunds", text: "A refund is possible within 30 days of the invoice." }] } });
    expect(found(nothing)).toEqual([]);
    expect(found(limited)).toHaveLength(2);
    expect(bad).toMatchObject({ state: "failed" });
  });

  it("an agent proposes an entry; nothing is saved until an admin accepts it, which commits the file and makes it searchable", async () => {
    const [proposed, second, invalid] = await ask([
      ["memory.propose", { name: "deploy-window", title: "Deploy window", text: "Deploys happen between 9 and 16 on weekdays." }],
      ["memory.propose", { name: "lunch", title: "Lunch", text: "Lunch is at noon." }], ["memory.propose", { name: "Not A Slug", title: "x", text: "y" }],
    ]);
    expect(proposed).toEqual({ state: "done", output: { id: expect.stringMatching(/^mp_/u), status: "proposed" } });
    expect(invalid).toMatchObject({ state: "failed", error: expect.stringContaining("hyphens") });
    const listed = await member.query("memory.list", { workspaceId });
    expect(listed.entries.map((entry) => [entry.name, entry.source])).toEqual([["refund-policy", "workspace"], ["release-checklist", "workspace"], ["staging", "workspace"], ["welcome", "core"]]);
    expect(listed.proposals).toMatchObject([{ name: "lunch", state: "pending" }, { name: "deploy-window", title: "Deploy window", body: "Deploys happen between 9 and 16 on weekdays.", proposedBy: "scholar", state: "pending" }]);
    expect(found((await ask([["memory.search", { query: "weekdays" }]]))[0])).toEqual([]);

    const proposalId = (proposed as { output: { id: string } }).output.id;
    await expect(member.command("memory.decide", { workspaceId, proposalId, decision: "accept" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const accepted = await harness.admin.command("memory.decide", { workspaceId, proposalId, decision: "accept" });
    const dir = join(harness.dataDir, "workspaces", slug);
    expect((await git.log({ fs, dir }))[0]).toMatchObject({ oid: accepted.commit, commit: { message: "Accept the memory entry deploy-window\n", author: { name: "Ada Admin" } } });
    expect(fs.readFileSync(join(dir, "memory/deploy-window.md"), "utf8")).toBe("# Deploy window\n\nDeploys happen between 9 and 16 on weekdays.\n");
    expect(found((await ask([["memory.search", { query: "weekdays" }]]))[0])).toEqual(["deploy-window"]);
    await expect(harness.admin.command("memory.decide", { workspaceId, proposalId, decision: "reject" })).rejects.toMatchObject({ code: "CONFLICT" });
    // A rejected proposal commits nothing.
    const lunch = (second as { output: { id: string } }).output.id;
    expect(await harness.admin.command("memory.decide", { workspaceId, proposalId: lunch, decision: "reject" })).toEqual({ commit: null });
    const after = await member.query("memory.list", { workspaceId });
    expect(after.entries.map((entry) => entry.name)).toContain("deploy-window");
    expect(after.proposals.map((proposal) => [proposal.name, proposal.state])).toEqual([["lunch", "rejected"], ["deploy-window", "accepted"]]);
  });

  it("a workspace never reads another workspace's memory", async () => {
    const other = await makeWorkspace(harness, "Elsewhere", { agents: { scholar: { tools: ["memory.search", "memory.propose"] } }, plays: { learn: play } });
    expect(found((await ask([["memory.search", { query: "refund staging deploy" }]], other.workspaceId))[0])).toEqual([]);
    expect(found((await ask([["memory.search", { query: "welcome tests" }]], other.workspaceId))[0])).toEqual(["welcome"]);
  });
});
