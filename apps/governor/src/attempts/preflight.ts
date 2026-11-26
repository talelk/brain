import type { Wait } from "@brain/contracts";
import { MODEL_DEFAULTS, secretName, speaks } from "@brain/contracts";
import type { Gov } from "../dispatch";
import { payloadOf, type AttemptRow } from "../tasks/store";
import { hasSecret } from "../trust/secrets";
import { modelsOf } from "../workspace/platform";
import { manifestOf } from "../workspace/store";
import { credentialOf, routesOf } from "./offer";

/** A prompt takes about a token in four bytes. */
const BYTES_PER_TOKEN = 4;

/**
 * Why an attempt cannot work yet, or null (docs/model.md, "The queue"): what the Governor can see without leaving itself. A tool run (`act`) needs no model and
 * no credential. Nothing is stored; a fixed file or secret is seen on the next look.
 */
export function unready(gov: Gov, attempt: AttemptRow, snapshot: Parameters<typeof manifestOf>[1]): Extract<Wait, { kind: "unready" }> | null {
  const problem = (what: Extract<Wait, { kind: "unready" }>["problem"], name = ""): Extract<Wait, { kind: "unready" }> => ({ kind: "unready", problem: what, name });
  if (payloadOf(attempt).act) return null;
  const manifest = manifestOf(gov, snapshot);
  const agent = manifest.agents[attempt.agent];
  if (!agent) return null;
  const { models, from } = modelsOf(gov, attempt.workspace_id, manifest);
  if (models.length === 0) return problem("no-model");
  const holder = from?.id ?? attempt.workspace_id;
  const keyless = models.filter((model) => model.key && !hasSecret(gov, holder, secretName(model.key)));
  if (keyless.length === models.length) return problem("model-key", keyless[0]?.name ?? "");
  const routes = routesOf(gov, attempt.workspace_id, manifest, agent.model);
  if (!agent.engine.some((engine) => speaks(engine, routes))) return problem("engine-model", attempt.agent);
  for (const project of manifest.projects) {
    const credential = credentialOf(manifest, project);
    if (credential && !hasSecret(gov, attempt.workspace_id, secretName(credential))) return problem("credential", secretName(credential));
  }
  const routed = models.find((model) => model.name === agent.model) ?? models[0];
  const window = (routed?.context_tokens ?? MODEL_DEFAULTS.context_tokens) * (routed?.compact_at ?? MODEL_DEFAULTS.compact_at);
  if (agent.prompt.bytes / BYTES_PER_TOKEN > window) return problem("prompt", attempt.agent);
  return null;
}
