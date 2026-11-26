/** `pnpm docs:gen`: writes the pages that are made from the code (docs/architecture.md section 1). `tests/unit/generated-docs.test.ts` fails when one is out of date. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatedDocs } from "./generated-docs";

for (const [path, text] of Object.entries(generatedDocs())) writeFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), text);
