import { existsSync, readFileSync } from "node:fs";
import { sha256Digest } from "@brain/contracts";
import type { Agent } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { casPathOf } from "../jobs/index";

/**
 * Release-pinned tool scripts (T22): a runner fetches the exact entrypoint
 * bytes staged with the release the job is pinned to, verifies the manifest
 * digest, and executes only those bytes. A tool without a staged script is
 * not runnable in enforced mode.
 */
export function readReleaseToolScript(
  s: Store,
  organizationId: string,
  releaseDigest: string,
  toolId: string,
): { entrypoint: string; entrypointDigest: string; bytes: Uint8Array } {
  const release = s.control.prepare("SELECT organization_id,manifest_json FROM config_releases WHERE digest=?").get(releaseDigest) as
    | { organization_id: string; manifest_json: string } | undefined;
  if (!release || release.organization_id !== organizationId) throw new BrainDomainError("NOT_FOUND", "release not found");
  let resolvedId = toolId;
  const stored = JSON.parse(release.manifest_json) as { evaluators?: Record<string, { spec?: { tool?: { id?: string } } }> };
  resolvedId = stored.evaluators?.[toolId]?.spec?.tool?.id ?? toolId;
  const row = s.control.prepare("SELECT entrypoint, digest, bytes FROM release_files WHERE release_digest=? AND tool_id=?").get(releaseDigest, resolvedId) as
    | { entrypoint: string; digest: string; bytes: number } | undefined;
  if (!row) throw new BrainDomainError("NOT_FOUND", `tool ${toolId} has no pinned script in this release`);
  const path = casPathOf(s.dataDir, row.digest);
  if (!existsSync(path)) throw new BrainDomainError("EVIDENCE_MISSING", "tool script bytes missing from CAS");
  const bytes = new Uint8Array(readFileSync(path));
  if (sha256Digest(bytes) !== row.digest || bytes.length !== row.bytes) {
    throw new BrainDomainError("EVIDENCE_MISSING", "tool script bytes do not match the pinned digest");
  }
  return { entrypoint: row.entrypoint, entrypointDigest: row.digest, bytes };
}

export function readReleaseAgentInstructions(
  s: Store,
  organizationId: string,
  releaseDigest: string,
  agentId: string,
): { agent: Agent; agentDigest: string; path: string; instructionsDigest: string; bytes: Uint8Array } {
  const release = s.control.prepare("SELECT organization_id,manifest_json FROM config_releases WHERE digest=?").get(releaseDigest) as
    | { organization_id: string; manifest_json: string } | undefined;
  if (!release || release.organization_id !== organizationId) throw new BrainDomainError("NOT_FOUND", "release not found");
  const stored = JSON.parse(release.manifest_json) as {
    agents?: Record<string, Agent>;
    manifest?: { agents?: Array<{ id: string; digest: string; instructions: { path: string; digest: string } }> };
  };
  const agent = stored.agents?.[agentId];
  const view = stored.manifest?.agents?.find((candidate) => candidate.id === agentId);
  const row = s.control.prepare("SELECT entrypoint,digest,bytes FROM release_files WHERE release_digest=? AND tool_id=?").get(releaseDigest, `agent:${agentId}`) as
    | { entrypoint: string; digest: string; bytes: number } | undefined;
  if (!agent || !view || !row || view.instructions.digest !== row.digest || view.instructions.path !== row.entrypoint) {
    throw new BrainDomainError("EVIDENCE_MISSING", "agent instructions are not pinned in this release");
  }
  const path = casPathOf(s.dataDir, row.digest);
  if (!existsSync(path)) throw new BrainDomainError("EVIDENCE_MISSING", "agent instruction bytes missing from CAS");
  const bytes = new Uint8Array(readFileSync(path));
  if (sha256Digest(bytes) !== row.digest || bytes.length !== row.bytes) throw new BrainDomainError("EVIDENCE_MISSING", "agent instruction bytes do not match the pinned digest");
  return { agent, agentDigest: view.digest, path: row.entrypoint, instructionsDigest: row.digest, bytes };
}

/** The pinned-tool digest map for a release, as embedded in job offers. */
export function releaseToolPins(s: Store, releaseDigest: string): Record<string, string> {
  const row = s.control.prepare("SELECT manifest_json FROM config_releases WHERE digest=?").get(releaseDigest) as { manifest_json: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.manifest_json) as {
      manifest?: { tools?: Array<{ id?: string; entrypointDigest?: string }> };
      evaluators?: Record<string, { spec?: { tool?: { id?: string } } }>;
    };
    const pins: Record<string, string> = {};
    const tools = parsed.manifest?.tools ?? [];
    for (const tool of tools) {
      if (tool.id && tool.entrypointDigest) pins[tool.id] = tool.entrypointDigest;
    }
    for (const [evaluatorId, evaluator] of Object.entries(parsed.evaluators ?? {})) {
      const toolId = evaluator.spec?.tool?.id;
      const pin = tools.find((tool) => tool.id === toolId)?.entrypointDigest;
      if (pin) pins[evaluatorId] = pin;
    }
    return pins;
  } catch { return {}; }
}
