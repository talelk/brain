import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Automation, AutomationOccurrence, CommandReceipt, PullRequest } from "@brain/contracts";
import { createApp } from "../../apps/governor/src/http/app";
import { setupWorld, type TestWorld } from "../helpers";
import { fixtureStarter } from "../support/starter";
import { PROPOSAL, missionWithTask, pullRequestWorld } from "../support/pull-request-world";
import { scaled } from "../support/timing";

// Spec #90 ticket #138: signed GitHub, GitLab and ticket webhooks record subjects (ticket or incident) and fire the subject triggers of #122;
// a pull request or check attaches to the pull request record of #121 when the address matches. Everything is reached through the HTTP
// routes and the command funnel. A webhook can never confirm a plan, approve an effect or record a verdict.
const tmp = process.env["TMPDIR"] ?? "/tmp";
const SECRET = "whsec-0123456789-abcdefghij";
const PLAY = "support-reply-draft";
const roots: string[] = [];
const apps: Array<{ brain: { close(): void } }> = [];
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.brain.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const close of cleanup.splice(0).reverse()) await close();
});

let counter = 0;
async function run(w: TestWorld, commandType: string, payload: Record<string, unknown>, opts: { workspace?: boolean; expectedVersion?: number } = {}): Promise<CommandReceipt> {
  const key = `wh-${++counter}`;
  return (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType, ...(opts.workspace ? { workspaceId: w.workspaceId } : {}), idempotencyKey: key,
    ...(opts.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}), payload,
  } as never, key)).receipt;
}
const read = async <T>(w: TestWorld, queryType: string, resourceId?: string): Promise<T> =>
  ((await w.brain.executeQuery(w.owner, { queryType, workspaceId: w.workspaceId, ...(resourceId ? { resourceId } : {}) })) as unknown as { snapshot: T }).snapshot;
const db = (w: TestWorld) => w.brain.store.workspaceDb(w.workspaceId, w.org);

async function hookWorld() {
  const root = mkdtempSync(join(tmp, "brain-webhooks-")); roots.push(root);
  const app = await createApp({ dataDir: join(root, "data"), allowTestActor: true });
  apps.push(app);
  const w = setupWorld(app.brain);
  const bundle = fixtureStarter();
  w.brain.activateRelease(w.owner, w.brain.stageRelease(w.owner, bundle.documents, bundle.sourceRevision, bundle.scripts, bundle.instructions, bundle.schemas).digest);
  const endpoint = async (kind: "github" | "gitlab" | "ticket", secret = SECRET, connectionId?: string): Promise<string> =>
    (await run(w, "webhook.create", { kind, workspaceId: w.workspaceId, secret, ...(connectionId ? { connectionId } : {}) })).resourceId!;
  const trigger = async (subjectKind: "ticket" | "incident"): Promise<string> =>
    (await run(w, "automation.upsert", { title: `Every new ${subjectKind}`, target: { kind: "play", id: PLAY }, trigger: { kind: "subject", subjectKind } }, { workspace: true })).resourceId!;
  const started = async (id: string) => (await read<{ items: AutomationOccurrence[] }>(w, "automations.occurrences", id)).items.filter((occurrence) => occurrence.state === "dispatched");
  const post = async (path: string, body: string, headers: Record<string, string>) => {
    const response = await app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  return { app, w, endpoint, trigger, started, post };
}

const github = (secret: string, event: string, delivery: string, payload: unknown, sign = secret) => {
  const body = JSON.stringify(payload);
  return { body, headers: { "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", sign).update(body).digest("hex")}` } };
};
const gitlab = (secret: string, event: string, uuid: string, payload: unknown) => ({ body: JSON.stringify(payload), headers: { "x-gitlab-event": event, "x-gitlab-event-uuid": uuid, "x-gitlab-token": secret } });
const ticket = (secret: string, delivery: string, payload: unknown, opts: { ageSeconds?: number; sign?: string } = {}) => {
  const body = JSON.stringify(payload);
  const stamp = String(Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0));
  return { body, headers: { "x-brain-delivery": delivery, "x-brain-timestamp": stamp, "x-brain-signature": `sha256=${createHmac("sha256", opts.sign ?? secret).update(`${stamp}.${body}`).digest("hex")}` } };
};

const issue = (number: number, action: string, labels: string[] = []) => ({ action, issue: { number, title: `Cannot sign in (${number})`, html_url: `https://github.com/acme/app/issues/${number}`, labels: labels.map((name) => ({ name })) }, repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" } });
const tickets = (w: TestWorld) => db(w).prepare("SELECT id, connector_id, remote_id, state, title, priority, labels_json FROM tickets ORDER BY remote_id").all() as Array<{ id: string; connector_id: string; remote_id: string; state: string; title: string; priority: string; labels_json: string }>;
const deliveries = (w: TestWorld) => db(w).prepare("SELECT event, status, detail FROM webhook_deliveries ORDER BY received_at_ms, rowid").all() as Array<{ event: string; status: string; detail: string }>;
const REFUSED = { status: 401, json: { error: "the request was not accepted" } };

/** What a webhook must never be able to do, checked after each scenario: nothing was approved, confirmed, decided or judged. */
function nothingDecided(w: TestWorld): void {
  expect(db(w).prepare("SELECT COUNT(*) AS n FROM plan_versions WHERE state='confirmed'").get()).toEqual({ n: 0 });
  expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_decisions").get()).toEqual({ n: 0 });
  expect(w.brain.store.control.prepare("SELECT COUNT(*) AS n FROM approval_requests WHERE state<>'pending'").get()).toEqual({ n: 0 });
}

describe("GitHub webhooks (#138)", () => {
  it("records an issue as a ticket subject, starts one mission whose plan waits for a person, and a replay changes nothing", async () => {
    const { w, endpoint, trigger, started, post } = await hookWorld();
    const id = await endpoint("github");
    const automation = await trigger("ticket");
    const path = `/hooks/github/${id}`;

    const opened = github(SECRET, "issues", "d-1", issue(11, "opened", ["bug", "priority:high"]));
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "applied" } });
    expect(tickets(w)).toMatchObject([{ connector_id: "hook-github", remote_id: "acme/app#11", state: "open", title: "Cannot sign in (11)", priority: "high", labels_json: '["bug","priority:high"]' }]);
    const occurrences = await started(automation);
    expect(occurrences).toHaveLength(1);
    const missionId = occurrences[0]!.dispatchRef!;
    expect(db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(missionId)).toEqual({ state: "proposed" });
    const forSubject = await read<{ items: Array<{ missionId: string }> }>(w, "missions.forSubject", tickets(w)[0]!.id);
    expect(forSubject.items.map((mission) => mission.missionId)).toEqual([missionId]);
    // What the delivery set going is on record as the endpoint's own act (a named system principal), never a person's or the mission owner's.
    const byEndpoint = db(w).prepare("SELECT actor_id, actor_kind FROM events WHERE actor_id=?").all(`system:webhook:${id}`);
    expect(byEndpoint.length).toBeGreaterThan(0);
    expect(byEndpoint).toEqual(byEndpoint.map(() => ({ actor_id: `system:webhook:${id}`, actor_kind: "system" })));

    // The same delivery, and the same bytes under a fresh delivery id (a captured request replayed), are acknowledged and do nothing.
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "duplicate" } });
    const fresh = { ...opened.headers, "x-github-delivery": "d-1-replayed" };
    expect(await post(path, opened.body, fresh)).toEqual({ status: 200, json: { status: "duplicate" } });
    expect(tickets(w)).toHaveLength(1);
    expect(await started(automation)).toHaveLength(1);

    // Closed, reopened and labeled update the same subject and never start a second mission.
    for (const [delivery, action, labels] of [["d-2", "closed", ["bug"]], ["d-3", "reopened", ["bug"]], ["d-4", "labeled", ["bug", "urgent"]]] as const) {
      const next = github(SECRET, "issues", delivery, issue(11, action, [...labels]));
      expect((await post(path, next.body, next.headers)).status).toBe(200);
      if (action === "closed") expect(tickets(w)[0]).toMatchObject({ state: "closed" });
      if (action === "reopened") expect(tickets(w)[0]).toMatchObject({ state: "open" });
    }
    expect(tickets(w)[0]).toMatchObject({ state: "open", priority: "urgent", labels_json: '["bug","urgent"]' });
    expect(await started(automation)).toHaveLength(1);
    expect(deliveries(w).map((entry) => entry.status)).toEqual(["applied", "applied", "applied", "applied"]);
    nothingDecided(w);
  });

  it("refuses a wrong signature, a missing one and an unknown endpoint with the same answer, and records nothing", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("github");
    const good = github(SECRET, "issues", "d-1", issue(1, "opened"));
    const wrong = github(SECRET, "issues", "d-2", issue(2, "opened"), "some-other-secret-value");
    expect(await post(`/hooks/github/${id}`, wrong.body, wrong.headers)).toEqual(REFUSED);
    expect(await post(`/hooks/github/${id}`, good.body, { "x-github-event": "issues", "x-github-delivery": "d-3" })).toEqual(REFUSED);
    expect(await post(`/hooks/github/${id}`, good.body, { ...good.headers, "x-hub-signature-256": "sha256=zz" })).toEqual(REFUSED);
    expect(await post("/hooks/github/whk-does-not-exist", good.body, good.headers)).toEqual(REFUSED);
    // An endpoint of another kind does not accept this provider's signature either.
    const other = await endpoint("gitlab");
    expect(await post(`/hooks/github/${other}`, good.body, good.headers)).toEqual(REFUSED);
    expect(tickets(w)).toEqual([]);
    expect(deliveries(w)).toEqual([]);
  });

  it("refuses an oversize body before reading it as a delivery, and acknowledges ping and events it does not handle", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("github");
    const huge = github(SECRET, "issues", "d-big", { ...issue(5, "opened"), padding: "x".repeat(1024 * 1024 + 10) });
    expect(await post(`/hooks/github/${id}`, huge.body, huge.headers)).toMatchObject({ status: 413 });
    const ping = github(SECRET, "ping", "d-ping", { zen: "Keep it logically awesome.", hook_id: 1 });
    expect(await post(`/hooks/github/${id}`, ping.body, ping.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    const star = github(SECRET, "star", "d-star", { action: "created" });
    expect(await post(`/hooks/github/${id}`, star.body, star.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    const edited = github(SECRET, "issues", "d-edit", issue(5, "edited"));
    expect(await post(`/hooks/github/${id}`, edited.body, edited.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    const broken = github(SECRET, "issues", "d-junk", {});
    expect(await post(`/hooks/github/${id}`, "not json at all", { ...broken.headers, "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update("not json at all").digest("hex")}` })).toEqual({ status: 200, json: { status: "ignored" } });
    expect(tickets(w)).toEqual([]);
    expect(deliveries(w).map((entry) => entry.status)).toEqual(["ignored", "ignored", "ignored", "ignored"]);
  });

  it("a pull request or check that matches no record becomes a subject that never starts a mission", async () => {
    const { w, endpoint, trigger, started, post } = await hookWorld();
    const id = await endpoint("github");
    const automation = await trigger("ticket");
    const pull = { repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" }, pull_request: { number: 9, title: "Fix sign-in", html_url: "https://github.com/acme/app/pull/9", merged: true } };
    const closed = github(SECRET, "pull_request", "p-1", { action: "closed", ...pull });
    expect(await post(`/hooks/github/${id}`, closed.body, closed.headers)).toEqual({ status: 200, json: { status: "applied" } });
    const check = github(SECRET, "check_run", "c-1", { action: "completed", repository: pull.repository, check_run: { name: "ci / test", conclusion: "success", pull_requests: [{ number: 9 }] } });
    expect(await post(`/hooks/github/${id}`, check.body, check.headers)).toEqual({ status: 200, json: { status: "applied" } });
    const running = github(SECRET, "check_run", "c-0", { action: "created", repository: pull.repository, check_run: { name: "ci / test", pull_requests: [{ number: 9 }] } });
    expect(await post(`/hooks/github/${id}`, running.body, running.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    expect(tickets(w)).toMatchObject([{ remote_id: "acme/app!9", state: "closed", title: "Fix sign-in" }]);
    expect(db(w).prepare("SELECT name, conclusion, subject_id, pull_request_id FROM subject_checks").all()).toEqual([{ name: "ci / test", conclusion: "success", subject_id: tickets(w)[0]!.id, pull_request_id: null }]);
    expect(await started(automation)).toHaveLength(0);
    nothingDecided(w);
  });
});

describe("GitHub webhooks on a recorded pull request (#121)", () => {
  it("add the merged state and the check result to the record the approved call opened, and nothing more", async () => {
    const { world, connectionId } = await pullRequestWorld(cleanup);
    const { workItemId } = await missionWithTask(world);
    await world.dispatch("wh-pr", [PROPOSAL], { workItemId });
    expect(await world.run()).toBe(true);
    await world.decide(await world.pendingApproval(), "approve");
    await world.drain();
    const w = world.w;
    const id = (await run(w, "webhook.create", { kind: "github", workspaceId: w.workspaceId, secret: SECRET, connectionId })).resourceId!;
    const send = (event: string, delivery: string, payload: unknown) => {
      const signed = github(SECRET, event, delivery, payload);
      return w.brain.receiveWebhook("github", id, new Headers(signed.headers), Buffer.from(signed.body));
    };
    const repository = { full_name: "demo/app", html_url: "https://git.example.test/demo" };
    expect(send("pull_request", "pr-1", { action: "closed", repository, pull_request: { number: 7, title: "x", html_url: "https://git.example.test/demo/pull/7", merged: true } })).toEqual({ status: 200, body: { status: "applied" } });
    expect(send("check_run", "ck-1", { action: "completed", repository, check_run: { name: "ci", conclusion: "failure", pull_requests: [{ number: 7 }] } })).toEqual({ status: 200, body: { status: "applied" } });
    const [record] = ((await w.brain.executeQuery(w.owner, { queryType: "pullRequests.list", workspaceId: w.workspaceId, resourceId: workItemId })) as unknown as { snapshot: { items: PullRequest[] } }).snapshot.items;
    expect(record).toMatchObject({ state: "merged" });
    expect(record!.observations.map((entry) => [entry.state, entry.source])).toEqual([["open", "opened"], ["merged", "webhook"]]);
    expect(record!.checks).toEqual([expect.objectContaining({ name: "ci", conclusion: "failure" })]);
    // The record is not duplicated as a subject.
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
    // An endpoint tied to a different connection does not match this record.
    expect(w.brain.store.control.prepare("SELECT connection_id FROM webhook_endpoints WHERE id=?").get(id)).toEqual({ connection_id: connectionId });
  }, scaled(180_000));
});

describe("GitLab webhooks (#138)", () => {
  const glIssue = (iid: number, action: string, extra: Record<string, unknown> = {}) => ({ object_kind: "issue", project: { path_with_namespace: "acme/app" }, object_attributes: { iid, title: `Outage report ${iid}`, action, url: `https://gitlab.example/acme/app/-/issues/${iid}` }, labels: [{ title: "sev1" }], ...extra });

  it("compares the token, records an issue, starts one mission and ignores a replay", async () => {
    const { w, endpoint, trigger, started, post } = await hookWorld();
    const id = await endpoint("gitlab");
    const automation = await trigger("ticket");
    const path = `/hooks/gitlab/${id}`;
    const wrong = gitlab("not-the-secret-at-all-xx", "Issue Hook", "u-0", glIssue(3, "open"));
    expect(await post(path, wrong.body, wrong.headers)).toEqual(REFUSED);
    const short = gitlab("x", "Issue Hook", "u-0", glIssue(3, "open"));
    expect(await post(path, short.body, short.headers)).toEqual(REFUSED);
    expect(tickets(w)).toEqual([]);

    const opened = gitlab(SECRET, "Issue Hook", "u-1", glIssue(3, "open"));
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "applied" } });
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "duplicate" } });
    expect(tickets(w)).toMatchObject([{ connector_id: "hook-gitlab", remote_id: "acme/app#3", state: "open", labels_json: '["sev1"]' }]);
    expect(await started(automation)).toHaveLength(1);
    const closed = gitlab(SECRET, "Issue Hook", "u-2", glIssue(3, "close"));
    await post(path, closed.body, closed.headers);
    expect(tickets(w)[0]).toMatchObject({ state: "closed" });
    const unrelated = gitlab(SECRET, "Push Hook", "u-3", { object_kind: "push" });
    expect(await post(path, unrelated.body, unrelated.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    expect(await started(automation)).toHaveLength(1);
    nothingDecided(w);
  });

  it("records merge requests and finished pipelines as subjects", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("gitlab");
    const path = `/hooks/gitlab/${id}`;
    const request = { iid: 4, title: "Fix outage", action: "merge", url: "https://gitlab.example/acme/app/-/merge_requests/4" };
    const merged = gitlab(SECRET, "Merge Request Hook", "m-1", { object_kind: "merge_request", project: { path_with_namespace: "acme/app" }, object_attributes: request });
    expect(await post(path, merged.body, merged.headers)).toEqual({ status: 200, json: { status: "applied" } });
    const pipeline = (status: string, uuid: string) => gitlab(SECRET, "Pipeline Hook", uuid, { object_kind: "pipeline", project: { path_with_namespace: "acme/app" }, object_attributes: { id: 1, status, ref: "fix" }, merge_request: { iid: 4, url: request.url } });
    const running = pipeline("running", "m-2");
    expect(await post(path, running.body, running.headers)).toEqual({ status: 200, json: { status: "ignored" } });
    const failed = pipeline("failed", "m-3");
    expect(await post(path, failed.body, failed.headers)).toEqual({ status: 200, json: { status: "applied" } });
    expect(tickets(w)).toMatchObject([{ remote_id: "acme/app!4", state: "closed" }]);
    expect(db(w).prepare("SELECT conclusion FROM subject_checks").all()).toEqual([{ conclusion: "failure" }]);
  });
});

describe("the ticket webhook (#138)", () => {
  const record = (kind: "ticket" | "incident", event: string, extra: Record<string, unknown> = {}) => ({ kind, event, id: "INC-7", title: "Payments API is down", ...extra });

  it("records a ticket or incident, gives incident subjects a producer, and starts one mission per subject that waits for a person", async () => {
    const { w, endpoint, trigger, started, post } = await hookWorld();
    const id = await endpoint("ticket");
    const path = `/hooks/ticket/${id}`;
    const forTickets = await trigger("ticket");
    const forIncidents = await trigger("incident");

    const opened = ticket(SECRET, "t-1", record("incident", "opened", { severity: "critical" }));
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "applied" } });
    expect(await post(path, opened.body, opened.headers)).toEqual({ status: 200, json: { status: "duplicate" } });
    expect(db(w).prepare("SELECT target_key, severity, title, state FROM incidents").all()).toEqual([{ target_key: "external:INC-7", severity: "critical", title: "Payments API is down", state: "open" }]);
    const [occurrence] = await started(forIncidents);
    expect(await started(forIncidents)).toHaveLength(1);
    expect(await started(forTickets)).toHaveLength(0);
    expect(db(w).prepare("SELECT state FROM plan_versions WHERE mission_id=?").get(occurrence!.dispatchRef)).toEqual({ state: "proposed" });
    expect(db(w).prepare("SELECT pack, kind FROM mission_subjects WHERE mission_id=?").get(occurrence!.dispatchRef)).toEqual({ pack: "sre", kind: "incident" });

    for (const [delivery, event] of [["t-2", "closed"], ["t-3", "reopened"]] as const) {
      const next = ticket(SECRET, delivery, record("incident", event));
      await post(path, next.body, next.headers);
    }
    expect(db(w).prepare("SELECT state FROM incidents").get()).toEqual({ state: "open" });
    expect(await started(forIncidents)).toHaveLength(1);

    const support = ticket(SECRET, "t-4", { kind: "ticket", event: "opened", id: "ZD-1", title: "Refund request", labels: ["billing"] });
    await post(path, support.body, support.headers);
    expect(tickets(w)).toMatchObject([{ connector_id: "hook-ticket", remote_id: "ZD-1", state: "open", labels_json: '["billing"]' }]);
    expect(await started(forTickets)).toHaveLength(1);
    nothingDecided(w);
  });

  it("refuses a stale timestamp, a wrong signature, another provider's scheme and an unknown endpoint, and says nothing about which", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("ticket");
    const path = `/hooks/ticket/${id}`;
    const old = ticket(SECRET, "t-old", record("ticket", "opened"), { ageSeconds: 3600 });
    expect(await post(path, old.body, old.headers)).toEqual(REFUSED);
    const wrong = ticket(SECRET, "t-wrong", record("ticket", "opened"), { sign: "another-secret-another-secret" });
    expect(await post(path, wrong.body, wrong.headers)).toEqual(REFUSED);
    const slack = ticket(SECRET, "t-slack", record("ticket", "opened"));
    const { "x-brain-signature": _unused, ...rest } = slack.headers;
    expect(await post(path, slack.body, { ...rest, "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${rest["x-brain-timestamp"]}:${slack.body}`).digest("hex")}`, "x-slack-request-timestamp": rest["x-brain-timestamp"] })).toEqual(REFUSED);
    const good = ticket(SECRET, "t-good", record("ticket", "opened"));
    expect(await post("/hooks/ticket/whk-nope", good.body, good.headers)).toEqual(REFUSED);
    expect(tickets(w)).toEqual([]);
    expect(deliveries(w)).toEqual([]);
  });

  it("a rotated secret takes over at once: the old one is refused, the new one accepted", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("ticket");
    const path = `/hooks/ticket/${id}`;
    const NEW = "whsec-rotated-0987654321-zyxw";
    expect((await run(w, "webhook.rotate", { endpointId: id, secret: NEW })).accepted).toBe(true);
    const old = ticket(SECRET, "r-1", record("ticket", "opened"));
    expect(await post(path, old.body, old.headers)).toEqual(REFUSED);
    const fresh = ticket(NEW, "r-2", record("ticket", "opened"));
    expect(await post(path, fresh.body, fresh.headers)).toEqual({ status: 200, json: { status: "applied" } });
    await expect(run(w, "webhook.rotate", { endpointId: "whk-nope", secret: NEW })).rejects.toThrow(/not found/u);
    await expect(run(w, "webhook.create", { kind: "ticket", workspaceId: w.workspaceId, secret: "short" })).rejects.toThrow();
  });
});

describe("webhook secrets and the administration list (#138)", () => {
  it("keeps the secret out of every stored row, event and answer, and lists status only", async () => {
    const { w, endpoint, post } = await hookWorld();
    const id = await endpoint("github");
    const good = github(SECRET, "issues", "d-1", issue(1, "opened"));
    await post(`/hooks/github/${id}`, good.body, good.headers);
    const ignored = github(SECRET, "ping", "d-2", { zen: "x" });
    await post(`/hooks/github/${id}`, ignored.body, ignored.headers);
    const control = w.brain.store.control;
    const dump = JSON.stringify([
      control.prepare("SELECT * FROM webhook_endpoints").all(), control.prepare("SELECT * FROM command_intents").all(), control.prepare("SELECT * FROM command_idempotency").all(),
      control.prepare("SELECT * FROM events").all(), db(w).prepare("SELECT * FROM webhook_deliveries").all(), db(w).prepare("SELECT * FROM events").all(),
    ]);
    expect(dump).not.toContain(SECRET);
    const list = await w.brain.executeQuery(w.owner, { queryType: "webhooks.list" });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    const { endpoints } = (list as unknown as { snapshot: { endpoints: Array<{ endpointId: string; kind: string; path: string; workspaceName: string; deliveries: Array<{ event: string; status: string }> }> } }).snapshot;
    expect(endpoints).toMatchObject([{ endpointId: id, kind: "github", path: `/hooks/github/${id}`, deliveries: [{ event: "ping", status: "ignored" }, { event: "issues", status: "applied" }] }]);
    expect(JSON.stringify(endpoints)).not.toMatch(/Cannot sign in/u);
  });

  it("is for an administrator: no scope, another organization and a session are all refused", async () => {
    const { w } = await hookWorld();
    const noScopes = { ...w.owner, scopes: ["workspace:read"] };
    await expect(w.brain.executeCommand(noScopes, { contractVersion: "brain.command/v1", commandId: "cmd-ns", commandType: "webhook.create", idempotencyKey: "ns", payload: { kind: "ticket", workspaceId: w.workspaceId, secret: SECRET } } as never, "ns")).rejects.toThrow(/missing scope/iu);
    await expect(w.brain.executeQuery(noScopes, { queryType: "webhooks.list" })).rejects.toThrow();
    const outsider = { ...w.owner, organizationId: "org-other" };
    await expect(w.brain.executeCommand(outsider, { contractVersion: "brain.command/v1", commandId: "cmd-os", commandType: "webhook.create", idempotencyKey: "os", payload: { kind: "ticket", workspaceId: w.workspaceId, secret: SECRET } } as never, "os")).rejects.toThrow();
    expect(await automationsCount(w)).toBe(0);
  });
});

async function automationsCount(w: TestWorld): Promise<number> {
  return (await read<{ items: Automation[] }>(w, "automations.list")).items.length;
}
