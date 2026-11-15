import { sha256Digest } from "../../packages/contracts/src/index.ts";
import { collectRelease } from "../../apps/cli/src/release";

export function fixtureStarter() {
  const bundle = collectRelease("examples/v1/starter-release");
  // Test the same release/runner protocol deterministically. Product agent
  // documents retain their real-engine requirements.
  const replacements = new Map<string, string>();
  for (const doc of bundle.documents) {
    const value = JSON.parse(doc.text);
    if (value.kind === "Play") {
      // A Play's team names the engine its agent runs on; the fixture agents run on the fixture engine.
      for (const member of value.spec.team as Array<{ engine: string }>) member.engine = "fixture";
      doc.text = JSON.stringify(value, null, 2) + "\n";
      continue;
    }
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

/**
 * The fixture starter, with the task validator declared as a model's opinion (the
 * evaluator `basis`), re-pinned everywhere the workflows name it. Its checks pass,
 * but a criterion supported only by a model's opinion is Unverified until a person
 * signs off (#49).
 */
export function modelOpinionStarter() {
  const bundle = fixtureStarter();
  const doc = bundle.documents.find((candidate) => candidate.path.endsWith("task-validator.yaml"))!;
  const prior = sha256Digest(new TextEncoder().encode(doc.text));
  const value = JSON.parse(doc.text);
  value.spec.basis = "model-opinion";
  doc.text = JSON.stringify(value, null, 2) + "\n";
  const next = sha256Digest(new TextEncoder().encode(doc.text));
  for (const other of bundle.documents) other.text = other.text.replaceAll(prior, next);
  return { ...bundle, evaluatorDigest: next };
}

/**
 * The fixture starter with delegation switched on for its task worker: it lists the `mission.delegate` tool and declares how many children
 * and how many levels it may have (ADR 0053). The shipped starter gives the tool to no agent, so a test that delegates opts in here.
 */
export function delegatingStarter(limits: { maxChildren: number; maxDepth: number } = { maxChildren: 2, maxDepth: 3 }) {
  const bundle = fixtureStarter();
  const agentDoc = bundle.documents.find((doc) => doc.path.endsWith("task-worker-agent.yaml"))!;
  const tool = bundle.documents.find((doc) => doc.path.endsWith("mission.delegate.yaml"))!;
  const prior = sha256Digest(new TextEncoder().encode(agentDoc.text));
  const agent = JSON.parse(agentDoc.text);
  agent.spec.tools.push({ id: "mission.delegate", digest: sha256Digest(new TextEncoder().encode(tool.text)) });
  agent.spec.maxChildren = limits.maxChildren;
  agent.spec.maxDepth = limits.maxDepth;
  agentDoc.text = JSON.stringify(agent, null, 2) + "\n";
  const next = sha256Digest(new TextEncoder().encode(agentDoc.text));
  for (const doc of bundle.documents) doc.text = doc.text.replaceAll(prior, next);
  return bundle;
}

/**
 * The fixture starter with the edits the test makes to named documents (found by path suffix), and every document that names an edited one
 * re-pinned to its new text, to a fixed point (tool -> agent -> workflow, policy -> type -> workspace).
 */
export function editedStarter(edits: Record<string, (value: Record<string, unknown>) => void>) {
  const bundle = fixtureStarter();
  const moved = new Map<string, string>();
  const sum = (text: string): string => sha256Digest(new TextEncoder().encode(text));
  for (const [suffix, change] of Object.entries(edits)) {
    const doc = bundle.documents.find((candidate) => candidate.path.endsWith(suffix))!;
    const prior = sum(doc.text);
    const value = JSON.parse(doc.text) as Record<string, unknown>;
    change(value);
    doc.text = JSON.stringify(value, null, 2) + "\n";
    moved.set(prior, sum(doc.text));
  }
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const doc of bundle.documents) {
      let text = doc.text;
      for (const [from, to] of moved) text = text.replaceAll(from, to);
      if (text === doc.text) continue;
      moved.set(sum(doc.text), sum(text));
      doc.text = text;
      changed = true;
    }
    if (!changed) break;
  }
  return bundle;
}

