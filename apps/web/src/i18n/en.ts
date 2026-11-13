import { enCore } from "./en-core";
import { enExtra } from "./en-extra";

/** Every English message: the source of truth for keys and placeholders. The app reads the core at start and the extras with the screens that need them. */
export const en = { ...enCore, ...enExtra } as const satisfies Record<string, string>;
