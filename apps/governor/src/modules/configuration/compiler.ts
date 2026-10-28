import { parseDocument, isAlias } from "yaml";
import type { Evaluator, JsonValue, Workflow } from "@brain/contracts";
import { validate } from "@brain/contracts/validate";
import { domainDigest, sha256Digest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import { mergePolicyFloor, type PolicySpec } from "./policy-floor";

export interface SourceDoc { readonly path: string; readonly text: string }
export interface CompiledRelease {
  readonly digest: string;
  readonly manifest: JsonValue;
  readonly workflows: Readonly<Record<string, Workflow>>;
  readonly evaluators: Readonly<Record<string, Evaluator>>;
  readonly documents: readonly { kind: string; id: string; digest: string }[];
}

const KINDS = new Set(["BrainConfig", "WorkspaceType", "Workspace", "RunnerGroup", "Agent", "Tool", "Policy", "Workflow", "Pack", "Connector", "Evaluator", "Schedule"]);

export function parseRestrictedYaml(text: string, path: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new BrainDomainError("INVALID_CONTRACT", `${path}: definition too large`);
  // Explicit YAML tags (!!, !custom) are outside the restricted grammar. The
  // parser normalizes core tags (tag:yaml.org,2002:*) so node inspection
  // cannot distinguish them from implicit resolution; reject at the source.
  for (const line of text.split("\n")) {
    const unquoted = line.replace(/"[^"]*"|'[^']*'/g, "");
    if (/(^|:|\s|,\s*|-\s+)!!?[A-Za-z][\w-]*(\s|$)/u.test(unquoted)) {
      throw new BrainDomainError("INVALID_CONTRACT", `${path}: explicit YAML tag forbidden`);
    }
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new BrainDomainError("INVALID_CONTRACT", `${path}: ${doc.errors[0]?.message ?? "yaml error"}`);
  }
  // Reject aliases / merge keys / custom tags by scanning nodes.
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as { tag?: string; items?: unknown[]; key?: unknown; value?: unknown };
    if (isAlias(node as never)) throw new BrainDomainError("INVALID_CONTRACT", `${path}: YAML alias forbidden`);
    if (typeof n.tag === "string" && n.tag.startsWith("!")) throw new BrainDomainError("INVALID_CONTRACT", `${path}: custom tag forbidden`);
    if (Array.isArray(n.items)) for (const it of n.items) visit(it);
    if ("key" in n) visit(n.key);
    if ("value" in n) visit(n.value);
  };
  visit(doc.contents);
  const value = doc.toJS() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainDomainError("INVALID_CONTRACT", `${path}: definition must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function compileWorkflowGraph(workflow: Workflow, label: string): readonly string[] {
  const jobs = workflow.spec.jobs;
  const ids = Object.keys(jobs);
  if (ids.length === 0) throw new BrainDomainError("INVALID_CONTRACT", `${label}: workflow has no jobs`);
  if (ids.length > 100) throw new BrainDomainError("INVALID_CONTRACT", `${label}: workflow exceeds 100 jobs`);
  for (const [id, job] of Object.entries(jobs)) {
    for (const need of job.needs) {
      if (!(need in jobs)) throw new BrainDomainError("INVALID_CONTRACT", `${label}: job ${id} needs unknown job ${need}`);
    }
    if (job.kind === "gate" && !("proposalFrom" in job)) throw new BrainDomainError("INVALID_CONTRACT", `${label}: gate ${id} missing proposal`);
  }
  // Kahn topological sort, lexicographic tie-break; cycle => reject.
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) { indeg.set(id, 0); dependents.set(id, []); }
  for (const [id, job] of Object.entries(jobs)) {
    indeg.set(id, job.needs.length);
    for (const n of job.needs) dependents.get(n)?.push(id);
  }
  const order: string[] = [];
  const ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) break;
    order.push(next);
    for (const dep of (dependents.get(next) ?? []).sort()) {
      const d = (indeg.get(dep) ?? 0) - 1;
      indeg.set(dep, d);
      if (d === 0) { ready.push(dep); ready.sort(); }
    }
  }
  if (order.length !== ids.length) throw new BrainDomainError("INVALID_CONTRACT", `${label}: workflow graph has a cycle`);
  // True gate dominance: every write/privileged effect must be dominated by a
  // gate, i.e. every path from a root to the effect passes through the gate.
  // A gate on only one branch does not dominate the join (iterative dominators
  // over a virtual super-root).
  const ROOT = "\u0000root";
  const preds = new Map<string, string[]>();
  for (const id of ids) {
    const needs = jobs[id]?.needs ?? [];
    preds.set(id, needs.length > 0 ? [...needs] : [ROOT]);
  }
  const dom = new Map<string, Set<string>>();
  dom.set(ROOT, new Set([ROOT]));
  for (const id of ids) dom.set(id, new Set([ROOT, ...ids]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      const ps = preds.get(id) ?? [ROOT];
      let acc: Set<string> | undefined;
      for (const p of ps) {
        const pd = dom.get(p) ?? new Set<string>();
        acc = acc === undefined ? new Set(pd) : new Set([...acc].filter((x) => pd.has(x)));
      }
      const next = new Set([id, ...(acc ?? new Set<string>())]);
      const cur = dom.get(id) ?? new Set<string>();
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  for (const id of order) {
    const job = jobs[id];
    if (!job) continue;
    const dominators = dom.get(id) ?? new Set<string>();
    const dominatedByGate = [...dominators].some((a) => a !== id && jobs[a]?.kind === "gate");
    if (job.kind === "dispatch" && "effectClass" in job && (job as { effectClass: string }).effectClass !== "read") {
      if (!dominatedByGate) throw new BrainDomainError("INVALID_CONTRACT", `${label}: effect job ${id} has no dominating gate`);
    }
    if (job.kind === "merge" && !dominatedByGate) {
      throw new BrainDomainError("INVALID_CONTRACT", `${label}: merge job ${id} has no dominating gate`);
    }
  }
  return order;
}

const MAX_SUBGRAPH_DEPTH = 4;

export function assertSubgraphBounds(workflows: Readonly<Record<string, Workflow>>, label: string): void {
  const depthOf = (id: string, visiting: ReadonlySet<string>): number => {
    if (visiting.has(id)) throw new BrainDomainError("INVALID_CONTRACT", `${label}: subgraph cycle at ${id}`);
    const wf = workflows[id];
    if (!wf) throw new BrainDomainError("INVALID_CONTRACT", `${label}: subgraph references unknown workflow ${id}`);
    let depth = 0;
    for (const job of Object.values(wf.spec.jobs)) {
      if (job.kind !== "subgraph") continue;
      const ref = (job as { workflow?: { id?: string } }).workflow?.id;
      if (!ref) throw new BrainDomainError("INVALID_CONTRACT", `${label}: subgraph job missing workflow ref`);
      depth = Math.max(depth, 1 + depthOf(ref, new Set([...visiting, id])));
    }
    return depth;
  };
  for (const id of Object.keys(workflows)) {
    const d = depthOf(id, new Set());
    if (d > MAX_SUBGRAPH_DEPTH) {
      throw new BrainDomainError("INVALID_CONTRACT", `${label}: workflow ${id} subgraph depth ${d} exceeds ${MAX_SUBGRAPH_DEPTH}`);
    }
  }
}

export function assertConfinedDocPaths(docs: readonly SourceDoc[]): void {
  const folded = new Map<string, string>();
  for (const { path } of docs) {
    if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
      throw new BrainDomainError("INVALID_CONTRACT", `config path escapes the confined loader: ${path}`);
    }
    const segments = path.split("/");
    if (segments.some((s) => s === ".." || s === "." || s === "")) {
      throw new BrainDomainError("INVALID_CONTRACT", `config path escapes the confined loader: ${path}`);
    }
    if (!/\.ya?ml$/i.test(path)) throw new BrainDomainError("INVALID_CONTRACT", `config path must be YAML: ${path}`);
    const key = path.toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined && prior !== path) {
      throw new BrainDomainError("INVALID_CONTRACT", `config path case collision: ${prior} vs ${path}`);
    }
    if (prior === path) throw new BrainDomainError("INVALID_CONTRACT", `duplicate config path: ${path}`);
    folded.set(key, path);
  }
}

const DANGEROUS_REGEX = /(\([^)]*[+*][^)]*\)\s*[+*])|(\(\?[:=!<][^)]*[+*][^)]*\)\s*[+*])|(\[[^\]]*\]\s*\{[0-9]{4,})/;

export function assertSchemaSafety(value: unknown, path: string, depth = 0): void {
  if (depth > 32) throw new BrainDomainError("INVALID_CONTRACT", `${path}: definition nesting exceeds 32`);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new BrainDomainError("INVALID_CONTRACT", `${path}: array exceeds 4096 entries`);
    for (const v of value) assertSchemaSafety(v, path, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "$ref" && typeof v === "string" && !v.startsWith("#/")) {
      throw new BrainDomainError("INVALID_CONTRACT", `${path}: external schema $ref forbidden (${v})`);
    }
    if (k === "$id" && typeof v === "string" && /^(https?|file):/i.test(v)) {
      throw new BrainDomainError("INVALID_CONTRACT", `${path}: network schema $id forbidden`);
    }
    if (k === "pattern" && typeof v === "string") {
      if (v.length > 200 || DANGEROUS_REGEX.test(v)) {
        throw new BrainDomainError("INVALID_CONTRACT", `${path}: regex pattern too complex`);
      }
      try { new RegExp(v); } catch { throw new BrainDomainError("INVALID_CONTRACT", `${path}: invalid regex pattern`); }
    }
    assertSchemaSafety(v, path, depth + 1);
  }
}

/** A pinned tool entrypoint script staged alongside the release documents. */
export interface ToolScript { readonly toolId: string; readonly entrypoint: string; readonly bytesBase64: string }

export function compileRelease(docs: readonly SourceDoc[], sourceRevision: string, scripts?: readonly ToolScript[]): CompiledRelease {
  assertConfinedDocPaths(docs);
  const workflows: Record<string, Workflow> = {};
  const evaluators: Record<string, Evaluator> = {};
  const entries: { kind: string; id: string; digest: string; bytes: number; path: string }[] = [];
  const tools: { id: string; digest: string; effectClass: string; inputSchemaRef: string; outputSchemaRef: string; entrypoint?: string; entrypointDigest?: string }[] = [];
  const seenIds = new Set<string>();
  const policies: { name: string; spec: Record<string, unknown> }[] = [];
  let brainConfigUi: Record<string, unknown> | undefined;
  for (const { path, text } of docs) {
    const raw = parseRestrictedYaml(text, path);
    assertSchemaSafety(raw, path);
    const kind = String(raw["kind"] ?? "");
    if (raw["apiVersion"] !== "brain.keyrus/v1") throw new BrainDomainError("INVALID_CONTRACT", `${path}: apiVersion must be brain.keyrus/v1`);
    if (!KINDS.has(kind)) throw new BrainDomainError("INVALID_CONTRACT", `${path}: unsupported kind ${kind}`);
    const meta = raw["metadata"] as { id?: string } | undefined;
    const id = String(meta?.id ?? "");
    if (!id) throw new BrainDomainError("INVALID_CONTRACT", `${path}: metadata.id required`);
    const key = `${kind}:${id}`;
    if (seenIds.has(key)) throw new BrainDomainError("INVALID_CONTRACT", `${path}: duplicate ${key}`);
    seenIds.add(key);
    const spec = raw["spec"] as Record<string, unknown> | undefined;
    if (kind === "Workflow") {
      if (!spec || !("jobs" in spec)) {
        if (spec && "nodes" in spec) throw new BrainDomainError("INVALID_CONTRACT", `${path}: spec.nodes unsupported; use spec.jobs`);
        throw new BrainDomainError("INVALID_CONTRACT", `${path}: Workflow spec.jobs required`);
      }
      if ("jobs" in raw && !("spec" in raw)) throw new BrainDomainError("INVALID_CONTRACT", `${path}: root jobs unsupported`);
      const wf = raw as unknown as Workflow;
      compileWorkflowGraph(wf, path);
      workflows[id] = wf;
    }
    if (kind === "Evaluator") {
      const check = validate("Evaluator", raw);
      if (!check.ok) throw new BrainDomainError("INVALID_CONTRACT", `${path}: ${check.errors.join("; ")}`);
      evaluators[id] = raw as unknown as Evaluator;
    }
    if (kind === "BrainConfig") {
      const ui = spec?.["ui"] as Record<string, unknown> | undefined;
      if (!ui) throw new BrainDomainError("INVALID_CONTRACT", `${path}: BrainConfig.spec.ui required`);
      if (ui["foundation"] !== "newui") throw new BrainDomainError("INVALID_CONTRACT", `${path}: UI foundation must be newui`);
      const locales = ui["supportedLocales"] as unknown;
      const def = ui["defaultLocale"];
      if (!Array.isArray(locales) || typeof def !== "string" || !locales.includes(def)) {
        throw new BrainDomainError("INVALID_CONTRACT", `${path}: UI_DEFAULT_LOCALE_UNAVAILABLE`);
      }
      brainConfigUi = ui;
    }
    if (kind === "Policy") policies.push({ name: path, spec: spec ?? {} });
    const docDigest = sha256Digest(new TextEncoder().encode(text));
    if (kind === "Tool") {
      const effectClass = String(spec?.["effectClass"] ?? "");
      const inputSchemaRef = String(spec?.["inputSchemaRef"] ?? "");
      const outputSchemaRef = String(spec?.["outputSchemaRef"] ?? "");
      if (!effectClass || !inputSchemaRef || !outputSchemaRef) throw new BrainDomainError("INVALID_CONTRACT", `${path}: Tool spec.effectClass/inputSchemaRef/outputSchemaRef required`);
      // T22: when entrypoint scripts are staged with the release, each tool is
      // pinned to the exact script bytes (sha256 of the decoded file).
      const script = scripts?.find((s) => s.toolId === id);
      const pin = script
        ? { entrypoint: script.entrypoint, entrypointDigest: sha256Digest(new Uint8Array(Buffer.from(script.bytesBase64, "base64"))) }
        : undefined;
      tools.push({ id, digest: docDigest, effectClass, inputSchemaRef, outputSchemaRef, ...(pin ?? {}) });
    }
    entries.push({ kind, id, digest: docDigest, bytes: Buffer.byteLength(text, "utf8"), path });
  }
  assertSubgraphBounds(workflows, sourceRevision);
  for (const workflow of Object.values(workflows)) for (const job of Object.values(workflow.spec.jobs)) {
    if (job.kind !== "eval") continue;
    if (!evaluators[job.evaluator.id] || !entries.some((entry) => entry.kind === "Evaluator" && entry.id === job.evaluator.id && entry.digest === job.evaluator.digest)) throw new BrainDomainError("INVALID_CONTRACT", `evaluator ${job.evaluator.id} must match an immutable document in this release`);
  }
  // Multiple Policy documents are floor layers in document order; a later
  // layer may only restrict. Broadening/null-disable rejects the release.
  if (policies.length > 1) {
    mergePolicyFloor(policies.map((p) => ({ name: p.name, spec: p.spec as unknown as PolicySpec })));
  }
  // The compiled IR (lowered workflows/evaluators + document index) is a
  // real digest-addressed artifact of the release; ConfigRelease views are
  // derived from these exact fields, never synthesized at read time.
  const ir = { workflows, evaluators, documents: entries } as unknown as JsonValue;
  const irJson = JSON.stringify(ir);
  const primitiveVersions: Record<string, string> = {};
  for (const e of entries) primitiveVersions[`${e.kind}:${e.id}`] = e.digest;
  const manifest: JsonValue = {
    sourceRevision, documents: entries as unknown as JsonValue,
    workflows: Object.keys(workflows).sort(), uiFoundation: brainConfigUi ? "newui" : "absent",
    ui: (brainConfigUi ?? null) as JsonValue,
    compilerDigest: domainDigest("brain:compiler:v1", { compiler: "brain-config-compiler", version: 1 }),
    irArtifact: {
      artifactId: "config-ir", digest: domainDigest("brain:config-ir:v1", ir),
      bytes: Buffer.byteLength(irJson, "utf8"), mediaType: "application/json", classification: "internal",
    },
    assets: entries.map((e) => ({
      artifactId: e.id, digest: e.digest, bytes: e.bytes, mediaType: "application/yaml", classification: "internal",
    })),
    primitiveVersions,
    tools: tools as unknown as JsonValue,
  };
  const digest = domainDigest("brain:config-release:v1", manifest);
  return { digest, manifest, workflows, evaluators, documents: entries };
}

export function resolveBinding(bindings: Readonly<Record<string, unknown>>, input: JsonValue, outputs: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, raw] of Object.entries(bindings)) {
    const b = raw as { source: string; value?: JsonValue; pointer?: string; jobId?: string };
    if (b.source === "literal") out[name] = b.value ?? null;
    else if (b.source === "input") out[name] = pointerGet(input, b.pointer ?? "");
    else if (b.source === "job") {
      const src = b.jobId ? outputs[b.jobId] : undefined;
      if (src === undefined) throw new BrainDomainError("INVALID_CONTRACT", `binding ${name}: job output unavailable`);
      out[name] = pointerGet(src, b.pointer ?? "");
    } else throw new BrainDomainError("INVALID_CONTRACT", `binding ${name}: unknown source`);
  }
  return out;
}

export function pointerGet(value: JsonValue, pointer: string): JsonValue {
  if (pointer === "" ) return value;
  if (!pointer.startsWith("/")) throw new BrainDomainError("INVALID_CONTRACT", `invalid JSON pointer ${pointer}`);
  let cur: unknown = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else throw new BrainDomainError("INVALID_CONTRACT", `pointer ${pointer} does not resolve`);
    if (cur === undefined) throw new BrainDomainError("INVALID_CONTRACT", `pointer ${pointer} does not resolve`);
  }
  return cur as JsonValue;
}
