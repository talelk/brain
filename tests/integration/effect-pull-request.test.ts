import { readVerified } from "../../apps/governor/src/modules/artifacts/index";
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
    // The real provider client with only the network stubbed: what it sends is what the connection's provider expects.
    const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ number: 7, html_url: "https://git.example.test/demo/pull/7" }), { status: 201 });
    }) as unknown as typeof fetch;
    world.w.brain.integrations.usePullRequestApi(new HostedPullRequestApi(fetchImpl));

    const connect = async (commandType: string, key: string, payload: Record<string, unknown>, workspace = false) => (await world.w.brain.executeCommand(world.w.owner, {
      contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, ...(workspace ? { workspaceId: world.w.workspaceId } : {}), idempotencyKey: key, payload,
    } as never, key)).receipt;
    const connectionId = (await connect("integration.connect", "pr-connect", { provider: "github-enterprise", name: "Demo repo", repositoryUrl: remote.remote, username: "brain-bot", token })).resourceId!;
    await world.w.brain.integrations.verifyPending();
    await connect("integration.bind", "pr-bind", { connectionId, workspaceId: world.w.workspaceId, kind: "project", repositoryKey: remote.remote, access: "write" }, true);
    await world.w.brain.integrations.verifyPending();
    const guide = ((await world.w.brain.executeQuery(world.w.owner, { queryType: "integrations.guide", resourceId: connectionId })) as unknown as { snapshot: { ready: boolean; steps: Array<{ id: string; state: string }> } }).snapshot;
    expect(guide.steps.map((step) => [step.id, step.state])).toEqual([["connect", "done"], ["verify", "done"], ["write", "done"], ["bind", "done"]]);
    expect(guide.ready).toBe(true);

    await world.dispatch("pr-1", [{ id: "git.open-pr", input: { title: "Raise the demo-app memory limit", body: "The container was killed for memory twice today.", branch: "brain/raise-demo-app-memory", files: [{ path: "docs/demo-app/limits.md", content: "memory: 768m\n" }] } }]);
    expect(await world.run()).toBe(true);
    const approval = await world.pendingApproval();
    expect(JSON.parse(approval.subject_json).effectBounds.summary).toContain("Raise the demo-app memory limit");
    expect(sent).toEqual([]);
    await world.decide(approval, "approve");
    await world.drain();

    // The connection was set up as GitHub Enterprise on a host that is not github.com: the GitHub API of that server, not a GitLab call.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${new URL(remote.remote).origin}/api/v3/repos/repo/pulls`);
    expect(sent[0]!.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(sent[0]!.body).toEqual({ title: "Raise the demo-app memory limit", head: "brain/raise-demo-app-memory", base: "main", body: "The container was killed for memory twice today." });
    const refs = await listServerRefs({ http, url: remote.remote, protocolVersion: 1 });
    expect(refs.map((ref) => ref.ref)).toContain("refs/heads/brain/raise-demo-app-memory");
    expect(world.permits().at(-1)!.state).toBe("applied");
    const dump = JSON.stringify([
      world.store.control.prepare("SELECT event_json FROM attempt_events").all(), world.store.control.prepare("SELECT subject_json FROM approval_requests").all(),
      world.store.control.prepare("SELECT payload_json FROM events").all(), world.store.control.prepare("SELECT output_json FROM job_outputs").all(),
    ]);
    expect(dump).not.toContain(token);
    // The result is in the receipt of the held change (content-addressed), where the resumed task reads it.
    expect(new TextDecoder().decode(readVerified(world.store, world.permits().at(-1)!.receipt_digest!))).toContain("https://git.example.test/demo/pull/7");
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

  it("speaks to each provider's own API with the shapes it expects, whatever the host is called, and refuses a provider it does not know", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers: Record<string, unknown> = {
      github: { number: 3, html_url: "https://github.com/o/r/pull/3" }, ghe: { number: 4, html_url: "https://ghe.example.test/o/r/pull/4" },
      gitlab: { iid: 9, web_url: "https://gl.example.test/o/r/-/merge_requests/9" }, gitea: { number: 5, html_url: "https://gitea.example.test/o/r/pulls/5" },
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const answer = url.startsWith("https://api.github.com/") ? answers["github"] : url.includes("/api/v3/") ? answers["ghe"] : url.includes("/api/v4/") ? answers["gitlab"] : answers["gitea"];
      return new Response(JSON.stringify(answer), { status: 201 });
    }) as unknown as typeof fetch;
    const api = new HostedPullRequestApi(fetchImpl);
    const base = { credentials: { token: "t0ken-value-123" }, base: "main", head: "brain/x", title: "T", body: "B" };
    const header = (name: string) => (calls.at(-1)!.init.headers as Record<string, string>)[name];

    expect(await api.open({ ...base, provider: "github", remoteUrl: "https://github.com/o/r.git" })).toEqual({ number: 3, url: "https://github.com/o/r/pull/3" });
    expect(calls.at(-1)!.url).toBe("https://api.github.com/repos/o/r/pulls");
    expect(header("authorization")).toBe("Bearer t0ken-value-123");

    expect(await api.open({ ...base, provider: "github-enterprise", remoteUrl: "https://ghe.example.test/o/r.git" })).toEqual({ number: 4, url: "https://ghe.example.test/o/r/pull/4" });
    expect(calls.at(-1)!.url).toBe("https://ghe.example.test/api/v3/repos/o/r/pulls");
    expect(header("authorization")).toBe("Bearer t0ken-value-123");
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ title: "T", head: "brain/x", base: "main", body: "B" });

    expect(await api.open({ ...base, provider: "gitlab", remoteUrl: "https://gl.example.test/o/r.git" })).toEqual({ number: 9, url: "https://gl.example.test/o/r/-/merge_requests/9" });
    expect(calls.at(-1)!.url).toBe("https://gl.example.test/api/v4/projects/o%2Fr/merge_requests");
    expect(header("private-token")).toBe("t0ken-value-123");
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ source_branch: "brain/x", target_branch: "main", title: "T", description: "B" });

    expect(await api.open({ ...base, provider: "gitea", remoteUrl: "https://gitea.example.test/o/r.git" })).toEqual({ number: 5, url: "https://gitea.example.test/o/r/pulls/5" });
    expect(calls.at(-1)!.url).toBe("https://gitea.example.test/api/v1/repos/o/r/pulls");
    expect(header("authorization")).toBe("token t0ken-value-123");

    // The host's name decides nothing: a host called "github" that the owner set up as Gitea gets a Gitea call, and a GitLab group path keeps its slashes encoded.
    await api.open({ ...base, provider: "gitea", remoteUrl: "https://github.example.test/o/r.git" });
    expect(calls.at(-1)!.url).toBe("https://github.example.test/api/v1/repos/o/r/pulls");
    await api.open({ ...base, provider: "gitlab", remoteUrl: "https://gitlab.example.test/group/sub/r.git" });
    expect(calls.at(-1)!.url).toBe("https://gitlab.example.test/api/v4/projects/group%2Fsub%2Fr/merge_requests");

    const before = calls.length;
    await expect(api.open({ ...base, provider: "bitbucket" as never, remoteUrl: "https://bitbucket.example.test/o/r.git" })).rejects.toThrow(/not supported for the Git provider "bitbucket"/);
    expect(calls).toHaveLength(before);
  });

  it("refuses proposed paths outside the repository", () => {
    expect(() => checkProposedFiles([{ path: "../etc/passwd", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([{ path: ".git/config", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([{ path: "/abs", content: "x" }])).toThrow(/outside the repository/);
    expect(() => checkProposedFiles([])).toThrow(/1 to 20/);
  });
});
