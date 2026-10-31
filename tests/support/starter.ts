import { sha256Digest } from "../../packages/contracts/src/index.ts";
import { collectRelease } from "../../apps/cli/src/release";

export function fixtureStarter() {
  const bundle = collectRelease("examples/v1/starter-release");
  // Test the same release/runner protocol deterministically. Product agent
  // documents retain their real-engine requirements.
  const replacements = new Map<string, string>();
  for (const doc of bundle.documents) {
    const value = JSON.parse(doc.text);
    if (value.kind !== "Agent" && value.kind !== "Workflow") continue;
    const prior = sha256Digest(new TextEncoder().encode(doc.text));
    if (value.kind === "Agent") value.spec.engine.anyOf = ["fixture"];
    else for (const job of Object.values<{ runsOn: { engine: { anyOf: string[] } } }>(value.spec.jobs)) job.runsOn.engine.anyOf = ["fixture"];
    doc.text = JSON.stringify(value, null, 2) + "\n";
    replacements.set(prior, sha256Digest(new TextEncoder().encode(doc.text)));
  }
  for (const doc of bundle.documents) for (const [prior, next] of replacements) doc.text = doc.text.replaceAll(prior, next);
  return bundle;
}

