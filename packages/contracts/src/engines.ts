/** The engines of an agent and the model APIs they speak (docs/architecture.md, section 6): what the Governor places by and the runner picks by. */

export const MODEL_PROVIDERS = ["openai-compatible", "anthropic"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The one model API each engine speaks. An engine that is not here (the fixture, which calls no model) is not held to one. */
const ENGINE_APIS: Readonly<Record<string, ModelProvider>> = { pi: "openai-compatible", claude: "anthropic", opencode: "openai-compatible", codex: "openai-compatible" };

/** Every engine Brain knows besides the fixture. */
export const ENGINE_NAMES: readonly string[] = Object.keys(ENGINE_APIS);
/** The engines the shipped engine sandbox image carries (`deploy/engine-sandbox.Dockerfile`): what an agent is offered and given when nothing says otherwise. */
export const BUNDLED_ENGINES = ["pi", "claude"] as const;

/** Whether an engine can call one of these model routes. */
export const speaks = (engine: string, routes: readonly { readonly provider: ModelProvider }[]): boolean => routeOf(engine, routes) !== undefined || ENGINE_APIS[engine] === undefined;

/** The route an engine calls: the first of the API it speaks, or the first of all when it is held to none. */
export const routeOf = <R extends { readonly provider: ModelProvider }>(engine: string, routes: readonly R[]): R | undefined => {
  const api = ENGINE_APIS[engine];
  return api === undefined ? routes[0] : routes.find((route) => route.provider === api);
};
