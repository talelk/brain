import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverCards } from "../../apps/governor/src/integrations/teams";
import { runSchedules } from "../../apps/governor/src/tasks/triggers";
import { enrolRunner, type Driver } from "./driver";
import { createHarness, type Harness } from "./harness";
import { getTask, makeWorkspace, pass, step, testClock } from "./work";

/** Event-driven work (docs/architecture.md section 9): a GitHub delivery or a schedule starts a Play, and Teams hears about what needs a person. */
const clock = testClock();
const cards: string[] = [];
let harness: Harness;
let workspaceId: string;
let slug: string;
let driver: Driver;
const SECRET = "the-webhook-secret";
const QUARTER = 15 * 60_000;

const deliver = (event: string, body: object, options: { id?: string; secret?: string; to?: string } = {}) => {
  const raw = JSON.stringify(body);
  return harness.anonymous.fetch(`/hooks/github/${options.to ?? slug}`, {
    method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": options.id ?? crypto.randomUUID(), "x-hub-signature-256": `sha256=${createHmac("sha256", options.secret ?? SECRET).update(raw).digest("hex")}` },
  });
};
const started = async (response: Response): Promise<string[]> => ((await response.json()) as { started: string[] }).started;
const pullRequest = { action: "opened", repository: { full_name: "Acme/Shop" }, pull_request: { number: 7, title: "Fix the cart total", head: { sha: "0123456789abcdef0123456789abcdef01234567", ref: "fix-cart" } } };
const roots = (): string[] => (harness.governor.gov.db.prepare("SELECT title FROM tasks WHERE workspace_id=? AND parent_id IS NULL ORDER BY rowid").all(workspaceId) as Array<{ title: string }>).map((row) => row.title);

beforeAll(async () => {
  harness = await createHarness({ clock, fetch: (_input, init) => { cards.push((JSON.parse(String(init?.body)) as { attachments: Array<{ content: { body: Array<{ text: string }> } }> }).attachments[0]?.content.body[0]?.text ?? ""); return Promise.resolve(new Response("1")); } });
  ({ workspaceId, slug } = await makeWorkspace(harness, "Events", {
    brain: '[[project]]\nname = "shop"\nrepo = "https://github.com/acme/shop.git"\n[github]\ncredential = "secret:github"\nwebhook_secret = "secret:github-webhook"\n[teams]\nwebhook = "secret:teams-webhook"\n',
    agents: { reviewer: {} },
    plays: {
      "on-pull-request": 'title = "Review a pull request"\n[inputs.delivery]\ntype = "object"\nrequired = true\n[trigger]\nwebhook = "github.pull_request.opened"\n[[step]]\nid = "review"\nagent = "reviewer"\ngoal = "Review #{{delivery.pull_request.number}} {{delivery.pull_request.title}} from {{delivery.pull_request.head.ref}}."\napprove = true\n',
      "on-push": 'title = "After a push"\n[trigger]\nwebhook = "github.push"\n[[step]]\nid = "note"\nagent = "reviewer"\ngoal = "Note the push to {{delivery.ref}}."\n',
      patrol: 'title = "Patrol"\n[trigger]\nschedule = "*/15 * * * *"\n[[step]]\nid = "look"\nagent = "reviewer"\ngoal = "Look around."\n',
    },
  }));
  for (const [name, value] of [["github-webhook", SECRET], ["teams-webhook", "https://teams.example/hook"], ["github", "ghp-x"]] as const) await harness.admin.command("secret.set", { workspaceId, name, value });
  driver = await enrolRunner(harness, { checker: () => pass(), reviewer: ({ offer }) => `Did: ${offer.task.goal}` });
});
afterAll(() => harness.close());

describe("a GitHub delivery", () => {
  it("is taken only when signed with the workspace's webhook secret", async () => {
    expect((await deliver("pull_request", pullRequest, { secret: "another-secret" })).status).toBe(401);
    expect((await deliver("pull_request", pullRequest, { to: "no-such-workspace" })).status).toBe(401);
    const unsigned = await harness.anonymous.fetch(`/hooks/github/${slug}`, { method: "POST", body: JSON.stringify(pullRequest), headers: { "x-github-event": "pull_request", "x-github-delivery": "d-0" } });
    expect(unsigned.status).toBe(401);
    expect(roots()).toEqual([]);
  });

  it("starts the Plays whose trigger names its event, with the delivery as input, once", async () => {
    const [taskId] = await started(await deliver("pull_request", pullRequest, { id: "d-1" }));
    expect(await started(await deliver("pull_request", pullRequest, { id: "d-1" }))).toEqual([]);
    // Another action of the same event, an event no Play names, and a repository that is not a project start nothing.
    expect(await started(await deliver("pull_request", { ...pullRequest, action: "closed" }))).toEqual([]);
    expect(await started(await deliver("issues", { action: "opened", repository: { full_name: "acme/shop" } }))).toEqual([]);
    expect(await started(await deliver("pull_request", { ...pullRequest, repository: { full_name: "acme/other" } }))).toEqual([]);
    expect(roots()).toEqual(["Review a pull request"]);
    const offer = await driver.step();
    expect(offer?.task.goal).toBe("Review #7 Fix the cart total from fix-cart.");
    // A task started by a pull request works on that pull request's head commit.
    expect(offer?.projects).toMatchObject([{ name: "shop", baseCommit: pullRequest.pull_request.head.sha }]);
    expect(await getTask(harness.admin, workspaceId, taskId ?? "")).toMatchObject({ createdBy: "trigger:on-pull-request", play: "on-pull-request" });
    // An event without an action matches a trigger written without one, and is given the branch head.
    const [push] = await started(await deliver("push", { ref: "refs/heads/main", repository: { full_name: "acme/shop" } }));
    await driver.drain();
    expect(await getTask(harness.admin, workspaceId, push ?? "")).toMatchObject({ state: "done", result: "Did: Note the push to refs/heads/main." });
  });

  it("Teams gets a card when a task needs a person and when a goal is done", async () => {
    await deliverCards(harness.governor.gov);
    expect(cards).toEqual(['"review" is waiting for your sign-off.', '"After a push" is done.']);
    const review = step(await getTask(harness.admin, workspaceId, (await harness.admin.query("tasks.list", { workspaceId, state: "running" })).tasks[0]?.id ?? ""), "review");
    await harness.admin.command("task.check", { workspaceId, taskId: review.id, pass: true });
    await deliverCards(harness.governor.gov);
    await deliverCards(harness.governor.gov);
    expect(cards.slice(2)).toEqual(['"Review a pull request" is done.']);
  });
});

describe("a schedule", () => {
  const patrols = (): number => roots().filter((title) => title === "Patrol").length;
  const tick = (ms: number): void => { clock.advance(ms); runSchedules(harness.governor.gov); };
  it("starts its Play at each time, skips a time while the one before still runs, and does not make up for missed times", async () => {
    runSchedules(harness.governor.gov);
    expect(patrols()).toBe(0);
    clock.now = (Math.floor(clock.now / QUARTER) + 1) * QUARTER;
    tick(0);
    expect(patrols()).toBe(1);
    tick(60_000);
    expect(patrols()).toBe(1);
    // The first patrol has not finished when the next time comes.
    tick(QUARTER - 60_000);
    expect(patrols()).toBe(1);
    await driver.drain();
    tick(QUARTER);
    expect(patrols()).toBe(2);
    await driver.drain();
    // The Governor was down for three hours: the twelve times in between are gone, the next one runs.
    tick(12 * QUARTER);
    expect(patrols()).toBe(2);
    tick(QUARTER);
    expect(patrols()).toBe(3);
    const { tasks } = await harness.admin.query("tasks.list", { workspaceId, state: "running" });
    expect(await getTask(harness.admin, workspaceId, tasks[0]?.id ?? "")).toMatchObject({ createdBy: "trigger:patrol", play: "patrol" });
    await driver.drain();
  });

  it("is read in the workspace's time zone, and follows the time zone when it changes", async () => {
    const tokyo = await makeWorkspace(harness, "Tokyo", {
      brain: 'timezone = "Asia/Tokyo"\n', agents: { reviewer: {} },
      plays: { morning: 'title = "Morning"\n[trigger]\nschedule = "0 9 * * *"\n[[step]]\nid = "look"\nagent = "reviewer"\ngoal = "Look around."\n' },
    });
    const next = (): string => new Date((harness.governor.gov.db.prepare("SELECT next_run_at_ms AS at FROM triggers WHERE workspace_id=? AND play='morning'").get(tokyo.workspaceId) as { at: number }).at).toISOString().slice(11, 16);
    // Nine in the morning in Tokyo is midnight UTC.
    expect((await harness.admin.query("workspace.get", { workspaceId: tokyo.workspaceId })).snapshot.timezone).toBe("Asia/Tokyo");
    expect(next()).toBe("00:00");
    await harness.admin.command("file.write", { workspaceId: tokyo.workspaceId, files: [{ path: "brain.toml", content: 'name = "Tokyo"\npacks = ["core"]\n' }] });
    expect(next()).toBe("09:00");
  });

  it("follows the workspace's files: a Play that is removed no longer starts", async () => {
    await harness.admin.command("file.delete", { workspaceId, paths: ["plays/patrol.toml"] });
    tick(QUARTER);
    tick(QUARTER);
    expect(patrols()).toBe(3);
    expect(harness.governor.gov.db.prepare("SELECT play, kind FROM triggers WHERE workspace_id=? ORDER BY play").all(workspaceId)).toEqual([{ play: "on-pull-request", kind: "webhook" }, { play: "on-push", kind: "webhook" }]);
  });
});
