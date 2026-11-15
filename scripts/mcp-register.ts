import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildMcpToolFiles, type McpRegistration } from "../apps/cli/src/mcp";

/**
 * Registers tools of an external MCP server as governed Tool documents in a release directory (ADR 0062).
 *
 *   pnpm exec tsx scripts/mcp-register.ts <release-dir> <server-id> <server-url> --class <tool>=read|write ... [--header Name=secret-name[:prefix]] [--max-output 16384]
 *
 * The server's tool list is read once, by the same pinned client the sandbox runs (list mode), and its digest is written into every Tool
 * document. A header's value for that one listing comes from the environment variable BRAIN_MCP_LIST_<NAME> (upper case, - as _); only the
 * secret's name is written to the release. Every tool needs a declared effect class: nothing is inferred from the server.
 */
const args = process.argv.slice(2);
const [releaseDir, serverId, url] = args;
if (!releaseDir || !serverId || !url) throw new Error("Usage: mcp-register.ts <release-dir> <server-id> <server-url> --class <tool>=read|write ... [--header Name=secret-name[:prefix]] [--max-output bytes]");
const classes: Record<string, string> = {};
const headers: Record<string, { secretRef: string; prefix?: string }> = {};
let maxOutputBytes: number | undefined;
for (let index = 3; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1] ?? "";
  if (flag === "--class") { const [name, effectClass] = value.split("="); classes[name ?? ""] = effectClass ?? ""; }
  else if (flag === "--header") { const [name, rest = ""] = value.split("="); const cut = rest.indexOf(":"); headers[name ?? ""] = cut < 0 ? { secretRef: rest } : { secretRef: rest.slice(0, cut), prefix: rest.slice(cut + 1) }; }
  else if (flag === "--max-output") maxOutputBytes = Number(value);
  else throw new Error(`unknown option ${flag}`);
}
const listHeaders: Record<string, string> = {};
for (const [name, ref] of Object.entries(headers)) {
  const value = process.env[`BRAIN_MCP_LIST_${name.toUpperCase().replace(/-/gu, "_")}`];
  if (value) listHeaders[name] = `${ref.prefix ?? ""}${value}`;
}
const scriptPath = join(dirname(new URL(import.meta.url).pathname), "..", "apps/cli/assets/mcp-client.sh");
const listed = spawnSync("bash", [scriptPath], { input: JSON.stringify({ arguments: {}, mcp: { url, tool: "", toolListDigest: "", headers: listHeaders, mode: "list" } }), encoding: "utf8" });
if (listed.status !== 0) throw new Error(`could not list the server's tools: ${(JSON.parse(listed.stdout || "{}") as { error?: string }).error ?? listed.stderr.slice(0, 200)}`);
const registration: McpRegistration = { serverId, url, listing: JSON.parse(listed.stdout) as McpRegistration["listing"], classes, ...(Object.keys(headers).length ? { headers } : {}), ...(maxOutputBytes ? { maxOutputBytes } : {}) };
const { toolIds, files } = buildMcpToolFiles(registration);
for (const file of files) {
  const target = join(releaseDir, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.text, { mode: file.executable ? 0o755 : 0o644 });
  if (file.executable) chmodSync(target, 0o755);
}
console.log(`Registered ${toolIds.length} tool(s) from ${url}, tool list ${registration.listing.toolListDigest}:\n${toolIds.map((id) => `  ${id}`).join("\n")}\nAdd each tool and its document digest to the Agents that may call it, put the server host on the workspace's egress hosts, and compile. A changed tool list is refused at every call until you run this again.`);
