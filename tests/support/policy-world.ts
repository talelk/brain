import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Digest } from "../../packages/contracts/src/index.ts";
import { Brain } from "../../apps/governor/src/application/brain";
import { parseRestrictedYaml } from "../../apps/governor/src/modules/configuration/compiler";
import { goldenDocs, setupWorld } from "../helpers";
import { controlledClock, type World } from "./step-policy";

// Tests of the policy a release carries (ADR 0067): the golden release with its one fixture policy changed, or with a further policy layer
// added, and the one-step fixture workflow, staged and activated through the Governor as an organization would.

export type PolicySpecDoc = Record<string, unknown>;
export interface PolicyWorldOptions {
  /** Changes the golden release's own policy (the floor layer). */
  readonly floor?: (spec: PolicySpecDoc) => void;
  /** Extra Policy documents, added as layers after the floor, in order. */
  readonly layers?: ReadonlyArray<{ id: string; spec: PolicySpecDoc }>;
  /** The step's declared timeout; `null` declares none. */
  readonly timeoutSeconds?: number | null;
  /** The step's declared isolation. */
  readonly isolation?: string;
}

const REVISION = "sha256:6dd84c7f907477ea38ad355392cf876b39c122adf8038762894d56cc160956b4";
const asText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The golden documents with the policy and the one fixture step changed as the options say. Documents that name a changed one by digest are re-pinned. */
export function policyDocs(options: PolicyWorldOptions = {}): Array<{ path: string; text: string }> {
  const docs = goldenDocs();
  const moved = new Map<string, string>();
  const edit = (path: string, change: (value: Record<string, unknown>) => void): void => {
    const doc = docs.find((candidate) => candidate.path.endsWith(path))!;
    const before = sha256Digest(new TextEncoder().encode(doc.text));
    const value = parseRestrictedYaml(doc.text, doc.path) as Record<string, unknown>;
    change(value);
    doc.text = asText(value);
    moved.set(before, sha256Digest(new TextEncoder().encode(doc.text)));
  };
  if (options.floor) edit("fixture-policy.yaml", (value) => options.floor!(value["spec"] as PolicySpecDoc));
  edit("fixture-workflow.yaml", (value) => {
    const spec = value["spec"] as { jobs: Record<string, Record<string, unknown>>; outputs: unknown };
    const echo = { ...spec.jobs["echo"]! };
    if (options.timeoutSeconds === null) delete echo["timeoutSeconds"];
    else if (options.timeoutSeconds !== undefined) echo["timeoutSeconds"] = options.timeoutSeconds;
    if (options.isolation) echo["runsOn"] = { ...(echo["runsOn"] as object), isolation: options.isolation };
    spec.jobs = { echo };
    spec.outputs = { message: { source: "job", jobId: "echo", pointer: "" } };
  });
  for (const doc of docs) for (const [from, to] of moved) doc.text = doc.text.replaceAll(from, to);
  for (const layer of options.layers ?? []) {
    docs.push({ path: `config/${layer.id}.yaml`, text: asText({ apiVersion: "brain.keyrus/v1", kind: "Policy", metadata: { id: layer.id, version: "1.0.0" }, spec: layer.spec }) });
  }
  return docs;
}

/** A Governor on a clock the test moves, with the options' release staged and active. */
export function policyWorld(options: PolicyWorldOptions = {}, clock = controlledClock()): { w: World; time: ReturnType<typeof controlledClock>; digest: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "brain-test-"));
  const w = setupWorld(new Brain({ dataDir, allowTestActor: true, clock: clock.clock }));
  const { digest } = w.brain.stageRelease(w.owner, policyDocs(options), REVISION);
  w.brain.activateRelease(w.owner, digest);
  return { w, time: clock, digest };
}

/** The release as an administrator sees it in the release view. */
export const inspected = (w: World, digest: string): { manifest: { effectivePolicy: null | { layers: string[]; provenance: Record<string, string>; effective: Record<string, unknown> } } } =>
  w.brain.inspectRelease(w.owner, digest) as never;
