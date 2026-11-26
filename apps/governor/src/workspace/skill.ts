import { parse as parseYaml } from "yaml";

/**
 * A skill as the Agent Skills format writes it (agentskills.io/specification): a folder whose `SKILL.md` starts with YAML frontmatter that
 * names it and says what it is for. Fields Brain does not use are another tool's business and are left alone.
 */
export function readSkill(folder: string, text: string): { readonly description: string } | { readonly problem: string } {
  const found = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/u.exec(text);
  if (!found) return { problem: "a SKILL.md starts with its frontmatter: a line ---, the fields name and description, a line ---" };
  let fields: unknown;
  try { fields = parseYaml(found[1] as string); } catch (e) { return { problem: `the frontmatter is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` }; }
  const { name, description } = (fields ?? {}) as { name?: unknown; description?: unknown };
  if (name !== folder) return { problem: `name must be the folder's name, ${folder}` };
  if (typeof description !== "string" || description.trim() === "" || description.length > 1024) return { problem: "description says what the skill is for, in 1 to 1024 characters" };
  return { description: description.trim() };
}
