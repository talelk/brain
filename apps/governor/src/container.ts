export interface GovernorHandle {
  listen(): Promise<void>;
  close(): Promise<void>;
  fetch: (request: Request) => Promise<Response> | Response;
}

export async function createGovernor(): Promise<GovernorHandle> {
  const { createApp } = await import("./http/app");
  const app = await createApp();
  return app;
}
