import { rmSync } from "node:fs";
import http from "isomorphic-git/http/node";
import { listServerRefs } from "isomorphic-git";
import { afterEach, describe, expect, it } from "vitest";
import { HostedPullRequestApi, checkProposedFiles } from "../../apps/governor/src/modules/integrations/pull-request";
import { effectsWorld } from "../support/effects-world";
import { createGitHttpBackend } from "../support/git-http-backend";
import { scaled } from "../support/timing";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("open a pull request (second effect tool, ADR 0024)", () => {
  it("pushes a branch and opens the request over the workspace's Git connection, once approved, without the token leaving the Governor", async () => {
    const remote = await createGitHttpBackend();
    cleanup.push(() => remote.cleanup());
    const world = await effectsWorld();
    cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
    const token = "pr-secret-token-0123456789";
    const opened: Array<{ remoteUrl: string; base: string; head: string; title: string; body: string; token: string }> = [];
    world.w.brain.integrations.usePullRequestApi({ open: async (input) => { opened.push({ remoteUrl: input.remoteUrl, base: input.base, head: input.head, title: input.title, body: input.body, token: input.credentials.token ?? "" }); return { number: 7, url: "https://git.example.test/demo/pull/7" }; } });

    const connect = async (commandType: string, key: string, payload: Record<string, unknown>, workspace = false) => (await world.w.brain.executeCommand(world.w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, ...(workspace ? { workspaceId: world.w.workspaceId } : {}), idempotencyKey: key, payload,
    } as never, key)).receipt;
    const connectionId = (await connect("integration.connect", "pr-connect", { name: "Demo repo", repositoryUrl: remote.remote, username: "brain-bot", token })).resourceId!;
    await world.w.brain.integrations.verifyPending();
    await connect("integration.bind", "pr-bind", { connectionId, workspaceId: world.w.workspaceId, kind: "project", repositoryKey: remote.remote, access: "write" }, true);
    await world.w.brain.integrations.verifyPending();
    const guide = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "integrations.guide", resourceId: connectionId })) as unknown as { snapshot: { ready: boolean; steps: Array<{ id: string; state: string }> } }).snapshot;
    expect(guide.steps.map((step) => [step.id, step.state])).toEqual([["connect", "done"], ["verify", "done"], ["write", "done"], ["bind", "done"], ["provider", "todo"]]);

    await world.dispatch("pr-1", [{ id: "git.open-pr", input: { title: "Raise the demo-app memory limit", body: "The container was killed for memory twice today.", branch: "brain/raise-demo-app-memory", files: [{ path: "docs/demo-app/limits.md", content: "memory: 768m\n" }] } }]);
    const running = world.run();
    const approval = await world.pendingApproval();
    expect(JSON.parse(approval.subject_json).effectBounds.summary).toContain("Raise the demo-app memory limit");
    expect(opened).toEqual([]);
    await world.decide(approval, "approve");
    expect(await running).toBe(true);

    expect(opened).toEqual([expect.objectContaining({ head: "brain/raise-demo-app-memory", base: "main", title: "Raise the demo-app memory limit", token })]);
    const refs = await listServerRefs({ http, url: remote.remote, protocolVersion: 1 });
    expect(refs.map((ref) => ref.ref)).toContain("refs/heads/brain/raise-demo-app-memory");
    expect(world.permits().at(-1)!.state).toBe("applied");
    const dump = JSON.stringify([
      world.store.control.prepare("SELECT event_json FROM attempt_events").all(), world.store.control.prepare("SELECT subject_json FROM approval_requests").all(),
      world.store.control.prepare("SELECT payload_json FROM events").all(), world.store.control.prepare("SELECT output_json FROM job_outputs").all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).toContain("https://git.example.test/demo/pull/7");
  }, scaled(180_000));

  it("is refused before anyone is asked when the workspace has no repository it may write to", async () => {
    const world = await effectsWorld();
    cleanup.push(() => rmSync(world.root, { recursive: true, force: true }));
    await world.dispatch("pr-none", [{ id: "git.open-pr", input: { title: "x", branch: "brain/x", files: [{ path: "a.md", content: "a" }] } }]);
    expect(await world.run()).toBe(true);
    expect(world.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests").get()).toEqual({ n: 0 });
    const result = world.toolEvents(world.attempts()[0]!.id).at(-1)!.payload as unknown as { receipt: { result: string } };
    expect(result.receipt.result).toBe("failed");
  }, scaled(120_000));

  it("speaks to GitHub and to a GitLab-style host with the shapes each expects, and refuses paths outside the repository", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(url.includes("github") ? { number: 3, html_url: "https://github.com/o/r/pull/3" } : { iid: 9, web_url: "https://gl.example.test/o/r/-/merge_requests/9" }), { status: 201 }); }) as unknown as typeof fetch;
    const api = new HostedPullRequestApi(fetchImpl);
    const base = { credentials: { token: "t0ken-value-123" }, base: "main", head: "brain/x", title: "T", body: "B" };
    expect(await api.open({ ...base, remoteUrl: "https://github.com/o/r.git" })).toEqual({ number: 3, url: "https://github.com/o/r/pull/3" });
    expect(calls[0]!.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer t0ken-value-123");
    expect(await api.open({ ...base, remoteUrl: "https://gl.example.test/o/r.git" })).toEqual({ number: 9, url: "https://gl.example.test/o/r/-/merge_requests/9" });
    expect(calls[1]!.url).toBe("https://gl.example.test/api/v4/projects/o%2Fr/merge_requests");
    expect(() => checkProposedFiles([{ path: "../etc/passwd", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([{ path: ".git/config", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([{ path: "/abs", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([])).toThrow(/1 to 20/);
  });
});
