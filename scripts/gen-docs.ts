/** `pnpm docs:gen`: writes the pages that are made from the code (docs/architecture.md section 1). `tests/unit/generated-docs.test.ts` fails when one is out of date. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedDocs } from "./generated-docs";

for (const [path, text] of Object.entries(generatedDocs())) {
  const file = fileURLToPath(new URL(`../${path}`, import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
