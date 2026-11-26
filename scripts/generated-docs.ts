import { z } from "zod";
import { environmentDoc } from "../packages/contracts/src/env";
import { AgentFile, BrainFile, PlayFile, ToolFile } from "../packages/contracts/src/files";
import { PACK_NAMESPACE } from "../packages/contracts/src/packs";
import { PackExtension } from "../packages/contracts/src/plugin";
import { openApi } from "./openapi";

/** The form of each definition file, by the name of its schema. Rules that tie one field or file to another are the loader's alone. */
const FILES = { brain: BrainFile, agent: AgentFile, tool: ToolFile, play: PlayFile } as const;

const schemaFile = (title: string, schema: z.ZodType): string => `${JSON.stringify({ title, ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) }, null, 2)}\n`;

/** The files written from the code, by path from the repository's root. */
export const generatedDocs = (): Record<string, string> => ({
  "docs/environment.md": environmentDoc(),
  "docs/openapi.json": openApi(),
  ...Object.fromEntries(Object.entries(FILES).map(([name, schema]) => [`docs/schemas/${name}.schema.json`, schemaFile(`${name}.toml`, schema)])),
  // The rest of `plugin.json` is the Agent Plugins format, which publishes its own schema.
  "docs/schemas/pack.schema.json": schemaFile(`plugin.json extensions.${PACK_NAMESPACE}`, PackExtension),
});
