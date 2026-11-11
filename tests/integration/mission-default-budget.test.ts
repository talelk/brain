import { describe, expect, it } from "vitest";
import type { CommandReceipt, Mission } from "@brain/contracts";
import { setupWorld } from "../helpers";

type World = ReturnType<typeof setupWorld>;

async function create(w: World, key: string, extra: Record<string, unknown>): Promise<Mission> {
  const receipt: CommandReceipt = (await w.brain.executeCommand(w.owner, {
    contractVersion: "brain.command/v1", commandId: `cmd-${key}`, commandType: "mission.create", workspaceId: w.workspaceId,
    idempotencyKey: key, payload: { title: key, intent: `Deliver ${key}`, successCriteria: ["delivered"], ...extra },
  } as never, key)).receipt;
  return ((await w.brain.executeQuery(w.owner, { queryType: "missions.get", workspaceId: w.workspaceId, resourceId: receipt.resourceId ?? "" })) as { snapshot: Mission }).snapshot;
}

describe("default mission budget (#47)", () => {
  it("applies a documented ceiling when the command names no budget, and respects an explicit one", async () => {
    const w = setupWorld();
    const plain = await create(w, "plain", {});
    expect(plain.budget).toMatchObject({ maxMicroUsd: 5_000_000, memberCap: 3 });
    const explicit = await create(w, "explicit", { budget: { maxMicroUsd: 1_000_000, memberCap: 1 } });
    expect(explicit.budget).toMatchObject({ maxMicroUsd: 1_000_000, memberCap: 1 });
  });
});
