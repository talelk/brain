import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig, readMetricsConfig } from "./config";
import { createServer } from "./tools";

try {
  const server = createServer(readConfig(process.env), process.env.BRAIN_MCP_READONLY === "1", readMetricsConfig(process.env));
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`brain-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
