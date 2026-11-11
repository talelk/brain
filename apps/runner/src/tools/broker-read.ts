import type { EngineToolBinding } from "@brain/contracts";
import { GovernorProtocolError, type GovernorClient } from "../governor-client";
import { GOVERNOR_BROKERED, RUNNER_BROKERED, webFetch, type BrokerResult } from "./brokers";

/**
 * Resolves the data a brokered read tool needs: the Governor answers documents, CSV artifacts and knowledge (rechecking scope and the
 * agent's allowlist, auditing refusals); web pages are fetched here under the pinned host allowlist. Tools with no broker return
 * undefined and run as before.
 */
export async function brokerRead(binding: EngineToolBinding, input: Readonly<Record<string, unknown>>, attemptId: string, client: Pick<GovernorClient, "toolRead">): Promise<BrokerResult | undefined> {
  const id = binding.release.id;
  if (RUNNER_BROKERED.has(id)) return webFetch(input, binding.allowedHosts);
  if (!GOVERNOR_BROKERED.has(id)) return undefined;
  try {
    return { ok: true, data: (await client.toolRead(attemptId, { tool: binding.release, input: { ...input } })) as never };
  } catch (error) {
    if (error instanceof GovernorProtocolError) {
      const detail = (error.body as { detail?: string } | null)?.detail;
      return { ok: false, error: detail ?? `the Governor refused the read (${error.status})` };
    }
    throw error;
  }
}
