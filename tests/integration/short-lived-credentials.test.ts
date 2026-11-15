import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@brain/contracts";
import { SECRET_LEASE_CAP_MS, type SecretMaterial, type SecretScope, type SecretsAdapter } from "../../apps/governor/src/modules/secret-leases/index";
import { advance, closeWorlds, currentTimeMs, running, startedMission, task, type Offer, type Runner, type World } from "../support/machine-session";

// ADR 0070: the Governor mints, per attempt, short-lived credentials for secret references through a replaceable adapter port. A credential
// is bound to the attempt and fence it was minted under and is refused, and the refusal audited, once it expired, was revoked, or its
// attempt ended, was fenced, was stopped with the workspace or ran on a quarantined runner. State is reached through the runner protocol.

afterEach(closeWorlds);

const VALUE = "minted-secret-value-7c41e9d0";

/** A deployment's own adapter: it owns the `vault/` name space and issues a credential that dies on its own clock if the broker would let it live longer. */
class FakeVault implements SecretsAdapter {
  readonly id = "fake-vault";
  readonly asked: Array<{ scope: SecretScope; ref: string; notAfterMs: number }> = [];
  constructor(private readonly options: { ttlMs?: number } = {}) {}
  serves(ref: string): boolean { return ref.startsWith("vault/"); }
  resolve(scope: SecretScope, ref: string, notAfterMs: number): SecretMaterial | undefined {
    this.asked.push({ scope, ref, notAfterMs });
    if (ref === "vault/missing") return undefined;
    return { value: VALUE, ...(this.options.ttlMs ? { expiresAtMs: currentTimeMs() + this.options.ttlMs } : {}) };
  }
}

async function attempt(options: { vault?: FakeVault } = {}): Promise<{ w: World; runner: Runner; offer: Offer; vault: FakeVault }> {
  const { w, runner } = await startedMission({ tasks: [task("a"), task("b")] });
  const vault = options.vault ?? new FakeVault();
  w.brain.secrets.useAdapters([vault]);
  return { w, runner, offer: running(w, runner, "one"), vault };
}

const mint = (w: World, offer: Offer, refs: Record<string, string> = { API_TOKEN: "vault/api" }) =>
  w.brain.secrets.mint({ organizationId: w.org, workspaceId: w.workspaceId, attemptId: offer.attemptId, refs, toolId: "fixture.echo" });
const audit = async (w: World): Promise<AuditEntry[]> => ((await w.brain.executeQuery(w.owner, { queryType: "audit.list", workspaceId: w.workspaceId })) as unknown as { snapshot: { items: AuditEntry[] } }).snapshot.items;
const leases = (w: World) => w.brain.store.control.prepare("SELECT * FROM secret_credentials ORDER BY created_at_ms, id").all() as Array<Record<string, unknown>>;

describe("short-lived secret credentials (ADR 0070)", () => {
  it("mints through the adapter port, bound to the attempt and its fence, with a lifetime the attempt bounds, and never stores or reports the value", async () => {
    const { w, offer, vault } = await attempt();
    const [credential] = mint(w, offer);
    expect(credential).toMatchObject({ ref: "vault/api", envName: "API_TOKEN", value: VALUE });
    expect(vault.asked).toEqual([{ scope: { organizationId: w.org, workspaceId: w.workspaceId }, ref: "vault/api", notAfterMs: expect.any(Number) }]);
    const [row] = leases(w);
    expect(row).toMatchObject({ id: credential!.id, attempt_id: offer.attemptId, job_fence: offer.jobFence, ref: "vault/api", adapter: "fake-vault", tool_id: "fixture.echo", revoked_at_ms: null });
    // Never longer than the cap, and the adapter was told when the lease ends.
    expect(Number(row!["expires_at_ms"]) - Number(row!["created_at_ms"])).toBeLessThanOrEqual(SECRET_LEASE_CAP_MS);
    expect(credential!.expiresAtMs).toBe(Number(row!["expires_at_ms"]));
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).not.toThrow();
    // The value lives nowhere the Governor keeps: not the record, not an event, not the audit trail.
    const events = w.brain.store.control.prepare("SELECT payload_json FROM events").all();
    expect(JSON.stringify([leases(w), events, await audit(w)])).not.toContain(VALUE);
    expect(JSON.stringify(events)).toContain(credential!.id);
  });

  it("lets an adapter that issues a shorter-lived upstream credential end the lease sooner, and refuses and audits use after expiry", async () => {
    const { w, offer } = await attempt({ vault: new FakeVault({ ttlMs: 5_000 }) });
    const [credential] = mint(w, offer);
    expect(credential!.expiresAtMs).toBe(currentTimeMs() + 5_000);
    advance(4_000);
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).not.toThrow();
    advance(1_001);
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/it expired/u);
    expect(leases(w)[0]).toMatchObject({ revoked_reason: "expired" });
    const refusals = (await audit(w)).filter((entry) => entry.action === "secret.refused");
    expect(refusals).toHaveLength(1);
    expect(JSON.stringify(refusals)).not.toContain(VALUE);
    // A later use is still refused (revoked), and audited again.
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/revoked/u);
    expect((await audit(w)).filter((entry) => entry.action === "secret.refused")).toHaveLength(2);
  });

  it("is refused for a reference the adapters do not serve or the workspace does not hold, and leaves no lease behind", async () => {
    const { w, offer } = await attempt();
    expect(() => mint(w, offer, { API_TOKEN: "vault/api", OTHER: "vault/missing" })).toThrow(/no secret by that reference/u);
    expect(() => mint(w, offer, { API_TOKEN: "no-such-adapter-owns-this" })).toThrow(/no secret by that reference/u);
    expect(leases(w)).toEqual([]);
    expect((await audit(w)).filter((entry) => entry.action === "secret.refused")).toHaveLength(2);
  });

  it("is revoked when the attempt ends", async () => {
    const { w, runner, offer } = await attempt();
    const [credential] = mint(w, offer);
    w.brain.jobProtocol.complete(runner, offer.attemptId, { result: "succeeded", output: {}, jobFence: offer.jobFence, cleanupConfirmed: true });
    expect(leases(w)[0]).toMatchObject({ revoked_reason: "ended" });
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/revoked/u);
    // An ended attempt cannot be given a new one.
    expect(() => mint(w, offer)).toThrow(/not running under its fence/u);
  });

  it("is revoked when the attempt loses its lease, and refused for another attempt's use", async () => {
    const { w, runner, offer } = await attempt();
    const [credential] = mint(w, offer);
    // The attempt's own credential is no use to anyone else.
    w.brain.jobProtocol.heartbeat(runner, { sequence: 1, health: "healthy" });
    const second = running(w, runner, "two");
    expect(() => w.brain.secrets.validate(second.attemptId, [credential!.id])).toThrow(/no such secret credential for this attempt/u);
    advance(120_000);
    expect(w.brain.jobProtocol.expireLeases()).toBeGreaterThan(0);
    expect(leases(w)[0]).toMatchObject({ revoked_reason: "lease-lost" });
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/revoked/u);
  });

  it("is revoked by stop all sessions, which moves the fence", async () => {
    const { w, offer } = await attempt();
    const [credential] = mint(w, offer);
    w.brain.jobProtocol.stopAll({ organizationId: w.org, workspaceId: w.workspaceId });
    expect(leases(w)[0]).toMatchObject({ revoked_reason: "stop-all" });
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/revoked/u);
    expect(() => mint(w, offer)).toThrow(/not running under its fence/u);
  });

  it("is refused once the runner is quarantined, and revoked with it", async () => {
    const { w, runner, offer } = await attempt();
    const [credential] = mint(w, offer);
    w.brain.jobProtocol.controlRunner({ scopes: ["runner:admin", "runner:security"], actorId: "security-officer", organizationId: w.org }, { runnerId: runner.runnerId, action: "quarantine", reason: "suspected host compromise" });
    expect(leases(w)[0]).toMatchObject({ revoked_reason: "quarantine" });
    expect(() => w.brain.secrets.validate(offer.attemptId, [credential!.id])).toThrow(/revoked/u);
  });

  it("is minted for a runner only for the secrets its own tool declared: an agent attempt declares none", async () => {
    const { w, runner, offer } = await attempt();
    expect(() => w.brain.jobProtocol.secretCredentials(runner, offer.attemptId)).toThrow(/declares no secrets/u);
    expect(leases(w)).toEqual([]);
    // Another runner, or one that no longer holds the attempt, cannot ask at all.
    expect(() => w.brain.jobProtocol.validateSecretCredentials({ ...runner, epoch: runner.epoch + 1 }, offer.attemptId, ["sc-x"])).toThrow();
  });
});
