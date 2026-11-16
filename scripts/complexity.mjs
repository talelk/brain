#!/usr/bin/env node
// The complexity budget (docs/architecture.md section 11): counts what the product is made of and fails when a count passes the
// budget written in docs/complexity.json. Raising a budget is a decision made in that file, not here.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf8");
/** The text between the line that opens a block and the line that closes it at the same indentation. */
const block = (text, opening) => {
  const from = text.indexOf(opening);
  if (from < 0) throw new Error(`"${opening}" was not found`);
  return text.slice(from + opening.length, text.indexOf("\n})", from));
};
const entries = (text, opening) => (block(text, opening).match(/^ {2}"?[A-Za-z_.]+"?: /gmu) ?? []).length;

const api = read("packages/contracts/src/api.ts");
const screens = `${root}apps/web/src/screens`;
const counted = new Map(Object.entries({
  tables: (read("apps/governor/src/schema.sql").match(/^CREATE (?:VIRTUAL )?TABLE /gmu) ?? []).length,
  commandsAndQueries: entries(api, "export const commands = table({") + entries(api, "export const queries = table({"),
  glossaryTerms: (read("GLOSSARY.md").match(/^\*\*[^*]+\*\*:/gmu) ?? []).length,
  screens: existsSync(screens) ? readdirSync(screens).filter((name) => name.endsWith(".tsx")).length : 0,
  stepFields: entries(read("packages/contracts/src/files.ts"), "export const StepSpec = z.strictObject({"),
}));
const budget = JSON.parse(read("docs/complexity.json"));
let over = false;
for (const [name, limit] of Object.entries(budget)) {
  const count = counted.get(name);
  if (count === undefined) throw new Error(`docs/complexity.json names "${name}", which this script does not count`);
  const passed = count <= limit;
  over ||= !passed;
  console.log(`${passed ? "ok  " : "OVER"} ${name}: ${count} of ${limit}`);
}
if (over) {
  console.error("The complexity budget is passed: remove something, or raise the budget in docs/complexity.json and say why in the commit.");
  process.exit(1);
}
