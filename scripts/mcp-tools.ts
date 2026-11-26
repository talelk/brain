/**
 * `pnpm brain mcp-tools <url>`: asks an MCP server for its tools and writes one folder for each into a local folder, in the form a
 * workspace holds an external tool (docs/model.md, "A tool"). Each starts `privileged`, which waits for a person: what a server says of its
 * own tools is not trusted. The folders are then checked (`pnpm brain check`) and added through the app like any edit.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isSlug, slugify } from "../packages/contracts/src/slug";

export interface ToolImport { readonly url: string; /** The first part of each tool's name, and the secret's name when a token is needed. */ readonly system: string; readonly out: string; readonly token?: string }

const toml = (value: string): string => JSON.stringify(value);
const MOST_DESCRIPTION = 4000;

/** Writes `<out>/tools/<system>.<verb>/` for every tool the server lists; answers the names written. Nothing that exists is written over. */
export async function writeMcpTools(source: ToolImport): Promise<string[]> {
  if (!isSlug(source.system)) throw new Error(`the system is lower-case letters, digits and dashes, starting with a letter: ${source.system}`);
  const address = new URL(source.url);
  const client = new Client({ name: "brain", version: "1" });
  const transport = new StreamableHTTPClientTransport(address, source.token ? { requestInit: { headers: { authorization: `Bearer ${source.token}` } } } : {});
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  try {
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 200);
    const taken = new Set<string>();
    return tools.map((tool) => {
      const verb = slugify(tool.name) || "tool";
      let name = `${source.system}.${verb}`;
      for (let n = 2; taken.has(name); n += 1) name = `${source.system}.${verb}-${n}`;
      taken.add(name);
      const folder = join(source.out, "tools", name);
      if (existsSync(folder)) throw new Error(`${folder} already exists; nothing is written over`);
      mkdirSync(folder, { recursive: true });
      const description = (tool.description ?? "").trim().slice(0, MOST_DESCRIPTION) || `The tool ${tool.name} of ${address.host}.`;
      writeFileSync(join(folder, "tool.toml"), [
        `description = ${toml(description)}`, 'effect = "privileged"', "timeout_seconds = 60", `network = [${toml(address.host.toLowerCase())}]`,
        ...(source.token ? [`secrets = [${toml(source.system)}]`] : []), "", "[mcp]", `url = ${toml(source.url)}`, `tool = ${toml(tool.name)}`, "",
      ].join("\n"));
      writeFileSync(join(folder, "input.schema.json"), `${JSON.stringify(tool.inputSchema, null, 2)}\n`);
      if (tool.outputSchema) writeFileSync(join(folder, "output.schema.json"), `${JSON.stringify(tool.outputSchema, null, 2)}\n`);
      return name;
    });
  } finally {
    await client.close();
  }
}
