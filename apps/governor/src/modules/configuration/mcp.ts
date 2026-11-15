import { BrainDomainError } from "../../domain/errors";

/**
 * An external MCP tool is a Tool document with `spec.mcp` (ADR 0064). The block names one tool of one server, the digest of the server's
 * tool list as it was when an admin registered it, and the headers the server needs by reference (secret names, never values). What is
 * declared here is all the runner may do: it reaches the server only through the launcher's sandbox and the egress proxy, for this host.
 */
export interface McpHeaderRef { readonly secretRef: string; readonly prefix?: string }
export interface McpSpec {
  readonly url: string;
  /** The tool's name on the server. */
  readonly tool: string;
  /** sha256 of the canonical tool list the server returned at registration; a different list at call time is refused. */
  readonly toolListDigest: string;
  readonly headers?: Readonly<Record<string, McpHeaderRef>>;
  /** Read results are cut to this many bytes. */
  readonly maxOutputBytes: number;
  /** The one host the sandbox may reach, as an egress entry (`host`, or `host:port` for a non-default port). */
  readonly host: string;
}

export const MCP_DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MCP_MAX_OUTPUT_BYTES = 64 * 1024;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "accept", "mcp-session-id", "transfer-encoding", "connection"]);

/** The egress entry for a server address: lower-case host, plus the port when it is not the scheme's own. */
export function mcpHostOf(rawUrl: string): string {
  const url = new URL(rawUrl);
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return url.port && url.port !== defaultPort ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
}

/**
 * The checked `spec.mcp` of a Tool document. Throws a plain reason for anything that is not an exactly declared, narrow server tool.
 * The effect class is checked by the caller; here it only decides what is allowed (a privileged tool never has a network, ADR 0037).
 */
export function compileMcpSpec(spec: Record<string, unknown>, path: string, effectClass: string): McpSpec {
  const raw = spec["mcp"] as Record<string, unknown> | undefined;
  const fail = (reason: string): never => { throw new BrainDomainError("INVALID_CONTRACT", `${path}: ${reason}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("spec.mcp must be an object");
  if (effectClass === "privileged") fail("an external MCP tool cannot be privileged: a privileged sandbox never has a network (ADR 0037); declare it read or write");
  const unknown = Object.keys(raw).filter((key) => !["url", "tool", "toolListDigest", "headers", "maxOutputBytes"].includes(key));
  if (unknown.length) fail(`spec.mcp does not allow ${unknown.join(", ")}`);
  let url: URL;
  try { url = new URL(String(raw["url"])); } catch { return fail("spec.mcp.url must be an http(s) address"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail("spec.mcp.url must be an http(s) address");
  if (url.username || url.password) fail("spec.mcp.url must not carry credentials; use spec.mcp.headers with a secret reference");
  const host = mcpHostOf(url.toString());
  const [name = "", port] = host.split(":");
  const nameOk = name.length >= 1 && name.length <= 253 && /^[a-z0-9.-]+$/u.test(name) && /^[a-z0-9]/u.test(name) && /[a-z0-9]$/u.test(name) && !/\.\.|\.-|-\./u.test(name) && (port === undefined || /^[0-9]{1,5}$/u.test(port));
  if (!nameOk) fail("spec.mcp.url must name a DNS host or IPv4 address (the egress proxy matches exactly)");
  const tool = raw["tool"];
  if (typeof tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(tool)) fail("spec.mcp.tool must be the tool's name on the server");
  const digest = raw["toolListDigest"];
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) fail("spec.mcp.toolListDigest must be the sha256 of the server's tool list at registration");
  const maxOutputBytes = raw["maxOutputBytes"] === undefined ? MCP_DEFAULT_OUTPUT_BYTES : raw["maxOutputBytes"];
  if (typeof maxOutputBytes !== "number" || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > MCP_MAX_OUTPUT_BYTES) fail(`spec.mcp.maxOutputBytes must be a whole number from 256 to ${MCP_MAX_OUTPUT_BYTES}`);
  const headers: Record<string, McpHeaderRef> = {};
  const rawHeaders = raw["headers"];
  if (rawHeaders !== undefined) {
    if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) fail("spec.mcp.headers must map header names to secret references");
    const entries = Object.entries(rawHeaders as Record<string, unknown>);
    if (entries.length > 8) fail("spec.mcp.headers allows at most 8 headers");
    for (const [name, ref] of entries) {
      const secretRef = (ref as { secretRef?: unknown } | null)?.secretRef;
      const prefix = (ref as { prefix?: unknown } | null)?.prefix;
      if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) fail(`spec.mcp.headers: ${name} is not an allowed header name`);
      if (typeof secretRef !== "string" || !SECRET_NAME.test(secretRef) || secretRef.includes("..")) fail(`spec.mcp.headers.${name}.secretRef must name a runner secret (a value is never written here)`);
      if (prefix !== undefined && (typeof prefix !== "string" || prefix.length > 32 || /[\r\n]/u.test(prefix))) fail(`spec.mcp.headers.${name}.prefix must be short plain text`);
      headers[name] = { secretRef: secretRef as string, ...(typeof prefix === "string" ? { prefix } : {}) };
    }
  }
  return { url: url.toString(), tool: tool as string, toolListDigest: digest as string, ...(Object.keys(headers).length ? { headers } : {}), maxOutputBytes: maxOutputBytes as number, host };
}
