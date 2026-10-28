import type { Placement, Resources } from "@brain/contracts";

export interface RunnerView {
  readonly id: string;
  readonly groupId: string;
  readonly adminState: string;
  readonly health: string;
  readonly online: boolean;
  readonly capabilities: ReadonlyMap<string, { verified: boolean; expiresAtMs: number }>;
  readonly capacity: Resources;
  readonly reserved: Resources;
  readonly reserve: Resources;
  readonly isolation: string;
  readonly engines: readonly string[];
}

export type QueueReason =
  | "BLOCKED_BY_POLICY" | "WAITING_FOR_APPROVAL" | "WAITING_FOR_RESOURCE"
  | "WAITING_FOR_RUNNER" | "INSUFFICIENT_CAPACITY" | "BUDGET_EXHAUSTED" | "READY";

export interface PlacementVerdict {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export function available(r: RunnerView): Resources {
  return {
    cpuMillicores: r.capacity.cpuMillicores - r.reserve.cpuMillicores - r.reserved.cpuMillicores,
    memoryMb: r.capacity.memoryMb - r.reserve.memoryMb - r.reserved.memoryMb,
    diskMb: r.capacity.diskMb - r.reserve.diskMb - r.reserved.diskMb,
    slots: r.capacity.slots - r.reserve.slots - r.reserved.slots,
  };
}

export function fits(demand: Resources, avail: Resources): boolean {
  return demand.cpuMillicores <= avail.cpuMillicores
    && demand.memoryMb <= avail.memoryMb
    && demand.diskMb <= avail.diskMb
    && demand.slots <= avail.slots
    && (demand.gpuMemoryMb ?? 0) <= (avail.gpuMemoryMb ?? Number.MAX_SAFE_INTEGER);
}

export function evaluateRunner(placement: Placement, demand: Resources, runner: RunnerView, nowMs: number): PlacementVerdict {
  const reasons: string[] = [];
  if (runner.adminState !== "enabled") reasons.push(`runner-admin-state:${runner.adminState}`);
  if (!runner.online) reasons.push("runner-offline");
  if (runner.health === "unhealthy") reasons.push("runner-unhealthy");
  if (runner.groupId !== placement.group) reasons.push("group-mismatch");
  if (runner.isolation !== placement.isolation) reasons.push("isolation-mismatch");
  for (const cap of placement.all) {
    const seen = runner.capabilities.get(cap);
    if (!seen) reasons.push(`missing-capability:${cap}`);
    else if (!seen.verified) reasons.push(`unverified-capability:${cap}`);
    else if (seen.expiresAtMs <= nowMs) reasons.push(`expired-capability:${cap}`);
  }
  if (placement.anyOf && placement.anyOf.length > 0) {
    const any = placement.anyOf.some((cap) => {
      const seen = runner.capabilities.get(cap);
      return seen?.verified && seen.expiresAtMs > nowMs;
    });
    if (!any) reasons.push("no-anyof-capability");
  }
  if (placement.engine) {
    const engineOk = placement.engine.anyOf.some((e) => runner.engines.includes(e));
    if (!engineOk) reasons.push("engine-mismatch");
  }
  if (!fits(demand, available(runner))) reasons.push("insufficient-capacity");
  return { eligible: reasons.length === 0, reasons };
}

export function rankRunners(a: RunnerView, b: RunnerView): number {
  const ah = available(a).cpuMillicores + available(a).memoryMb;
  const bh = available(b).cpuMillicores + available(b).memoryMb;
  if (bh !== ah) return bh - ah;
  return a.id.localeCompare(b.id);
}
