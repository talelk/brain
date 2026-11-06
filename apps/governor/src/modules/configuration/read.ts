import type { Agent, JsonValue, Workflow } from "@brain/contracts";
import { domainDigest } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";
import type { Store } from "../../application/store";
import { readReleaseAgentInstructions } from "./tools";

export interface ActiveRelease {
  readonly digest: string;
  readonly manifest: string;
}

/** The single source of the organization's active-release pointer. */
export function activeRelease(store: Store, organizationId: string): ActiveRelease | undefined {
  return store.control.prepare(
    "SELECT r.digest AS digest, r.manifest_json AS manifest FROM active_config a JOIN config_releases r ON r.organization_id=a.organization_id AND r.digest=a.release_digest WHERE a.organization_id=?",
  ).get(organizationId) as ActiveRelease | undefined;
}

interface StoredRelease {
  schemas?: Record<string, JsonValue>;
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow>;
  manifest: { documents: Array<{ id: string; kind: string; digest: string }> };
}

function parseRelease(release: ActiveRelease): StoredRelease {
  return JSON.parse(release.manifest) as StoredRelease;
}

export interface ReleaseDefinitionItem {
  release: { id: string; digest: string };
  configDigest: string;
  definition: JsonValue;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  instructions?: string;
  instructionsDigest?: string;
}

/**
 * agents.* / workflows.* reads: the definitions carried by the active release,
 * with workflow schema refs and agent instruction assets resolved from it.
 */
export function releaseDefinitions(
  store: Store,
  organizationId: string,
  kind: "agents" | "workflows",
  resourceId?: string,
): JsonValue {
  const release = activeRelease(store, organizationId);
  if (!release) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "activate a configuration release first");
  const stored = parseRelease(release);
  const isAgent = kind === "agents";
  const entries = Object.values(isAgent ? stored.agents ?? {} : stored.workflows ?? {})
    .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
  const items: ReleaseDefinitionItem[] = entries.map((definition) => {
    const id = definition.metadata.id;
    const document = stored.manifest.documents.find((doc) => doc.kind === (isAgent ? "Agent" : "Workflow") && doc.id === id)!;
    const asset = isAgent ? readReleaseAgentInstructions(store, organizationId, release.digest, id) : undefined;
    const workflow = definition as Workflow;
    return {
      release: { id, digest: document.digest },
      configDigest: release.digest,
      definition: definition as unknown as JsonValue,
      ...(!isAgent
        ? {
            inputSchema: stored.schemas?.[workflow.spec.inputSchemaRef] ?? null,
            outputSchema: stored.schemas?.[workflow.spec.outputSchemaRef] ?? null,
          }
        : {}),
      ...(asset ? { instructions: new TextDecoder().decode(asset.bytes), instructionsDigest: asset.instructionsDigest } : {}),
    };
  });
  if (resourceId === undefined) return { items } as unknown as JsonValue;
  const item = items.find((entry) => entry.release.id === resourceId);
  if (!item) throw new BrainDomainError("NOT_FOUND", "definition not found in the active release");
  return item as unknown as JsonValue;
}

/** Guard: the active release must carry the current manifest shape. */
export function assertCurrentManifestShape(release: ActiveRelease): void {
  const m = (parseRelease(release) as unknown as { manifest?: Record<string, unknown> }).manifest ?? {};
  if (!m["irArtifact"] || !m["assets"] || !m["primitiveVersions"] || !m["compilerDigest"]) {
    throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "active release predates the current manifest shape; restage the release");
  }
}

/** config.explain: one JSON-pointer into the active release manifest with its source rule. */
export function configExplain(store: Store, organizationId: string, pointer: string): JsonValue {
  const rel = activeRelease(store, organizationId);
  if (!rel) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "config explain requires an active release");
  const stored = JSON.parse(rel.manifest) as Record<string, unknown>;
  const segments = pointer.split("/").filter(Boolean).map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let effective: unknown = stored;
  for (const seg of segments) {
    effective = (effective as Record<string, unknown> | undefined)?.[seg];
    if (effective === undefined) break;
  }
  const docs = ((stored["manifest"] as Record<string, unknown> | undefined)?.["documents"] ?? []) as Array<Record<string, unknown>>;
  const doc = docs.find((d) => segments.includes(String(d["id"])));
  return {
    pointer,
    effective: (effective ?? null) as JsonValue,
    sources: [{ path: doc ? String(doc["path"] ?? "active-release") : "active-release", line: 1, value: (effective ?? null) as JsonValue, rule: effective === undefined ? "absent-in-active-release" : "declared-in-active-release" }],
    configDigest: rel.digest,
  } as unknown as JsonValue;
}

export interface UiFoundation {
  foundation: string;
  foundationManifestDigest: string;
  defaultTheme: string;
  density: string;
  supportedLocales: string[];
  defaultLocale: string;
  enabledChannels: string[];
}

/**
 * Byte-bound to the release's declared BrainConfig document when present;
 * otherwise to the exact builtin defaults being served.
 */
export function uiFoundationFromRelease(release: ActiveRelease | undefined): UiFoundation {
  const stored = release ? (JSON.parse(release.manifest) as { manifest?: Record<string, unknown> }) : undefined;
  const m = stored?.manifest ?? {};
  const declared = (m["ui"] ?? null) as Record<string, unknown> | null;
  const docs = (m["documents"] ?? []) as Array<Record<string, unknown>>;
  const brainConfigDoc = docs.find((d) => d["kind"] === "BrainConfig");
  const defaults = { defaultTheme: "system", density: "compact", supportedLocales: ["en", "fr"], defaultLocale: "en", enabledChannels: ["web"] };
  const served = declared ? {
    defaultTheme: String(declared["defaultTheme"] ?? defaults.defaultTheme),
    density: String(declared["density"] ?? defaults.density),
    supportedLocales: (declared["supportedLocales"] as string[] | undefined) ?? defaults.supportedLocales,
    defaultLocale: String(declared["defaultLocale"] ?? defaults.defaultLocale),
    enabledChannels: (declared["enabledChannels"] as string[] | undefined) ?? defaults.enabledChannels,
  } : defaults;
  return {
    foundation: "newui",
    foundationManifestDigest: typeof declared?.["foundationManifestDigest"] === "string"
      ? String(declared["foundationManifestDigest"])
      : brainConfigDoc ? String(brainConfigDoc["digest"]) : domainDigest("brain:ui-foundation:v1", served as unknown as JsonValue),
    ...served,
  };
}

/** search.global helper: the active release's Agent/Workflow documents as result items. */
export function searchReleaseDocuments(
  store: Store,
  organizationId: string,
  workspaceId: string,
  matches: (value: unknown) => boolean,
  observedAt: string,
): Array<Record<string, JsonValue>> {
  const release = activeRelease(store, organizationId);
  const documents = release ? parseRelease(release).manifest?.documents ?? [] : [];
  const results: Array<Record<string, JsonValue>> = [];
  for (const document of documents) {
    if ((document.kind === "Agent" || document.kind === "Workflow") && (matches(document.id) || matches(document.kind))) {
      results.push({
        category: document.kind === "Agent" ? "agent" : "workflow",
        title: document.id.replaceAll("-", " "),
        reason: `${document.kind} in the active release`,
        resourceId: document.id,
        workspaceId,
        updatedAt: observedAt,
      });
    }
  }
  return results;
}
