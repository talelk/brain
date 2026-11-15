// Stdio side of the broker bridge (ADR 0035): an ACP agent starts this as its MCP server and it only pipes each JSON-RPC line to the
// runner's loopback endpoint (BRAIN_MCP_URL, bearer BRAIN_MCP_TOKEN) and writes the answer back. It holds no tools and decides nothing.
import { createInterface } from "node:readline";

const url = process.env.BRAIN_MCP_URL;
const token = process.env.BRAIN_MCP_TOKEN;
if (!url || !token) { process.stderr.write("BRAIN_MCP_URL and BRAIN_MCP_TOKEN are required\n"); process.exit(2); }

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    try {
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: line });
      const text = await response.text();
      if (text) process.stdout.write(`${text}\n`);
    } catch (error) {
      let id = null;
      try { id = JSON.parse(line).id ?? null; } catch { /* not JSON */ }
      if (id !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error?.message ?? error) } })}\n`);
    }
  });
});
