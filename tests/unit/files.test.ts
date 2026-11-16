import { AgentFile, BrainFile, MemoryEntry, PackFile, parseRef, parseWhen, PlayFile, renderTemplate, splitMemoryEntry, templateRefs, ToolFile } from "@brain/contracts";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

const messages = (schema: z.ZodType, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

const brain = {
  name: "Kios RH", description: "Workforce cost platform", timezone: "Africa/Tunis", packs: ["base", "software-factory"],
  limits: { daily_spend_usd: 20, running_tasks: 4, confirm_plans: "person" },
  model: [{ name: "main", provider: "openai-compatible", url: "https://models.example/v1", model: "qwen3-coder", key: "secret:model-main", input_usd_per_mtok: 0.4, output_usd_per_mtok: 1.6 }],
  project: [{ name: "kios-newrh", repo: "https://github.com/keyrustunisie/kios-newrh.git", branch: "master", access: "write", credential: "secret:github", setup: "pnpm install --frozen-lockfile", network: ["registry.npmjs.org"] }],
  github: { credential: "secret:github", webhook_secret: "secret:github-webhook" },
  teams: { webhook: "secret:teams-webhook" },
  approvals: { "deploy.restart": { targets: ["kios-rh-new-1"], per_day: 3, until: "2027-01-31" } },
};
const agent = { description: "Checks a change.", engine: ["pi", "claude"], native: "all", tools: ["git.open-pr", "task.note"], model: "main", limits: { turns: 12, tokens: 100000, spend_usd: 0.5 } };
const tool = { description: "Restarts one container.", effect: "privileged", timeout_seconds: 90, needs: ["bash"], network: [], secrets: [], inputs: { container: { type: "string", description: "Container name", required: true } } };
const play = {
  title: "Fix an issue", description: "Investigate, change, review.", inputs: { issue: { type: "string", required: true } }, trigger: { schedule: "0 8 * * 1" },
  step: [
    { id: "investigate", agent: "analyst", goal: "Find the cause of: {{issue}}" },
    { id: "change", agent: "developer", after: ["investigate"], review_by: "reviewer", max_rounds: 3 },
    { id: "release", agent: "release-manager", after: ["change"], approve: true },
  ],
};

describe("file schemas accept what docs/model.md shows", () => {
  it("brain.toml", () => expect(messages(BrainFile, brain)).toEqual([]));
  it("brain.toml: the time zone is an IANA name, UTC when not given, and a model's prices are optional and not negative", () => {
    expect(BrainFile.parse({ name: "Kios RH" }).timezone).toBe("UTC");
    expect(messages(BrainFile, { ...brain, timezone: "Mars/Olympus" })).toEqual(["timezone: must be an IANA time zone name, such as Europe/Paris"]);
    expect(messages(BrainFile, { ...brain, model: [{ ...brain.model[0], input_usd_per_mtok: -1 }] })).toHaveLength(1);
    expect(BrainFile.parse({ ...brain, model: [{ name: "main", provider: "anthropic", url: "https://api.anthropic.com", model: "opus" }] }).model[0]).not.toHaveProperty("input_usd_per_mtok");
  });
  it("agent.toml", () => expect(messages(AgentFile, agent)).toEqual([]));
  it("tool.toml, with a script, run by Brain, or a host command", () => {
    expect(messages(ToolFile, tool)).toEqual([]);
    expect(messages(ToolFile, { description: "Adds a note.", effect: "read", runs: "brain" })).toEqual([]);
    expect(messages(ToolFile, { description: "Shows disk use.", effect: "read", host_command: "disk-usage" })).toEqual([]);
  });
  it("a Play, with a schedule or a webhook trigger and every step field", () => {
    expect(messages(PlayFile, play)).toEqual([]);
    expect(messages(PlayFile, { ...play, trigger: { webhook: "github.issues.opened" } })).toEqual([]);
    expect(messages(PlayFile, { title: "Compete", step: [{ id: "draft", candidates: ["a", "b"], judge: "person", for_each: "steps.x.result.items", when: 'steps.x.result.ok == true', target_score: 0.8 }] })).toEqual([]);
  });
  it("pack.toml and a memory entry", () => {
    expect(messages(PackFile, { name: "base", description: "The base pack.", requires: [] })).toEqual([]);
    expect(MemoryEntry.parse(splitMemoryEntry("# Release checklist\n\nTag, then deploy.\n"))).toEqual({ title: "Release checklist", body: "Tag, then deploy." });
  });
  it("fills in what a file leaves out", () => {
    expect(BrainFile.parse({ name: "Small" })).toMatchObject({ packs: [], limits: { daily_spend_usd: 0, running_tasks: 4, confirm_plans: "person" }, model: [], project: [], approvals: {} });
    expect(AgentFile.parse({ description: "x", engine: ["pi"] })).toMatchObject({ native: "none", tools: [], limits: { spend_usd: 0 } });
    expect(PlayFile.parse({ title: "x", step: [{ id: "a", agent: "b" }] }).step[0]).toMatchObject({ after: [], max_rounds: 2, approve: false });
  });
});

describe("file schemas refuse", () => {
  it.each<[string, z.ZodType, unknown, RegExp]>([
    ["an unknown key in brain.toml", BrainFile, { ...brain, colour: "blue" }, /Unrecognized key/u],
    ["an unknown key in a nested table", BrainFile, { ...brain, limits: { daily_spend_usd: 1, weekly: 2 } }, /limits: Unrecognized key/u],
    ["a secret written in the file", BrainFile, { ...brain, model: [{ ...brain.model[0], key: "sk-live-123" }] }, /model\.0\.key: must be a reference written secret:<name>/u],
    ["a malformed secret reference", BrainFile, { ...brain, teams: { webhook: "secret:Teams Webhook" } }, /teams\.webhook/u],
    ["an unknown confirm_plans", BrainFile, { ...brain, limits: { confirm_plans: "never" } }, /limits\.confirm_plans/u],
    ["a negative spend cap", BrainFile, { ...brain, limits: { daily_spend_usd: -1 } }, /limits\.daily_spend_usd/u],
    ["a project access that is not read or write", BrainFile, { ...brain, project: [{ name: "p", repo: "r", access: "admin" }] }, /project\.0\.access/u],
    ["a standing approval without targets", BrainFile, { ...brain, approvals: { "deploy.restart": { targets: [], per_day: 3, until: "2027-01-31" } } }, /approvals\.deploy\.restart\.targets/u],
    ["a standing approval without an end date", BrainFile, { ...brain, approvals: { "deploy.restart": { targets: ["a"], per_day: 3 } } }, /until/u],
    ["a github table without a credential", BrainFile, { ...brain, github: { webhook_secret: "secret:x" } }, /github\.credential/u],
    ["an agent without an engine", AgentFile, { ...agent, engine: [] }, /engine/u],
    ["an unknown native level", AgentFile, { ...agent, native: "write" }, /native/u],
    ["an unknown key in agent limits", AgentFile, { ...agent, limits: { turns: 1, minutes: 2 } }, /limits: Unrecognized key/u],
    ["a tool name that is not one", AgentFile, { ...agent, tools: ["Deploy Restart"] }, /tools\.0/u],
    ["an unknown effect", ToolFile, { ...tool, effect: "destroy" }, /effect/u],
    ["a tool with no effect", ToolFile, { description: "x" }, /effect/u],
    ["runs with anything but brain", ToolFile, { ...tool, runs: "runner" }, /runs/u],
    ["a tool both run by Brain and a host command", ToolFile, { ...tool, runs: "brain", host_command: "restart" }, /not both/u],
    ["a host command with effect write", ToolFile, { ...tool, effect: "write", host_command: "restart" }, /must have effect privileged/u],
    ["an input of an unknown type", ToolFile, { ...tool, inputs: { container: { type: "text" } } }, /inputs\.container\.type/u],
    ["items on an input that is not an array", ToolFile, { ...tool, inputs: { container: { type: "string", items: { type: "string" } } } }, /items is only for an input of type array/u],
    ["a Play without steps", PlayFile, { ...play, step: [] }, /step/u],
    ["a step field that does not exist", PlayFile, { ...play, step: [{ id: "a", agent: "b", retries: 3 }] }, /step\.0: Unrecognized key/u],
    ["a trigger with both schedule and webhook", PlayFile, { ...play, trigger: { schedule: "0 8 * * 1", webhook: "github.issues.opened" } }, /either schedule or webhook/u],
    ["an empty trigger", PlayFile, { ...play, trigger: {} }, /either schedule or webhook/u],
    ["a schedule that is not cron", PlayFile, { ...play, trigger: { schedule: "every monday" } }, /five-field cron/u],
    ["a webhook that is not a GitHub event", PlayFile, { ...play, trigger: { webhook: "gitlab.push" } }, /GitHub event/u],
    ["a single candidate", PlayFile, { ...play, step: [{ id: "a", agent: "b", candidates: 1 }] }, /candidates/u],
    ["max_rounds of zero", PlayFile, { ...play, step: [{ id: "a", agent: "b", max_rounds: 0 }] }, /max_rounds/u],
    ["a pack with an unknown key", PackFile, { name: "base", version: 2 }, /Unrecognized key/u],
    ["a memory entry without a title line", MemoryEntry, splitMemoryEntry("Tag, then deploy."), /title/u],
  ])("%s", (_name, schema, value, expected) => {
    expect(messages(schema, value).join("\n")).toMatch(expected);
  });
});

describe("step templates", () => {
  it("reads inputs, earlier results and the for_each item", () => {
    expect(parseRef("issue")).toEqual({ kind: "input", name: "issue", path: [] });
    expect(parseRef("delivery.pull_request.title")).toEqual({ kind: "input", name: "delivery", path: ["pull_request", "title"] });
    expect(parseRef("steps.plan.result")).toEqual({ kind: "step", step: "plan", path: [] });
    expect(parseRef("steps.plan.result.tasks")).toEqual({ kind: "step", step: "plan", path: ["tasks"] });
    expect(parseRef("item.title")).toEqual({ kind: "item", path: ["title"] });
    expect(parseRef("steps.plan.output")).toBeUndefined();
    expect(parseRef("not a ref")).toBeUndefined();
  });
  it("finds every placeholder of a goal and leaves single braces alone", () => {
    expect(templateRefs('Fix {{issue}} using {{ steps.find.result.cause }}; reply {"ok": true} {{}}').map((found) => found.ref?.kind)).toEqual(["input", "step", undefined]);
  });
  it("renders strings as they are, other values as JSON and missing values as nothing", () => {
    const values: Record<string, unknown> = { issue: "the login bug", count: 3, list: ["a"] };
    expect(renderTemplate("{{issue}} / {{count}} / {{list}} / {{missing}}.", (ref) => (ref.kind === "input" ? (values[ref.name] as never) : undefined))).toBe('the login bug / 3 / ["a"] / .');
  });
  it("reads when as one comparison with a string, a number or a boolean", () => {
    expect(parseWhen('steps.route.result.category == "billing"')).toEqual({ ref: { kind: "step", step: "route", path: ["category"] }, op: "==", value: "billing" });
    expect(parseWhen("steps.check.result.healthy != false")).toMatchObject({ op: "!=", value: false });
    expect(parseWhen("{{count}} == 3")).toEqual({ ref: { kind: "input", name: "count", path: [] }, op: "==", value: 3 });
    expect(parseWhen("steps.a.result.x > 3")).toBeUndefined();
    expect(parseWhen("steps.a.result.x == billing")).toBeUndefined();
    expect(parseWhen("steps.a.result.x")).toBeUndefined();
  });
});
