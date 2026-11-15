import { beforeAll, describe, expect, it } from "vitest";
import { loadEnglishRest } from "../../apps/web/src/i18n";
import { choiceView } from "../../apps/web/src/ui/components/choice-sentences";

// The Why tab words what the Governor recorded (ticket 144): every recorded code has a plain sentence, every fact a line, and nothing raw leaks.
const at = "2026-11-15T10:00:00.000Z";
const choice = (kind: string, code: string, facts: Record<string, unknown>) => ({ kind, code, facts, recordedAt: at }) as never;

describe("choice reasons read as plain sentences", () => {
  beforeAll(async () => { await loadEnglishRest(); });
  it("words a way of working with the workflows it ruled out and why", () => {
    const view = choiceView(choice("way-of-working", "workspace-way-of-working", {
      workflowId: "sre-task", requiredTools: ["host.exec", "host.read"],
      rejected: [
        { workflowId: "general-task", why: "missing-tool", missingTools: ["host.exec", "host.read"] },
        { workflowId: "ghost", why: "not-in-release" },
        { workflowId: "bare", why: "no-input-schema" },
        { workflowId: "picky", why: "input-refused", detail: "/situation is required" },
      ],
    }));
    expect(view.title).toBe("This task ran on sre-task, the workspace's way of working.");
    expect(view.lines).toEqual([
      "The task has to observe these tools: host.exec, host.read.",
      "general-task was set aside: its agent lacks host.exec, host.read.",
      "ghost was set aside: it is not in the active release.",
      "bare was set aside: it declares no input, so Brain could not fill it in.",
      "picky was set aside: it did not accept the task's brief (/situation is required).",
    ]);
  });

  it("words a team member with the spend caps and the members that would also have fit", () => {
    const view = choiceView(choice("team-member", "member-eligible", { memberId: "backend", role: "Backend engineer", agentId: "builder", engine: "pi", requiredTools: ["repo.write"], taskMaxMicroUsd: 400_000, agentMaxMicroUsd: 1_000_000, alsoEligible: ["backend-2"] }));
    expect(view.title).toBe("backend (Backend engineer) took this task.");
    expect(view.lines).toEqual(["Its agent is builder, running on pi.", "It has every tool the task needs: repo.write.", "The task's spend cap ($0.40) fits within the agent's ($1.00).", "Also eligible: backend-2."]);
  });

  it("words a model route offer, a wait, and what served an attempt", () => {
    const first = choiceView(choice("model-route", "first-route", {
      role: "evaluator", routeId: "b", model: "model-b", costTier: "low", position: 2, fallbacks: [{ routeId: "c", model: "model-c", costTier: "standard" }],
      skipped: [{ routeId: "a", why: "cooling", until: at }, { routeId: "d", why: "above-cost-tier" }], agentPrefers: ["b"], agentCostCeiling: "standard",
    }));
    expect(first.title).toBe("The independent check was handed model-b (b) first: place 2 in the model routes, cost tier low.");
    expect(first.lines[0]).toBe("If it refuses for quota the next route is tried, in this order: model-c (c).");
    expect(first.lines).toContain("The agent prefers these routes first: b.");
    expect(first.lines).toContain("d was left out: it costs more than the agent accepts.");
    expect(first.lines.find((line) => line.startsWith("a was left out"))).toMatch(/^a was left out: it is out of quota until .+\.$/);
    const held = choiceView(choice("model-route", "held", { role: "second-attempt", skipped: [{ routeId: "a", why: "down" }], retryAt: at }));
    expect(held.title).toBe("The second attempt is waiting for a model route: every route that would serve it is down or out of quota.");
    expect(held.lines[0]).toBe("a was left out: its health check says it is down.");
    const served = choiceView(choice("model-route", "served-after-failover", { servedBy: "b", model: "model-b", tried: [{ routeId: "a", model: "model-a", outcome: "quota" }, { routeId: "b", model: "model-b", outcome: "served" }] }));
    expect(served).toEqual({ title: "model-b (b) answered this attempt.", lines: ["Passed over on the way: a."] });
    expect(choiceView(choice("model-route", "none-served", { tried: [{ routeId: "a", model: "model-a", outcome: "quota" }] })).title).toBe("No model route answered this attempt.");
  });
});
