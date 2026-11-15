import type { JsonValue } from "@brain/contracts";
import { readSecretFile, secretsDir } from "./secrets";

/**
 * External MCP tools on the runner (ADR 0064). The runner never speaks to the MCP server: the pinned client script does, inside a launcher
 * sandbox whose only network is the egress proxy's grant for the one declared host. Here the runner only turns the release's declaration
 * into that sandbox's request and the script's stdin, resolving header secrets by reference.
 */
export interface McpDeclaration {
  readonly url: string;
  readonly tool: string;
  readonly toolListDigest: string;
  readonly headers?: Readonly<Record<string, { secretRef: string; prefix?: string }>>;
  readonly maxOutputBytes: number;
  /** The egress entry of the server: the only host the sandbox may reach. */
  readonly host: string;
}

export interface McpCall {
  /** The one host the sandbox is granted. */
  readonly host: string;
  /** The script's `mcp` stdin key; holds resolved header values, so it is never logged or put in an event. */
  readonly stdinKey: JsonValue;
  /** Every secret value that went into the call, scrubbed from all output. */
  readonly secretValues: readonly string[];
  readonly maxOutputBytes: number;
}

/**
 * The call a pinned declaration allows, or the plain reason it cannot run here: the workspace's egress list must name the server host
 * (the owner vouches for hosts, ADR 0037) and every header secret must exist in the runner's store for this workspace.
 */
export function prepareMcpCall(declaration: McpDeclaration, workspaceId: string | undefined, egressHosts: readonly string[] | undefined): { ok: true; call: McpCall } | { ok: false; error: string } {
  if (!(egressHosts ?? []).map((host) => host.toLowerCase()).includes(declaration.host)) {
    return { ok: false, error: `the server host ${declaration.host} is not on this workspace's egress hosts; the owner adds it under the workspace's effect settings before ${declaration.tool} can run` };
  }
  const headers: Record<string, string> = {};
  const secretValues: string[] = [];
  const refs = Object.entries(declaration.headers ?? {});
  if (refs.length > 0) {
    const root = secretsDir();
    if (!root) return { ok: false, error: "no runner secret store is configured for this tool's headers" };
    if (!workspaceId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(workspaceId)) return { ok: false, error: "header secrets need a workspace scope" };
    for (const [name, ref] of refs) {
      const read = readSecretFile(root, workspaceId, ref.secretRef);
      if (!read.ok) return { ok: false, error: read.error };
      headers[name] = `${ref.prefix ?? ""}${read.value}`;
      secretValues.push(read.value, headers[name]!);
    }
  }
  return {
    ok: true,
    call: { host: declaration.host, secretValues, maxOutputBytes: declaration.maxOutputBytes,
      stdinKey: { url: declaration.url, tool: declaration.tool, toolListDigest: declaration.toolListDigest, headers, maxOutputBytes: declaration.maxOutputBytes, mode: "call" } },
  };
}
