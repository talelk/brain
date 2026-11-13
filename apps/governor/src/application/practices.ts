import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Practice tags (Phase 4): the kinds of work a team does (data, operations, support) that a Play can be tagged with. They ship as
 * configuration next to the starter release, so an operator edits one file; `BRAIN_PRACTICES_FILE` points at another. A practice only
 * labels and groups: it grants nothing and changes no mission.
 */
const schema = z.object({
  minMissions: z.number().int().min(1).max(50),
  practices: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/u).max(64), title: z.string().min(1).max(64), description: z.string().max(400) }).strict()).min(1).max(30),
}).strict();
export type PracticeConfig = z.infer<typeof schema>;

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "../../../../examples/v1/starter-release/practices.json");

export function practiceConfig(env: NodeJS.ProcessEnv = process.env): PracticeConfig {
  const config = schema.parse(JSON.parse(readFileSync(env["BRAIN_PRACTICES_FILE"] ?? SHIPPED, "utf8")));
  if (new Set(config.practices.map((practice) => practice.id)).size !== config.practices.length) throw new Error("practice ids must be unique");
  return config;
}
