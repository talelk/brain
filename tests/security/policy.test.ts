import { describe, expect, it } from "vitest";
import { mergePolicyFloor, type PolicySpec } from "../../apps/governor/src/modules/configuration/policy-floor";
import { scopesForPrincipal } from "../../apps/governor/src/application/authz";
import { setupWorld } from "../helpers";

// T12 packet acceptance: deny-first policy floor (layers may only restrict),
// scope narrowing per workspace role, tenant isolation of scopes.
describe("policy floor (T12)", () => {
  const base: PolicySpec = {
    productionHumanApproval: "required", defaultEffect: "deny",
    allowedOperations: ["fixture.echo", "fixture.verify", "http.fetch"],
    deniedOperations: ["shell.exec"], maxMicroUsd: 5000, maxRuntimeSeconds: 600,
    minimumIsolation: "ephemeral-container", separationOfDuties: true,
  };

  it("layers may only restrict: allowlists intersect, denies union, caps take the minimum", () => {
    const r = mergePolicyFloor([
      { name: "org", spec: base },
      { name: "ws", spec: { allowedOperations: ["fixture.echo", "http.fetch"], deniedOperations: ["http.fetch"], maxMicroUsd: 1000, maxRuntimeSeconds: 9999, minimumIsolation: "microvm" } },
    ]);
    expect(r.effective.allowedOperations).toEqual(["fixture.echo"]);
    expect(r.effective.deniedOperations).toEqual(["http.fetch", "shell.exec"]);
    expect(r.effective.maxMicroUsd).toBe(1000);
    expect(r.effective.maxRuntimeSeconds).toBe(600);
    expect(r.effective.minimumIsolation).toBe("microvm");
    expect(r.effective.defaultEffect).toBe("deny");
    expect(r.effective.separationOfDuties).toBe(true);
    expect(r.provenance["maxMicroUsd"]).toBe("ws");
  });

  it("broadening attempts and null-disables fail the whole merge", () => {
    expect(() => mergePolicyFloor([{ name: "org", spec: base }, { name: "evil", spec: { defaultEffect: "allow" } }])).toThrow(/broaden/);
    expect(() => mergePolicyFloor([{ name: "org", spec: base }, { name: "evil", spec: { productionHumanApproval: "optional" } }])).toThrow(/turn off/);
    expect(() => mergePolicyFloor([{ name: "org", spec: { separationOfDuties: null as unknown as boolean } }])).toThrow(/null cannot disable/);
    expect(() => mergePolicyFloor([])).toThrow(/at least one layer/);
    expect(() => mergePolicyFloor([{ name: "org", spec: { minimumIsolation: "banana" } }])).toThrow(/incomparable/);
  });

  it("workspace scopes narrow by role and never leak across tenants", () => {
    const w = setupWorld();
    // A second workspace the owner is only a viewer in.
    w.brain.createWorkspace(w.owner, { workspaceId: "ws-other", slug: "other" });
    w.brain.store.control.prepare("DELETE FROM workspace_memberships WHERE workspace_id='ws-other' AND principal_id='owner-1'").run();
    w.brain.ensurePrincipal(w.org, "viewer-1", "human");
    w.brain.store.control.prepare("INSERT INTO workspace_memberships(workspace_id, organization_id, principal_id, role, version, granted_by, granted_at_ms) VALUES ('ws-other', ?, 'viewer-1', 'viewer', 1, 'owner-1', ?)")
      .run(w.org, w.brain.store.now());
    const ownerScopes = scopesForPrincipal(w.brain.store, "owner-1", w.org, w.workspaceId);
    const viewerScopes = scopesForPrincipal(w.brain.store, "viewer-1", w.org, "ws-other");
    expect(ownerScopes).toContain("workflow:dispatch");
    expect(viewerScopes).not.toContain("workflow:dispatch");
    expect(viewerScopes).not.toContain("runner:admin");
    // No membership in the owner's workspace: no workspace scopes there.
    const crossTenant = scopesForPrincipal(w.brain.store, "viewer-1", w.org, w.workspaceId);
    expect(crossTenant).not.toContain("workflow:dispatch");
    // Unknown organization: empty scope set.
    expect(scopesForPrincipal(w.brain.store, "owner-1", "org-elsewhere", w.workspaceId)).toEqual([]);
    w.brain.close();
  });
});
