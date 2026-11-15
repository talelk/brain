import { readFileSync } from "node:fs";
import { strictSchemaProblem } from "@brain/contracts/validate";

/**
 * Registering an external MCP server's tools as governed Tool documents (ADR 0062). The admin names the server, says which of its tools
 * to register and declares each tool's effect class; nothing is inferred (a server's own hints such as readOnlyHint are not authority).
 * The tool list and its digest come from the pinned client script's own list mode, so one implementation computes the digest at
 * registration and at every call. The result is plain release files: review them, commit them, compile and activate like any Tool.
 */
export interface ListedTool { readonly name: string; readonly description?: string; readonly inputSchema: Record<string, unknown> }
export interface McpRegistration {
  readonly serverId: string;
  readonly url: string;
  readonly listing: { readonly tools: readonly ListedTool[]; readonly toolListDigest: string };
  /** The declared effect class of each tool to register; a tool without one is not registered, and naming one the server lacks is refused. */
  readonly classes: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, { secretRef: string; prefix?: string }>>;
  readonly maxOutputBytes?: number;
}
export interface ReleaseFile { readonly path: string; readonly text: string; readonly executable?: boolean }

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

export function mcpClientScript(): string { return readFileSync(new URL("../assets/mcp-client.sh", import.meta.url), "utf8"); }

export function buildMcpToolFiles(registration: McpRegistration): { toolIds: string[]; files: ReleaseFile[] } {
  const server = slug(registration.serverId);
  if (!server) throw new Error("the server needs a short id (letters and digits)");
  const byName = new Map(registration.listing.tools.map((tool) => [tool.name, tool]));
  const requested = Object.entries(registration.classes);
  if (requested.length === 0) throw new Error("name at least one tool with its effect class, for example --class search=read");
  const toolIds: string[] = [];
  const files: ReleaseFile[] = [];
  for (const [name, effectClass] of requested) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`the server does not list a tool named ${name}; it lists: ${[...byName.keys()].join(", ") || "none"}`);
    if (effectClass !== "read" && effectClass !== "write") throw new Error(`tool ${name} needs a declared effect class, read or write (privileged is not available to external tools); got "${effectClass}"`);
    const id = `mcp.${server}.${slug(name)}`;
    if (id.length > 64) throw new Error(`the tool id ${id} is longer than 64 characters; use a shorter server id`);
    const { $schema: _draft, ...inputSchema } = tool.inputSchema as Record<string, unknown>;
    const problem = strictSchemaProblem(inputSchema);
    if (problem) throw new Error(`tool ${name}: its input schema cannot be used as it is (${problem}); a server whose schema needs keywords strict validation rejects cannot be registered`);
    const base = `mcp-${server}-${slug(name)}`;
    const document = {
      apiVersion: "brain.keyrus/v1", kind: "Tool", metadata: { id, version: "1.0.0" },
      spec: {
        effectClass, inputSchemaRef: `schemas/${base}-input.json`, outputSchemaRef: `schemas/${base}-output.json`,
        requiredCapabilities: ["tool:bash", "tool:python3"], timeoutSeconds: 30, maxOutputBytes: registration.maxOutputBytes ?? 16384,
        allowedEnvironments: ["local"], owner: "team_operations", license: "LicenseRef-Internal",
        description: `${(tool.description ?? name).replace(/\s+/gu, " ").slice(0, 280)} (external MCP tool ${name} on ${new URL(registration.url).host})`,
        entrypoint: "run.sh",
        mcp: { url: registration.url, tool: name, toolListDigest: registration.listing.toolListDigest, ...(registration.headers ? { headers: registration.headers } : {}), ...(registration.maxOutputBytes ? { maxOutputBytes: registration.maxOutputBytes } : {}) },
      },
    };
    const output = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required: ["tool", "text", "truncated"], properties: { tool: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" } } };
    files.push(
      { path: `config/${id}.yaml`, text: `${JSON.stringify(document, null, 2)}\n` },
      { path: `schemas/${base}-input.json`, text: `${JSON.stringify(inputSchema, null, 2)}\n` },
      { path: `schemas/${base}-output.json`, text: `${JSON.stringify(output, null, 2)}\n` },
      { path: `tools/${id}/run.sh`, text: mcpClientScript(), executable: true },
    );
    toolIds.push(id);
  }
  return { toolIds, files };
}
