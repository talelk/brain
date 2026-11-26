import { environmentDoc } from "../packages/contracts/src/env";

/** The files written from the code, by path from the repository's root. */
export const generatedDocs = (): Record<string, string> => ({ "docs/environment.md": environmentDoc() });
