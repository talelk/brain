import { z } from "zod";
import { environmentDoc } from "../packages/contracts/src/env";
import { AgentFile, BrainFile, PackFile, PlayFile, ToolFile } from "../packages/contracts/src/files";
import { openApi } from "./openapi";

/** The form of each definition file, by the name of its schema. Rules that tie one field or file to another are the loader's alone. */
const FILES = { brain: BrainFile, agent: AgentFile, tool: ToolFile, play: PlayFile, pack: PackFile } as const;

const schemaFile = (name: string, schema: z.ZodType): string => `${JSON.stringify({ title: `${name}.toml`, ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) }, null, 2)}\n`;

/** The files written from the code, by path from the repository's root. */
export const generatedDocs = (): Record<string, string> => ({
  "docs/environment.md": environmentDoc(),
  "docs/openapi.json": openApi(),
  ...Object.fromEntries(Object.entries(FILES).map(([name, schema]) => [`docs/schemas/${name}.schema.json`, schemaFile(name, schema)])),
});
